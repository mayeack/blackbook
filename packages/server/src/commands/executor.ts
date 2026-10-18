/**
 * THE two-way texting executor (PLAN "Two-way texting", intelligence §6, critic resolutions). The iMessage tail
 * stages self-thread rows as inbound_commands (pending; bot rows, links, balloons, rows older than 6 h or than the
 * cursor's creation are never staged). Each pass here, for each pending row in send order:
 *
 *   1. crash guard: a row whose effect record is still 'started' was interrupted → error, never re-run;
 *   2. stale: older than 6 h when processed → 'seen_late' (one "seen late" reply if it was a command);
 *   3. an open "Sam R. or Sam K.? reply 1/2" clarification takes a bare number / name / "cancel" first;
 *   4. gating — `?…` and `log:` always; commands (and bare numbers) when a digest went out in the last 36 h, a
 *      bot message in the last 12 h, as an inline reply to a bot row, or with a "yb" prefix; other free text only
 *      within 12 h of a bot message, inline, or with "yb" (his own notes to self are never read as commands);
 *   5. limits: ≤30 commands/h (one "slow down" notice), outbound circuit breaker >20/h (effects still apply);
 *   6. execute: deterministic grammar first; free text through the LLM intent parser (route 'intent', egress),
 *      deterministic fallback; item verbs through THE suggestion feedback entry point; `log:` writes a journaled
 *      note + interaction (+ facts from the parser); `?` asks the shared Ask engine; `undo` reverts the last
 *      acknowledged command's effect only (no cascade);
 *   7. one reply per command, "🅨 ✓ …", to self only (OutboundSender), quiet hours don't apply; the clientRef is
 *      derived from the command id, so a retry never texts twice.
 * Tapbacks on bot rows are recorded as "seen" feedback only. Everything that changes data is journaled
 * (undoable from Today) in one 'command' run per command.
 */
import { localParts, type SuggestionFeedback } from '@yb/shared';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { canonicalId } from '../db/canon';
import type { DB } from '../db/connection';
import { MAX_ANSWER_CHARS, type OutboundSender } from '../delivery/types';
import { finishRun, startRun } from '../journal/runs';
import { nullLogger, type Logger } from '../ops/logger';
import type { FeedbackContext } from '../pipeline/suggestions/feedback';
import { resolveServices, type AgentServices, type ServicesConfig, type ServicesProvider } from '../services';
import { settingsSnapshot, writeSettings, type SettingsSnapshot } from '../settings/registry';
import { answerOverImessage } from './ask';
import {
  COMMAND_STALE_MS,
  digestItems,
  kindLabel,
  loadContext,
  loadMessage,
  moreCandidates,
  OPEN_STATUSES,
  type CommandContext,
  type DigestRef,
  type ItemRow,
  type MessageInfo,
} from './context';
import { draftOpeners } from './draft';
import { safeWhy, sendFeedback, undoLastCommandEffect } from './feedback';
import { ITEM_VERBS, parseCommand, selectionNums, type Clause, type Parsed } from './grammar';
import { parseIntent, type IntentResult, type LogKind } from './intent';
import { applyLog, deterministicKind, logKindTitle, type LogFact } from './log';
import { distinctLabels, findMentions, intentCandidates, labelOf, loadPeople, resolveSurface, type PersonLite } from './people';
import { recordSeenReactions } from './seen';
import {
  closeClarification,
  commandLimitReached,
  createClarification,
  effectState,
  expireClarifications,
  finishCommand,
  finishEffect,
  markAcked,
  openClarification,
  outboundCircuitOpen,
  pendingCommands,
  rateNoticeSent,
  recordReply,
  setCommandStatus,
  snapshotSuggestion,
  startEffect,
  unsentReplies,
  type ClarificationRow,
  type ClarifyOption,
  type ClarifyPayload,
  type CommandParsed,
  type CommandStatus,
  type EffectKind,
  type PendingCommand,
  type SuggestionSnapshot,
} from './state';
import { finalizeReply, formatDay, HELP_TEXT, listJoin, relativeDay, scrub, stableRef, truncate } from './text';
import { logTimeFromDate, resolveLogTime, resolveUntil } from './time';

const MAX_PER_PASS = 10;
const MAX_MORE = 3;
const CANCEL = new Set(['cancel', 'no', 'none', 'neither', 'nevermind', 'never mind', 'nvm', 'stop', 'no one', 'nobody', 'skip it']);

export interface CommandsOptions {
  services?: ServicesProvider;
  config?: ServicesConfig;
  log?: Logger;
  now?: () => number;
  signal?: AbortSignal;
  maxPerPass?: number;
  jobRunId?: number | null;
}

export interface CommandsStats {
  pending: number;
  handled: number;
  ignored: number;
  seen_late: number;
  clarifying: number;
  errors: number;
  rate_limited: number;
  replies: number;
  replies_failed: number;
  llm_intents: number;
  seen_reactions: number;
  clarifications_expired: number;
  replies_recovered: number;
}

const emptyStats = (): CommandsStats => ({
  pending: 0,
  handled: 0,
  ignored: 0,
  seen_late: 0,
  clarifying: 0,
  errors: 0,
  rate_limited: 0,
  replies: 0,
  replies_failed: 0,
  llm_intents: 0,
  seen_reactions: 0,
  clarifications_expired: 0,
  replies_recovered: 0,
});

/** Whether a pass has anything to do (cheap; the 10 s job checks it first). */
export function commandsWork(db: DB, now: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM inbound_commands WHERE status = 'pending' LIMIT 1`).get() !== undefined ||
    db.prepare(`SELECT 1 FROM command_clarifications WHERE status = 'open' AND expires_at <= ? LIMIT 1`).get(now) !== undefined ||
    // Recent bot rows first (msg_time index), then their reactions (react_msg): cheap every 10 s.
    db
      .prepare(
        `SELECT 1 FROM messages m JOIN message_reactions r ON r.message_id = m.id JOIN conversations c ON c.id = m.conversation_id
         WHERE m.sent_at > ? AND m.is_bot = 1 AND c.kind = 'self' AND r.is_from_me = 1 AND r.removed = 0
           AND NOT EXISTS (SELECT 1 FROM command_seen_reactions sr WHERE sr.source_reaction_id = r.source_reaction_id) LIMIT 1`,
      )
      .get(now - 36 * 3_600_000) !== undefined ||
    unsentReplies(db, now).length > 0
  );
}

// ---------------------------------------------------------------------------------------------- the pass

/** One pass at a time per database (the 10 s job and an after-ingest hook may both ask). */
const inFlight = new WeakMap<DB, Promise<unknown>>();

export async function processCommands(db: DB, o: CommandsOptions = {}): Promise<CommandsStats> {
  const prev = inFlight.get(db);
  const run = (async () => {
    if (prev) await prev.catch(() => undefined);
    return onePass(db, o);
  })();
  inFlight.set(db, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(db) === run) inFlight.delete(db);
  }
}

async function onePass(db: DB, o: CommandsOptions): Promise<CommandsStats> {
  const clock = o.now ?? (() => Date.now());
  const log = o.log ?? nullLogger;
  const stats = emptyStats();
  const services = resolveServices({ db, services: o.services, config: o.config, log });
  // Modules the executor calls (feedback drafts, Ask) get the very same services.
  const providers: ServicesProvider = o.services ?? (() => services);
  const settings = settingsSnapshot(db);

  stats.clarifications_expired = expireClarifications(db, clock());
  stats.seen_reactions = recordSeenReactions(db, clock());
  for (const r of unsentReplies(db, clock())) {
    const sent = await deliver(db, services.outbound, r.id, r.reply, r.purpose, clock());
    if (sent) stats.replies_recovered++;
  }

  const rows = pendingCommands(db, o.maxPerPass ?? MAX_PER_PASS);
  stats.pending = rows.length;
  if (!settings['commands.enabled']) {
    for (const r of rows) setCommandStatus(db, r.id, 'ignored', clock(), 'disabled');
    stats.ignored += rows.length;
    return stats;
  }
  for (const row of rows) {
    if (o.signal?.aborted) break;
    // Settings are re-read per command: "pause" then "resume" in one pass must see each other.
    const ex = new CommandRun(db, services, settingsSnapshot(db), row, { log, now: clock(), signal: o.signal, providers, jobRunId: o.jobRunId ?? null });
    const status = await ex.run();
    if (status === 'handled') stats.handled++;
    else if (status === 'ignored') stats.ignored++;
    else if (status === 'seen_late') stats.seen_late++;
    else if (status === 'clarifying') stats.clarifying++;
    else if (status === 'error') stats.errors++;
    if (ex.rateLimited) stats.rate_limited++;
    if (ex.usedLlm) stats.llm_intents++;
    if (ex.replyOutcome === 'sent') stats.replies++;
    else if (ex.replyOutcome === 'failed') stats.replies_failed++;
    await yieldLoop(); // keep the 10 s iMessage tail responsive
  }
  return stats;
}

const SENT_OK = new Set(['delivered', 'sent', 'unverified', 'duplicate']);

/** Hands a composed reply to the sender (self only, quiet hours bypassed: it answers his own command). */
async function deliver(db: DB, outbound: OutboundSender, commandId: string, text: string, purpose: 'reply' | 'answer', now: number): Promise<boolean> {
  if (outboundCircuitOpen(db, now)) {
    recordReply(db, commandId, null, 'circuit_open');
    return false;
  }
  let res: Awaited<ReturnType<OutboundSender['sendToSelf']>>;
  try {
    res = await outbound.sendToSelf(text, purpose, stableRef('yb-command-reply', commandId), { bypassQuietHours: true });
  } catch {
    recordReply(db, commandId, null, 'error'); // never retried in a loop; the command itself is done
    return false;
  }
  recordReply(db, commandId, res.outboundId, res.status === 'blocked' ? `blocked:${res.reason ?? 'unknown'}` : res.status);
  if (SENT_OK.has(res.status)) {
    markAcked(db, commandId, now);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------- one command

interface ItemAck {
  verb: 'done' | 'snooze' | 'skip' | 'wrong';
  ordinals: number[];
  names: string[];
  until?: number;
}

interface Exec {
  lines: string[];
  acks: ItemAck[];
  effect: EffectKind;
  batchIds: string[];
  snapshots: SuggestionSnapshot[];
  /** Short line for "Undid: …". */
  summaries: string[];
  status: CommandStatus;
  purpose: 'reply' | 'answer';
  digestId: string | null;
  clarificationId?: string;
}

class CommandRun {
  rateLimited = false;
  usedLlm = false;
  replyOutcome: 'sent' | 'failed' | 'none' = 'none';
  private runId: string | null = null;
  private readonly tz: string;
  private readonly log: Logger;
  private readonly now: number;
  private people: PersonLite[] | null = null;
  private parsedMeta: CommandParsed;

  constructor(
    private readonly db: DB,
    private readonly services: AgentServices,
    private readonly settings: SettingsSnapshot,
    private readonly cmd: PendingCommand,
    private readonly o: { log: Logger; now: number; signal?: AbortSignal; providers: ServicesProvider; jobRunId: number | null },
  ) {
    this.tz = settings.tz;
    this.log = o.log;
    this.now = o.now;
    this.parsedMeta = { v: 1, kind: 'empty', verbs: [], yb: false };
  }

  async run(): Promise<CommandStatus> {
    const { db, cmd } = this;
    const prior = effectState(db, cmd.id);
    if (prior) {
      // Interrupted mid-command (crash/restart): never re-run an effect that may have half-applied.
      return this.finish('error', { reason: 'interrupted', reply: 'Something went wrong with a command · check yeackbot.com/today' });
    }
    const msg = loadMessage(db, cmd.message_id);
    if (!msg) return this.finish('error', { reason: 'no_message' });
    const parsed = parseCommand(cmd.raw_text);
    this.parsedMeta = { v: 1, kind: parsed.kind, verbs: parsed.clauses.map((c) => c.verb), yb: parsed.yb };
    const ctx = loadContext(db, msg);

    if (this.now - msg.sentAt > COMMAND_STALE_MS) {
      const wasCommand = parsed.kind === 'commands' && this.accepted(parsed, ctx);
      const at = new Intl.DateTimeFormat('en-US', { timeZone: this.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(msg.sentAt));
      return this.finish(wasCommand ? 'seen_late' : 'ignored', {
        reason: 'stale',
        reply: wasCommand ? `Seen late (sent ${at}) · didn't act on it · send it again if you still want it` : null,
      });
    }

    const clar = openClarification(db, msg.sentAt);
    const answer = clar ? clarificationAnswer(parsed, clar) : null;
    if (clar && answer) return this.guarded(() => this.answerClarification(clar, answer, msg));

    if (!this.accepted(parsed, ctx)) return this.finish('ignored', { reason: parsed.kind === 'empty' ? 'empty' : 'not_addressed' });
    if (commandLimitReached(db, this.now)) {
      this.rateLimited = true;
      const notice = rateNoticeSent(db, this.now) ? null : "That's 30 commands this hour · I'll pick up again within the hour";
      return this.finish('ignored', { reason: 'rate_limited', reply: notice });
    }
    return this.guarded(() => this.execute(parsed, ctx, msg));
  }

  /** PLAN gating (see the header). */
  private accepted(p: Parsed, ctx: CommandContext): boolean {
    if (p.kind === 'empty') return false;
    if (p.alwaysAccepted || p.yb || ctx.inline.toBot) return true;
    if (p.kind === 'commands') return ctx.latestDigest !== null || ctx.recentBot;
    return ctx.recentBot;
  }

  private async guarded(fn: () => Promise<Exec>): Promise<CommandStatus> {
    startEffect(this.db, this.cmd.id, this.now);
    let ex: Exec;
    try {
      ex = await fn();
    } catch (e) {
      this.log.error('commands.failed', { error_class: e instanceof Error ? e.name : 'unknown', ids: [this.cmd.id] });
      if (this.runId) finishRun(this.db, this.runId, 'error', { now: this.now });
      finishEffect(this.db, this.cmd.id, { state: 'failed', effect: 'none', runId: this.runId, batchIds: [], suggestions: [], summary: null, now: this.now });
      return this.finish('error', { reason: 'exception', reply: 'Something went wrong with that · check yeackbot.com/today' });
    }
    if (this.runId) finishRun(this.db, this.runId, 'ok', { now: this.now, summary: { batches: ex.batchIds.length } });
    const summary = ex.summaries.length ? truncate(ex.summaries.join(' · '), 160) : null;
    finishEffect(this.db, this.cmd.id, {
      state: 'done',
      effect: ex.effect,
      runId: this.runId,
      batchIds: ex.batchIds,
      suggestions: ex.snapshots,
      summary,
      now: this.now,
    });
    const reply = composeReply(ex, this.tz, ex.effect !== 'none');
    return this.finish(ex.status, {
      reply,
      purpose: ex.purpose,
      digestId: ex.digestId,
      batchId: ex.batchIds[0] ?? null,
      clarificationId: ex.clarificationId,
    });
  }

  private async finish(
    status: CommandStatus,
    o: { reason?: string; reply?: string | null; purpose?: 'reply' | 'answer'; digestId?: string | null; batchId?: string | null; clarificationId?: string },
  ): Promise<CommandStatus> {
    const max = o.purpose === 'answer' ? MAX_ANSWER_CHARS : undefined;
    const text = o.reply ? finalizeReply(o.reply, max) : null;
    const parsed: CommandParsed = {
      ...this.parsedMeta,
      ...(o.reason ? { reason: o.reason } : {}),
      reply: text,
      replyPurpose: o.purpose ?? 'reply',
      replyStatus: text ? null : o.reply ? 'unsafe' : null,
      llm: this.usedLlm,
      ...(o.clarificationId ? { clarificationId: o.clarificationId } : {}),
    };
    finishCommand(this.db, this.cmd.id, {
      status,
      now: this.now,
      parsed,
      intent: this.parsedMeta.verbs.length ? this.parsedMeta.verbs.join('+') : this.parsedMeta.kind,
      digestId: o.digestId ?? null,
      batchId: o.batchId ?? null,
    });
    if (text) {
      const ok = await deliver(this.db, this.services.outbound, this.cmd.id, text, o.purpose ?? 'reply', this.now);
      this.replyOutcome = ok ? 'sent' : 'failed';
    }
    return status;
  }

  private ensureRun(): string {
    this.runId ??= startRun(this.db, 'command', { now: this.now, jobRunId: this.o.jobRunId });
    return this.runId;
  }

  /**
   * The intent parser, unless the text is off limits for the model: the self thread is an excluded conversation,
   * or the text names someone on the Privacy → LLM exclusion list (then the deterministic path answers).
   */
  private async intentFor(text: string, msg: MessageInfo, addressed: boolean): Promise<IntentResult | null> {
    const people = this.loadPeopleOnce();
    const excludedPeople = new Set(this.settings['llm.excluded_person_ids']);
    if (this.settings['llm.excluded_conversation_ids'].includes(msg.conversationId)) return null;
    if (excludedPeople.size && findMentions(text, people).some((m) => m.candidates.some((c) => excludedPeople.has(c.id)))) return null;
    const candidates = intentCandidates(text, people.filter((p) => !excludedPeople.has(p.id)));
    const r = await parseIntent(
      { llm: this.services.llm, egress: this.services.egress, timeZone: this.tz, log: this.log, signal: this.o.signal },
      { commandId: this.cmd.id, text, sentAt: msg.sentAt, candidates, addressed },
    );
    if (r) this.usedLlm = true;
    return r;
  }

  private loadPeopleOnce(): PersonLite[] {
    this.people ??= loadPeople(this.db);
    return this.people;
  }

  private blank(digestId: string | null = null): Exec {
    return { lines: [], acks: [], effect: 'none', batchIds: [], snapshots: [], summaries: [], status: 'handled', purpose: 'reply', digestId };
  }

  // ------------------------------------------------------------------------------------------ dispatch

  private async execute(parsed: Parsed, ctx: CommandContext, msg: MessageInfo): Promise<Exec> {
    const digest = ctx.inline.digest ?? ctx.latestDigest;
    if (parsed.kind === 'commands') return this.runClauses(parsed.clauses, digest, msg, parsed);
    return this.freeText(parsed, ctx, digest, msg);
  }

  private async runClauses(clauses: Clause[], digest: DigestRef | null, msg: MessageInfo, parsed: Parsed): Promise<Exec> {
    const ex = this.blank(digest?.id ?? null);
    const items = digest ? digestItems(this.db, digest.id) : [];
    for (const c of clauses) {
      if (this.o.signal?.aborted) break;
      if (ITEM_VERBS.has(c.verb)) {
        if (!digest) {
          ex.lines.push('No brief in the last 36 h · numbers refer to the latest brief');
          continue;
        }
        await this.itemClause(c, items, ex, msg);
        continue;
      }
      switch (c.verb) {
        case 'log':
          await this.logText(c.text, msg, ex, null);
          break;
        case 'ask':
          await this.ask(c.question, ex);
          break;
        case 'undo':
          this.undo(c.target, msg, ex);
          break;
        case 'pause':
          this.pause(c.dur, msg, ex);
          break;
        case 'resume':
          this.resume(ex);
          break;
        case 'more':
          this.more(digest, items, ex);
          break;
        case 'help':
          ex.lines.push(HELP_TEXT);
          break;
        case 'status':
          ex.lines.push(this.statusLine());
          break;
      }
    }
    if (parsed.yb && !clauses.length) ex.lines.push(HELP_TEXT);
    return ex;
  }

  private async freeText(parsed: Parsed, ctx: CommandContext, digest: DigestRef | null, msg: MessageInfo): Promise<Exec> {
    const ex = this.blank(digest?.id ?? null);
    const addressed = parsed.yb || ctx.inline.toBot;
    const intent = await this.intentFor(parsed.body, msg, addressed);
    if (intent) {
      this.parsedMeta.verbs = [intent.intent];
      switch (intent.intent) {
        case 'log_interaction':
        case 'add_fact':
          await this.logText(parsed.body, msg, ex, intent);
          return ex;
        case 'question':
          await this.ask(intent.question ?? parsed.body, ex);
          return ex;
        case 'command': {
          const clause = clauseFromIntent(intent);
          if (clause) return this.runClauses([clause], digest, msg, parsed);
          break;
        }
        case 'note':
          // His notes to self stay silent, but text he addressed to the bot always gets a reply.
          if (!addressed) {
            ex.status = 'ignored';
            return ex;
          }
          break;
        case 'unknown':
          break;
      }
      if (addressed) ex.lines.push("Didn't get that · try help");
      else ex.status = 'ignored';
      return ex;
    }
    // No LLM: questions still go to Ask (retrieval-only); anything else only when explicitly addressed.
    if (parsed.looksLikeQuestion) {
      this.parsedMeta.verbs = ['ask'];
      await this.ask(parsed.body, ex);
      return ex;
    }
    if (addressed) ex.lines.push("Didn't get that · try help (without the AI key only commands, log: and ? work)");
    else ex.status = 'ignored';
    return ex;
  }

  // ------------------------------------------------------------------------------------------ item verbs

  private async itemClause(c: Clause, items: ItemRow[], ex: Exec, msg: MessageInfo): Promise<void> {
    const open = items.filter((i) => OPEN_STATUSES.has(i.status));
    const byOrd = new Map(items.map((i) => [i.ordinal, i]));
    const range = items.length ? `1–${Math.max(...items.map((i) => i.ordinal))}` : null;
    let nums: number[];
    if (c.verb === 'why' || c.verb === 'draft') nums = [c.n];
    else if (c.verb === 'done' || c.verb === 'snooze' || c.verb === 'skip' || c.verb === 'wrong') {
      if (c.sel === null) {
        if (open.length !== 1) {
          ex.lines.push(open.length ? `Which one? reply done ${range}` : 'Nothing open in the latest brief');
          return;
        }
        nums = [open[0]!.ordinal];
      } else nums = selectionNums(c.sel, open.map((i) => i.ordinal));
    } else return;
    const missing = nums.filter((n) => !byOrd.has(n));
    if (missing.length) ex.lines.push(`No item ${listJoin(missing.map(String))} in that brief${range ? ` (${range})` : ''}`);
    const targets = nums.map((n) => byOrd.get(n)).filter((i): i is ItemRow => !!i);
    if (!targets.length) return;

    if (c.verb === 'why') return this.why(targets[0]!, ex);
    if (c.verb === 'draft') return this.draft(targets[0]!, ex);

    let until: number | undefined;
    if (c.verb === 'snooze') {
      const u = resolveUntil(c.dur, msg.sentAt, this.tz);
      if (u === null) {
        ex.lines.push(`Didn't get "${truncate(c.dur ?? '', 30)}" · try snooze ${targets[0]!.ordinal} 2w`);
        return;
      }
      until = u;
    }
    const fb: SuggestionFeedback =
      c.verb === 'done'
        ? { action: 'done' }
        : c.verb === 'skip'
          ? { action: 'skip' }
          : c.verb === 'snooze'
            ? { action: 'snooze', until: until! }
            : { action: 'wrong', ...(c.verb === 'wrong' && c.note ? { note: c.note.slice(0, 500) } : {}) };
    const ack: ItemAck = { verb: c.verb as ItemAck['verb'], ordinals: [], names: [], until };
    const notes: string[] = [];
    for (const item of targets) {
      if (!OPEN_STATUSES.has(item.status) && !(c.verb === 'wrong' && item.status !== 'wrong')) {
        notes.push(`${item.ordinal} is already ${item.status === 'dismissed' ? 'skipped' : item.status}`);
        continue;
      }
      const before = snapshotSuggestion(this.db, item.suggestionId);
      const r = await sendFeedback(this.db, item.suggestionId, fb, this.feedbackCtx());
      if (!r.ok) {
        if (r.reason === 'not_available') {
          notes.push('Feedback by text isn’t available yet · use yeackbot.com/today');
          break;
        }
        notes.push(r.reason === 'conflict' ? `${item.ordinal} already changed` : r.reason === 'not_found' ? `${item.ordinal} is gone` : `Couldn't update ${item.ordinal}`);
        continue;
      }
      if (before) ex.snapshots.push({ ...before, after_status: r.result.status });
      if (r.result.batchId) ex.batchIds.push(r.result.batchId);
      ack.ordinals.push(item.ordinal);
      if (!item.sensitive && item.personLabel) ack.names.push(item.personLabel);
    }
    if (ack.ordinals.length) {
      ex.acks.push(ack);
      ex.effect = ex.effect === 'none' || ex.effect === 'feedback' ? 'feedback' : 'mixed';
      ex.summaries.push(ackText(ack, this.tz));
    }
    ex.lines.push(...[...new Set(notes)]);
  }

  /** Feedback joins this command's run when it may write journaled changes (a `wrong` retraction, mutes). */
  private feedbackCtx(writes = true): FeedbackContext {
    return { channel: 'imessage', now: this.now, inboundCommandId: this.cmd.id, runId: writes ? this.ensureRun() : null, services: this.o.providers };
  }

  private async why(item: ItemRow, ex: Exec): Promise<void> {
    if (item.sensitive) {
      ex.lines.push(`Why ${item.ordinal}: something personal · see yeackbot.com/today`);
      return;
    }
    const r = await sendFeedback(this.db, item.suggestionId, { action: 'why' }, this.feedbackCtx(false));
    const why = (r.ok ? r.result.why : null) ?? safeWhy(this.db, item.suggestionId);
    if (!why) {
      ex.lines.push(`Why ${item.ordinal} · ${item.label}: ${kindLabel(item.kind)} · score ${item.score.toFixed(2)} · more at yeackbot.com/today`);
      return;
    }
    const signals = why.signals.slice(0, 4).map((s) => `• ${s.label}: ${s.value}`);
    const learned = why.factors
      .filter((f) => Math.abs(f.value - 1) >= 0.1)
      .slice(0, 2)
      .map((f) => `${f.label} ×${f.value.toFixed(1)}`);
    ex.lines.push(
      [
        `Why ${item.ordinal} · ${item.label}: ${truncate(why.summary, 140)}`,
        ...signals,
        ...(learned.length ? [`Learned: ${learned.join(', ')}`] : []),
        'yeackbot.com/today',
      ].join('\n'),
    );
  }

  private async draft(item: ItemRow, ex: Exec): Promise<void> {
    if (item.sensitive) {
      ex.lines.push(`Drafts for ${item.ordinal}: something personal · see yeackbot.com/today`);
      return;
    }
    if (!this.services.llm.canSpend('steady').ok) {
      ex.lines.push('Drafts need the AI key');
      return;
    }
    const excluded = new Set(this.settings['llm.excluded_person_ids']);
    if ([item.personId, item.relatedPersonId].some((id) => id && excluded.has(canonicalOf(this.db, id)))) {
      ex.lines.push(`No drafts for ${item.label}: kept away from the AI in Privacy settings`);
      return;
    }
    const r = await sendFeedback(this.db, item.suggestionId, { action: 'draft' }, this.feedbackCtx(false));
    let openers = r.ok ? (r.result.openers ?? []) : [];
    if (!openers.length) {
      const s = this.db.prepare('SELECT title, body, openers FROM suggestions WHERE id = ?').get(item.suggestionId) as
        | { title: string | null; body: string | null; openers: string | null }
        | undefined;
      const p = item.personId
        ? (this.db
            .prepare(`SELECT p.id, p.first_name, p.last_name FROM people p WHERE p.id = coalesce((SELECT canonical_id FROM person_canon WHERE person_id = ?), ?)`)
            .get(item.personId, item.personId) as { id: string; first_name: string | null; last_name: string | null } | undefined)
        : undefined;
      openers =
        (await draftOpeners(
          { llm: this.services.llm, egress: this.services.egress, log: this.log, signal: this.o.signal },
          {
            suggestionId: item.suggestionId,
            kind: item.kind,
            title: s?.title ?? null,
            body: s?.body ?? null,
            personId: p?.id ?? null,
            firstName: p?.first_name ?? null,
            lastName: p?.last_name ?? null,
            existing: safeJsonArray(s?.openers),
          },
        )) ?? [];
    }
    const clean = openers.map((x) => truncate(scrub(x), 160)).filter(Boolean).slice(0, 2);
    ex.lines.push(
      clean.length
        ? [`Drafts for ${item.label} (copy them; nothing is sent):`, ...clean.map((x, i) => `${i + 1}) ${x}`)].join('\n')
        : "Couldn't write drafts right now · try again later",
    );
  }

  // ------------------------------------------------------------------------------------------ log

  private async logText(text: string, msg: MessageInfo, ex: Exec, pre: IntentResult | null): Promise<void> {
    const people = this.loadPeopleOnce();
    const intent = pre ?? (await this.intentFor(text, msg, true));
    const visible = new Set(people.map((p) => p.id));
    const resolved: string[] = [];
    const ambiguous: { surface: string; options: PersonLite[] }[] = [];
    const unresolved: string[] = [];
    const llmLog = intent?.log ?? null;
    if (llmLog && llmLog.people.length) {
      for (const p of llmLog.people) {
        if (p.personId && visible.has(p.personId)) {
          resolved.push(p.personId);
          continue;
        }
        const cands = resolveSurface(p.surface, people);
        if (cands.length === 1) resolved.push(cands[0]!.id);
        else if (cands.length > 1) ambiguous.push({ surface: p.surface, options: cands });
        else unresolved.push(p.surface);
      }
    } else {
      for (const m of findMentions(text, people)) {
        if (m.candidates.length === 1) resolved.push(m.candidates[0]!.id);
        else ambiguous.push({ surface: m.surface, options: m.candidates });
      }
    }
    const kind: LogKind = llmLog?.kind ?? deterministicKind(text);
    const when = logTimeFromDate(llmLog?.date ?? null, msg.sentAt, this.tz) ?? resolveLogTime(text, msg.sentAt, this.tz);
    const facts: LogFact[] = (llmLog?.facts ?? []).filter((f) => visible.has(f.personId));
    const payload: ClarifyPayload = {
      text,
      kind,
      at: when.at,
      date: when.date,
      interaction: intent?.intent !== 'add_fact',
      resolved: [...new Set(resolved)],
      surface: '',
      pending: [],
      facts,
      unresolved,
      llm: !!intent,
    };
    if (ambiguous.length) {
      const [first, ...rest] = ambiguous;
      payload.surface = first!.surface;
      payload.pending = rest.map((a) => ({ surface: a.surface, options: optionsFor(a.options) }));
      this.askWhich(first!.surface, optionsFor(first!.options), payload, ex);
      return;
    }
    if (!payload.resolved.length) {
      ex.lines.push(
        unresolved.length
          ? `Couldn't find ${listJoin(unresolved.map((u) => truncate(u, 30)), 'or')} · try log: coffee with Sam R.`
          : "Couldn't tell who that was with · try log: coffee with Sam R.",
      );
      return;
    }
    this.applyLogPlan(payload, msg, ex);
  }

  /** Opens a clarification owned by `owner` (the `log:` that named the people; it stays 'clarifying'). */
  private askWhich(surface: string, options: ClarifyOption[], payload: ClarifyPayload, ex: Exec, owner = this.cmd.id): void {
    const id = createClarification(this.db, owner, options, { ...payload, surface }, this.now);
    const nums = options.length === 2 ? '1/2' : `1–${options.length}`;
    ex.lines.push(`${listJoin(options.map((o) => o.label), 'or')}? reply ${nums}`);
    ex.status = 'clarifying';
    ex.clarificationId = id;
  }

  private applyLogPlan(payload: ClarifyPayload, msg: MessageInfo, ex: Exec): void {
    const people = this.loadPeopleOnce();
    const byId = new Map(people.map((p) => [p.id, p]));
    const names = payload.resolved.map((id) => (byId.get(id) ? labelOf(byId.get(id)!) : null)).filter((n): n is string => !!n);
    const kind = payload.kind as LogKind;
    const plan = {
      text: payload.text,
      kind,
      at: payload.at,
      date: payload.date,
      personIds: payload.resolved,
      interaction: payload.interaction,
      facts: payload.facts.filter((f) => payload.resolved.includes(f.personId)) as LogFact[],
    };
    // add_fact: his words become a note (and facts) on each person, without an interaction.
    const title = payload.interaction ? `Logged ${logKindTitle(kind).toLowerCase()} with ${listJoin(names)} (text)` : `Noted about ${listJoin(names)} (text)`;
    const applied = applyLog(this.db, plan, { runId: this.ensureRun(), now: this.now, messageId: msg.id, title });
    if (applied.batchId) ex.batchIds.push(applied.batchId);
    ex.effect = ex.effect === 'none' || ex.effect === 'log' ? 'log' : 'mixed';
    const day = relativeDay(payload.date, localParts(this.now, this.tz).date, payload.at, this.tz);
    const what = kind === 'other' ? 'note' : logKindTitle(kind).toLowerCase();
    const factBits = applied.facts
      .filter((f) => !f.sensitive)
      .slice(0, 2)
      .map((f) => `“${truncate(f.value, 40)}”`);
    const missing = payload.unresolved.length ? [`couldn't find ${listJoin(payload.unresolved.map((u) => truncate(u, 30)), 'or')}`] : [];
    const head = payload.interaction ? `✓ Logged for ${listJoin(names)}: ${what} ${day}` : `✓ Noted for ${listJoin(names)}`;
    ex.lines.push([head, ...factBits, ...missing].join(' · '));
    ex.summaries.push(payload.interaction ? `log for ${listJoin(names)} (${what} ${day})` : `note for ${listJoin(names)}`);
  }

  private async answerClarification(clar: ClarificationRow, answer: ClarAnswer, msg: MessageInfo): Promise<Exec> {
    this.parsedMeta = { ...this.parsedMeta, kind: 'clarification', verbs: ['clarify'] };
    const ex = this.blank();
    if (answer.cancel) {
      closeClarification(this.db, clar.id, 'cancelled', this.now, this.cmd.id);
      setCommandStatus(this.db, clar.command_id, 'ignored', this.now, 'clarification_cancelled');
      ex.lines.push('✓ Dropped that log');
      return ex;
    }
    const chosen = clar.options[answer.choice!]!;
    const payload: ClarifyPayload = { ...clar.payload, resolved: [...new Set([...clar.payload.resolved, chosen.personId])] };
    closeClarification(this.db, clar.id, 'resolved', this.now, this.cmd.id);
    const [next, ...rest] = payload.pending;
    if (next) {
      // The original `log:` stays 'clarifying'; this answer is handled; ask about the next name.
      this.askWhich(next.surface, next.options, { ...payload, pending: rest }, ex, clar.command_id);
      ex.status = 'handled';
      return ex;
    }
    this.applyLogPlan(payload, msg, ex);
    setCommandStatus(this.db, clar.command_id, 'handled', this.now, 'clarified');
    return ex;
  }

  // ------------------------------------------------------------------------------------------ other verbs

  private async ask(question: string, ex: Exec): Promise<void> {
    const r = await answerOverImessage({ db: this.db, services: this.o.providers, log: this.log, signal: this.o.signal }, question, this.now);
    ex.lines.push(r.text);
    ex.purpose = 'answer';
  }

  private undo(target: string | null, msg: MessageInfo, ex: Exec): void {
    if (target) {
      ex.lines.push('Only your last command can be undone by text · everything else at yeackbot.com/today');
      return;
    }
    const r = undoLastCommandEffect(this.db, { at: msg.sentAt, now: this.now, byCommandId: this.cmd.id });
    if (r.status === 'undone') ex.lines.push(`✓ Undid${r.summary ? `: ${r.summary}` : ' your last command'}`);
    else if (r.status === 'already') ex.lines.push('Already undone · nothing else to undo by text');
    else if (r.status === 'nothing') ex.lines.push('Nothing to undo');
    else ex.lines.push("Can't undo that by text (later changes depend on it) · use yeackbot.com/today");
  }

  private pause(dur: string | null, msg: MessageInfo, ex: Exec): void {
    const until = resolveUntil(dur, msg.sentAt, this.tz);
    if (until === null) {
      ex.lines.push(`Didn't get "${truncate(dur ?? '', 30)}" · try pause 1w`);
      return;
    }
    const r = writeSettings(this.db, { 'digest.paused_until': until }, { actor: 'user', runId: this.ensureRun(), title: 'Paused the brief (text)', now: this.now });
    if (r.batchId) ex.batchIds.push(r.batchId);
    ex.effect = ex.effect === 'none' || ex.effect === 'setting' ? 'setting' : 'mixed';
    const off = this.settings['digest.enabled'] ? '' : ' (the brief is also off in Settings)';
    ex.lines.push(`✓ Brief paused until ${formatDay(until, this.tz, true)}${off} · resume to restart`);
    ex.summaries.push(`pause until ${formatDay(until, this.tz)}`);
  }

  private resume(ex: Exec): void {
    const paused = this.settings['digest.paused_until'];
    if (paused === null || paused <= this.now) {
      ex.lines.push(this.settings['digest.enabled'] ? "The brief isn't paused" : "The brief isn't paused (it's off in Settings)");
      return;
    }
    const r = writeSettings(this.db, { 'digest.paused_until': null }, { actor: 'user', runId: this.ensureRun(), title: 'Resumed the brief (text)', now: this.now });
    if (r.batchId) ex.batchIds.push(r.batchId);
    ex.effect = ex.effect === 'none' || ex.effect === 'setting' ? 'setting' : 'mixed';
    ex.lines.push(`✓ Brief resumed${this.settings['digest.enabled'] ? ` · next one at ${this.settings['digest.time']}` : ' (turn it on in Settings to get it)'}`);
    ex.summaries.push('resume');
  }

  private more(digest: DigestRef | null, items: ItemRow[], ex: Exec): void {
    if (!digest) {
      ex.lines.push('No brief in the last 36 h · see yeackbot.com/today');
      return;
    }
    const extra = moreCandidates(this.db, digest.id, this.now, MAX_MORE, this.settings['learner.muted_kinds']);
    if (!extra.length) {
      ex.lines.push("That's everything for now · yeackbot.com/today");
      return;
    }
    let next = Math.max(0, ...items.map((i) => i.ordinal)) + 1;
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO command_more_items (digest_id, ordinal, suggestion_id, command_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const lines: string[] = [];
    for (const it of extra) {
      if (!ins.run(digest.id, next, it.suggestionId, this.cmd.id, this.now).changes) continue;
      lines.push(`${next} ${it.sensitive ? 'something personal · open the app' : `${it.label} · ${kindLabel(it.kind)}`}`);
      next++;
    }
    ex.lines.push([...lines, `done ${next - lines.length} · skip ${next - 1} · yeackbot.com/today`].join('\n'));
  }

  private statusLine(): string {
    const s = this.settings;
    const paused = s['digest.paused_until'] !== null && s['digest.paused_until'] > this.now;
    const last = this.db.prepare(`SELECT max(sent_at) FROM digests WHERE status IN ('sent','fallback_sent')`).pluck().get() as number | null;
    return [
      `Brief: ${s['digest.enabled'] ? `on at ${s['digest.time']}` : 'off'}${paused ? ` · paused until ${formatDay(s['digest.paused_until']!, this.tz)}` : ''}`,
      `Last sent: ${last ? formatDay(last, this.tz) : 'never'}`,
      `AI: ${this.services.llm.canSpend('steady').ok ? 'on' : 'off'} · commands: on`,
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------------------------- helpers

interface ClarAnswer {
  choice?: number;
  cancel?: boolean;
}

function clarificationAnswer(p: Parsed, clar: ClarificationRow): ClarAnswer | null {
  const body = p.body.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (CANCEL.has(body)) return { cancel: true };
  if (p.bareNumbers?.length === 1) {
    const n = p.bareNumbers[0]!;
    return n >= 1 && n <= clar.options.length ? { choice: n - 1 } : null;
  }
  if (!body || body.length > 40) return null;
  const hits = clar.options.map((o, i) => ({ i, label: o.label.toLowerCase() })).filter((o) => o.label === body || o.label.replace(/\.$/, '') === body);
  return hits.length === 1 ? { choice: hits[0]!.i } : null;
}

function optionsFor(cands: PersonLite[]): ClarifyOption[] {
  const top = cands.slice(0, 3);
  const labels = distinctLabels(top);
  return top.map((p, i) => ({ personId: p.id, label: labels[i]! }));
}

function clauseFromIntent(r: IntentResult): Clause | null {
  const c = r.command;
  if (!c) return null;
  const sel = c.nums.length ? { all: false as const, nums: [...new Set(c.nums)] } : null;
  switch (c.verb) {
    case 'done':
      return { verb: 'done', sel };
    case 'snooze':
      return sel ? { verb: 'snooze', sel, dur: c.dur } : null;
    case 'skip':
      return sel ? { verb: 'skip', sel } : null;
    case 'wrong':
      return sel ? { verb: 'wrong', sel, note: null } : null;
    case 'why':
    case 'draft':
      return sel?.nums.length === 1 ? { verb: c.verb, n: sel.nums[0]! } : null;
    case 'undo':
      return { verb: 'undo', target: null };
    case 'pause':
      return { verb: 'pause', dur: c.dur };
    default:
      return { verb: c.verb };
  }
}

const PAST: Record<ItemAck['verb'], string> = { done: 'done', snooze: 'snoozed', skip: 'skipped', wrong: 'marked wrong' };

function ackText(a: ItemAck, tz: string): string {
  const names = a.names.length && a.names.length <= 2 ? ` (${[...new Set(a.names)].join(', ')})` : '';
  const until = a.verb === 'snooze' && a.until ? ` → ${formatDay(a.until, tz)}` : '';
  return `${a.ordinals.join(', ')} ${PAST[a.verb]}${names}${until}`;
}

/** One reply: grouped item acks first ("✓ 2 done (Priya S.) · 1 snoozed → Oct 28"), then other lines. */
function composeReply(ex: Exec, tz: string, effectful: boolean): string | null {
  const parts: string[] = [];
  if (ex.acks.length) parts.push(`✓ ${ex.acks.map((a) => ackText(a, tz)).join(' · ')}`);
  parts.push(...ex.lines);
  if (!parts.length) return null;
  const body = parts.join('\n');
  return effectful && ex.purpose === 'reply' && ex.status === 'handled' ? `${body} · undo to revert` : body;
}

function canonicalOf(db: DB, personId: string): string {
  try {
    return canonicalId(db, personId);
  } catch {
    return personId;
  }
}

function safeJsonArray(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const _internals = { clarificationAnswer, composeReply, ackText, clauseFromIntent };
