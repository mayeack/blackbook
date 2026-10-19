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
 *   5. limits: ≤30 commands/h (one "slow down" notice), outbound circuit breaker ≥30/h (effects still apply);
 *   6. execute: deterministic grammar first; free text through the LLM intent parser (route 'intent', egress, with
 *      the command's screenshots when Settings allow), deterministic fallback; item verbs through THE suggestion
 *      feedback entry point; `log:` writes a journaled note + interaction (+ facts from the parser); add_fact and
 *      set_preference write notes + facts, and "prioritize inviting X to parties" puts X in the Party invites circle;
 *      "this person" in a screenshot is matched by Instagram username or added as a roster-only person; `?` asks
 *      the shared Ask engine; `undo` reverts the last acknowledged command's effect only (no cascade);
 *   7. one reply per command, "🅨 ✓ …", to self only (OutboundSender), quiet hours don't apply; the clientRef is
 *      derived from the command id, so a retry never texts twice.
 * Tapbacks on bot rows are recorded as "seen" feedback only. Everything that changes data is journaled
 * (undoable from Today) in one 'command' run per command.
 */
import { localParts, type SuggestionFeedback } from '@yb/shared';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { commandImageRefs } from '../adapters/imessage/attachments';
import { canonicalId } from '../db/canon';
import type { DB } from '../db/connection';
import { itemLines, mainLine } from '../delivery/compose';
import { peopleInfo, selectedItemById } from '../delivery/selection';
import { templateCopy } from '../delivery/template';
import { briefNames, clockWords, endSentence } from '../delivery/text';
import { MAX_ANSWER_CHARS, type OutboundSender } from '../delivery/types';
import { ownerNames } from '../identity/ownerNames';
import type { ResolveContext } from '../identity/resolver';
import { withBatch } from '../journal/batch';
import { finishRun, startRun } from '../journal/runs';
import type { LlmImage } from '../llm/types';
import { nullLogger, type Logger } from '../ops/logger';
import { addToPreference, PREFERENCES, type PreferenceKind } from '../pipeline/circles/preferences';
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
import { isImplicitItemClause, ITEM_VERBS, parseCommand, selectionNums, type Clause, type Parsed } from './grammar';
import { parseIntent, type IntentResult, type LogKind } from './intent';
import { applyLog, deterministicKind, logKindTitle, type LogFact } from './log';
import { distinctLabels, findMentions, intentCandidates, labelOf, loadPeople, resolveSurface, type PersonLite } from './people';
import { resolveScreenshotPerson } from './screenshot';
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
import { finalizeReply, formatDay, HELP_TEXT, listJoin, relativeDay, scrub, shortName, stableRef, truncate } from './text';
import { logTimeFromDate, resolveLogTime, resolveUntil } from './time';

const MAX_PER_PASS = 10;
/** `more` texts the next suggestion only (one suggestion per text), looking this far for one that can be shown. */
const MORE_LOOKAHEAD = 3;
/** Why "this person" in a screenshot couldn't be pinned down. */
const SCREENSHOT_PROBLEM = {
  unreadable: "I couldn't tell who that screenshot shows. Send the profile with the @username visible.",
  ambiguous: 'More than one person has that name. Send the profile with the @username visible.',
  service: "That profile is a business or service account, so I didn't note anything.",
} as const;
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

/**
 * Hands a composed reply to the sender (self only, quiet hours bypassed: it answers the owner's own command).
 * `item` binds the reply to a digest item (a `more` suggestion), so an inline "done" to it acts on that item.
 */
async function deliver(
  db: DB,
  outbound: OutboundSender,
  commandId: string,
  text: string,
  purpose: 'reply' | 'answer',
  now: number,
  item: { digestId: string; ordinal: number } | null = null,
): Promise<boolean> {
  if (outboundCircuitOpen(db, now)) {
    recordReply(db, commandId, null, 'circuit_open');
    return false;
  }
  let res: Awaited<ReturnType<OutboundSender['sendToSelf']>>;
  try {
    res = await outbound.sendToSelf(text, purpose, stableRef('yb-command-reply', commandId), {
      bypassQuietHours: true,
      ...(item ? { digestId: item.digestId, digestOrdinal: item.ordinal } : {}),
    });
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
  /** Per ordinal: the person's short name, or null (sensitive / no person). */
  names: (string | null)[];
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
  /** The reply carries one digest item (`more`): inline replies to it act on that item. */
  replyItem?: { digestId: string; ordinal: number };
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
  private images: LlmImage[] | null = null;
  /** Screenshots the command had that didn't reach the parser (setting off, collector down, file not synced yet). */
  private imagesMissed: 'off' | 'unavailable' | null = null;
  /** Labels of people this command touched who aren't in the visible list (a roster-only screenshot person). */
  private readonly extraLabels = new Map<string, string>();
  /** The digest item this command is an inline reply to (its own text), if any. */
  private inlineOrdinal: number | null = null;
  /** An inline reply to a bot text that carries no item (an answer, an ack, the "Heads up" text). */
  private inlineNoItem = false;
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
      return this.finish('error', { reason: 'interrupted', reply: 'Something went wrong with a command. You can check it at yeackbot.com/today' });
    }
    const msg = loadMessage(db, cmd.message_id);
    if (!msg) return this.finish('error', { reason: 'no_message' });
    const parsed = parseCommand(cmd.raw_text);
    this.parsedMeta = { v: 1, kind: parsed.kind, verbs: parsed.clauses.map((c) => c.verb), yb: parsed.yb };
    const ctx = loadContext(db, msg);

    if (this.now - msg.sentAt > COMMAND_STALE_MS) {
      // A number-less skip/snooze/wrong/why/draft that doesn't reply to a suggestion's text is free text (execute()).
      const asFreeText = parsed.kind === 'commands' && ctx.inline.ordinal === null && parsed.clauses.some(isImplicitItemClause);
      const wasCommand = parsed.kind === 'commands' && !asFreeText && this.accepted(parsed, ctx);
      const at = new Intl.DateTimeFormat('en-US', { timeZone: this.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(msg.sentAt));
      return this.finish(wasCommand ? 'seen_late' : 'ignored', {
        reason: 'stale',
        reply: wasCommand ? `I only just saw your text from ${at}, so I didn't act on it.\nSend it again if you still want it.` : null,
      });
    }

    const clar = openClarification(db, msg.sentAt);
    // A reply to one of the brief's suggestion texts is about that suggestion, never an answer to "Which Sam?".
    const answer = clar && ctx.inline.ordinal === null ? clarificationAnswer(parsed, clar) : null;
    if (clar && answer) return this.guarded(() => this.answerClarification(clar, answer, msg));

    if (!this.accepted(parsed, ctx)) return this.finish('ignored', { reason: parsed.kind === 'empty' ? 'empty' : 'not_addressed' });
    if (commandLimitReached(db, this.now)) {
      this.rateLimited = true;
      const notice = rateNoticeSent(db, this.now) ? null : "That's 30 commands this hour, so I'm taking a short break.\nI'll pick up again within the hour.";
      return this.finish('ignored', { reason: 'rate_limited', reply: notice });
    }
    return this.guarded(() => this.execute(parsed, ctx, msg));
  }

  /** PLAN gating (see the header). */
  private accepted(p: Parsed, ctx: CommandContext): boolean {
    if (p.kind === 'empty') return false;
    if (p.alwaysAccepted || p.yb || ctx.inline.toBot) return true;
    // "skip" / "wrong …" / "snooze …" with no number and not a reply to a suggestion: gated like free text, so a
    // note-to-self such as "wrong number lol" is never run as a command.
    if (p.kind === 'commands' && !p.clauses.some(isImplicitItemClause)) return ctx.latestDigest !== null || ctx.recentBot;
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
      return this.finish('error', { reason: 'exception', reply: 'Something went wrong with that. You can check it at yeackbot.com/today' });
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
      replyItem: ex.replyItem,
    });
  }

  private async finish(
    status: CommandStatus,
    o: {
      reason?: string;
      reply?: string | null;
      purpose?: 'reply' | 'answer';
      digestId?: string | null;
      batchId?: string | null;
      clarificationId?: string;
      replyItem?: { digestId: string; ordinal: number };
    },
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
      const ok = await deliver(this.db, this.services.outbound, this.cmd.id, text, o.purpose ?? 'reply', this.now, o.replyItem ?? null);
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
    const images = await this.commandImages(msg);
    const r = await parseIntent(
      { llm: this.services.llm, egress: this.services.egress, timeZone: this.tz, log: this.log, signal: this.o.signal },
      { commandId: this.cmd.id, text, sentAt: msg.sentAt, candidates, addressed, images },
    );
    if (r) this.usedLlm = true;
    return r;
  }

  /**
   * The screenshots this command carries (its own image attachments, else ones sent just before it), fetched once
   * from the collector. None when Settings → "Read screenshots in commands" is off, there is no collector, or the
   * AI can't be used anyway.
   */
  private async commandImages(msg: MessageInfo): Promise<LlmImage[]> {
    if (this.images) return this.images;
    this.images = [];
    const source = this.services.attachments;
    if (!this.services.llm.canSpend('steady').ok) return this.images;
    const refs = commandImageRefs(this.db, msg.id);
    if (!refs.length) return this.images;
    if (!this.settings['commands.read_images'] || !source?.configured) {
      this.imagesMissed = this.settings['commands.read_images'] ? 'unavailable' : 'off';
      return this.images;
    }
    for (const ref of refs) {
      if (this.o.signal?.aborted) break;
      const img = await source.image(ref);
      if (img) this.images.push(img);
    }
    if (this.images.length < refs.length) this.imagesMissed = 'unavailable';
    if (this.images.length) this.parsedMeta.images = this.images.length;
    return this.images;
  }

  /** Who and when for identity writes this command makes (a person added from a screenshot). */
  private resolveCtx(): ResolveContext {
    return { db: this.db, runId: () => this.ensureRun(), now: this.now, source: 'screenshot', actor: 'user' };
  }

  /** "Sam R." for anyone, visible or not (a roster-only screenshot person; a person picked in a clarification). */
  private labelFor(personId: string): string | null {
    const known = this.loadPeopleOnce().find((p) => p.id === personId);
    if (known) return labelOf(known);
    const extra = this.extraLabels.get(personId);
    if (extra) return extra;
    const row = this.db.prepare('SELECT display_name, first_name, last_name FROM people WHERE id = ?').get(personId) as
      | { display_name: string; first_name: string | null; last_name: string | null }
      | undefined;
    return row ? shortName(row) : null;
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
    this.inlineOrdinal = ctx.inline.digest ? ctx.inline.ordinal : null;
    this.inlineNoItem = ctx.inline.toBot && this.inlineOrdinal === null;
    // An item verb without a number only names a suggestion when it replies to that suggestion's text; otherwise
    // ("wrong, she moved to Denver" to an Ask answer, "why?" to an ack) it is free text: intent parser / Ask.
    if (parsed.kind === 'commands' && !(this.inlineOrdinal === null && parsed.clauses.some(isImplicitItemClause))) {
      return this.runClauses(parsed.clauses, digest, msg, parsed);
    }
    return this.freeText(parsed, ctx, digest, msg);
  }

  private async runClauses(clauses: Clause[], digest: DigestRef | null, msg: MessageInfo, parsed: Parsed): Promise<Exec> {
    const ex = this.blank(digest?.id ?? null);
    const items = digest ? digestItems(this.db, digest.id) : [];
    for (const c of clauses) {
      if (this.o.signal?.aborted) break;
      if (ITEM_VERBS.has(c.verb)) {
        if (!digest) {
          ex.lines.push("I haven't sent you a brief in the last day and a half, so there's nothing to match that to.");
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
        case 'set_preference':
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
      if (addressed) ex.lines.push('Sorry, I didn\'t get that. Text "help" to see what I can do.');
      else ex.status = 'ignored';
      return ex;
    }
    // No LLM: questions still go to Ask (retrieval-only); anything else only when explicitly addressed.
    if (parsed.looksLikeQuestion || (parsed.kind === 'commands' && /\?\s*$/.test(parsed.body))) {
      this.parsedMeta.verbs = ['ask'];
      await this.ask(parsed.body, ex);
      return ex;
    }
    if (addressed) ex.lines.push('Sorry, I didn\'t get that. Without the AI key I only understand commands, "log:" and "?" questions.');
    else ex.status = 'ignored';
    return ex;
  }

  // ------------------------------------------------------------------------------------------ item verbs

  private async itemClause(c: Clause, items: ItemRow[], ex: Exec, msg: MessageInfo): Promise<void> {
    const open = items.filter((i) => OPEN_STATUSES.has(i.status));
    const byOrd = new Map(items.map((i) => [i.ordinal, i]));
    const max = items.length ? Math.max(...items.map((i) => i.ordinal)) : 0;
    // No number: the item whose text this replies to; else (not a reply to some other bot text) the only open one.
    const implicit = (): number | null => this.inlineOrdinal ?? (!this.inlineNoItem && open.length === 1 ? open[0]!.ordinal : null);
    const askWhich = () =>
      ex.lines.push(
        open.length
          ? `Which one? Reply "${c.verb} ${open[0]!.ordinal}", or reply to that suggestion's text with just "${c.verb}".`
          : 'Everything in your latest brief is already taken care of.',
      );
    let nums: number[];
    if (c.verb === 'why' || c.verb === 'draft') {
      const n = c.n ?? implicit();
      if (n === null) return void askWhich();
      nums = [n];
    } else if (c.verb === 'done' || c.verb === 'snooze' || c.verb === 'skip' || c.verb === 'wrong') {
      if (c.sel === null) {
        const n = implicit();
        if (n === null) return void askWhich();
        nums = [n];
      } else nums = selectionNums(c.sel, open.map((i) => i.ordinal));
    } else return;
    const missing = nums.filter((n) => !byOrd.has(n));
    if (missing.length) ex.lines.push(`There's no ${listJoin(missing.map((n) => `#${n}`), 'or')} in that brief${max ? ` (it had 1–${max})` : ''}.`);
    const targets = nums.map((n) => byOrd.get(n)).filter((i): i is ItemRow => !!i);
    if (!targets.length) return;

    if (c.verb === 'why') return this.why(targets[0]!, ex);
    if (c.verb === 'draft') return this.draft(targets[0]!, ex);

    let until: number | undefined;
    if (c.verb === 'snooze') {
      const u = resolveUntil(c.dur, msg.sentAt, this.tz);
      if (u === null) {
        ex.lines.push(`I didn't understand "${truncate(c.dur ?? '', 30)}". Try "snooze ${targets[0]!.ordinal} 2w" or "snooze ${targets[0]!.ordinal} friday".`);
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
        notes.push(`#${item.ordinal} was already ${item.status === 'dismissed' ? 'skipped' : item.status}.`);
        continue;
      }
      const before = snapshotSuggestion(this.db, item.suggestionId);
      const r = await sendFeedback(this.db, item.suggestionId, fb, this.feedbackCtx());
      if (!r.ok) {
        if (r.reason === 'not_available') {
          notes.push("Feedback by text isn't available yet. You can do it at yeackbot.com/today");
          break;
        }
        notes.push(
          r.reason === 'conflict' ? `#${item.ordinal} changed in the meantime.` : r.reason === 'not_found' ? `#${item.ordinal} isn't there anymore.` : `I couldn't update #${item.ordinal}.`,
        );
        continue;
      }
      if (before) ex.snapshots.push({ ...before, after_status: r.result.status });
      if (r.result.batchId) ex.batchIds.push(r.result.batchId);
      ack.ordinals.push(item.ordinal);
      ack.names.push(!item.sensitive && item.personLabel ? item.personLabel : null);
    }
    if (ack.ordinals.length) {
      ex.acks.push(ack);
      ex.effect = ex.effect === 'none' || ex.effect === 'feedback' ? 'feedback' : 'mixed';
      ex.summaries.push(ackSummary(ack, this.tz));
    }
    ex.lines.push(...[...new Set(notes)]);
  }

  /** Feedback joins this command's run when it may write journaled changes (a `wrong` retraction, mutes). */
  private feedbackCtx(writes = true): FeedbackContext {
    return { channel: 'imessage', now: this.now, inboundCommandId: this.cmd.id, runId: writes ? this.ensureRun() : null, services: this.o.providers };
  }

  private async why(item: ItemRow, ex: Exec): Promise<void> {
    if (item.sensitive) {
      ex.lines.push(`#${item.ordinal} is something personal, so the details are only in the app: yeackbot.com/today`);
      return;
    }
    const r = await sendFeedback(this.db, item.suggestionId, { action: 'why' }, this.feedbackCtx(false));
    const why = (r.ok ? r.result.why : null) ?? safeWhy(this.db, item.suggestionId);
    if (!why) {
      ex.lines.push(`${endSentence(`#${item.ordinal} is a "${kindLabel(item.kind)}" suggestion about ${item.label}`)}\nMore at yeackbot.com/today`);
      return;
    }
    const signals = why.signals.slice(0, 4).map((s) => `• ${s.label}: ${s.value}`);
    const learned = why.factors
      .filter((f) => Math.abs(f.value - 1) >= 0.1)
      .slice(0, 2)
      .map((f) => `${f.label} ×${f.value.toFixed(1)}`);
    ex.lines.push(
      [
        `Why I suggested ${item.label}:`,
        truncate(why.summary, 160),
        ...(signals.length ? ['', ...signals] : []),
        ...(learned.length ? ['', `What I've learned: ${learned.join(', ')}`] : []),
        '',
        'More at yeackbot.com/today',
      ].join('\n'),
    );
  }

  private async draft(item: ItemRow, ex: Exec): Promise<void> {
    if (item.sensitive) {
      ex.lines.push(`#${item.ordinal} is something personal, so drafts are only in the app: yeackbot.com/today`);
      return;
    }
    if (!this.services.llm.canSpend('steady').ok) {
      ex.lines.push('I need the AI key to write drafts.');
      return;
    }
    const excluded = new Set(this.settings['llm.excluded_person_ids']);
    if ([item.personId, item.relatedPersonId].some((id) => id && excluded.has(canonicalOf(this.db, id)))) {
      ex.lines.push(`${endSentence(`I can't write drafts for ${item.label}`)} They're kept away from the AI in your Privacy settings.`);
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
        ? [`Something you could send ${item.label}:`, '', `“${clean[0]}”`, ...(clean[1] ? ['', 'Or:', '', `“${clean[1]}”`] : []), '', "Copy it over yourself. I never text anyone but you."].join('\n')
        : "I couldn't write a draft right now. Try again in a bit.",
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
    const created: string[] = [];
    // "This person" in a screenshot: matched by username (or added) before any name is looked at.
    let shot: string | null = null;
    if (intent && usesImage(intent)) {
      const r = intent.image ? resolveScreenshotPerson(this.resolveCtx(), intent.image, people) : ({ ok: false, reason: 'unreadable' } as const);
      if (!r.ok) {
        ex.lines.push(SCREENSHOT_PROBLEM[r.reason]);
        return;
      }
      shot = r.personId;
      visible.add(shot);
      resolved.push(shot); // named somewhere in the parse (people, facts or preferences)
      this.extraLabels.set(shot, r.label);
      if (r.created) created.push(shot);
    }
    const llmLog = intent?.log ?? null;
    if (llmLog && llmLog.people.length) {
      for (const p of llmLog.people) {
        if (p.image && shot) {
          resolved.push(shot);
          continue;
        }
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
    // Standing preferences ride along: their person is resolved like a named one (an ambiguous name is asked once).
    const prefs: NonNullable<ClarifyPayload['prefs']> = [];
    for (const p of intent?.preferences ?? []) {
      const id = p.image ? shot : p.personId && visible.has(p.personId) ? p.personId : null;
      const cands = id ? [] : resolveSurface(p.surface, people);
      const chosen = id ?? (cands.length === 1 ? cands[0]!.id : null);
      if (chosen) {
        prefs.push({ personId: chosen, surface: p.surface, kind: p.kind });
        resolved.push(chosen);
      } else if (cands.length > 1) {
        prefs.push({ personId: null, surface: p.surface, kind: p.kind });
        if (!ambiguous.some((a) => a.surface === p.surface)) ambiguous.push({ surface: p.surface, options: cands });
      } else if (!unresolved.includes(p.surface)) unresolved.push(p.surface);
    }
    const kind: LogKind = llmLog?.kind ?? deterministicKind(text);
    const when = logTimeFromDate(llmLog?.date ?? null, msg.sentAt, this.tz) ?? resolveLogTime(text, msg.sentAt, this.tz);
    const facts: LogFact[] = (llmLog?.facts ?? [])
      .map((f) => ({ personId: f.image ? shot : f.personId, cat: f.cat, value: f.value }))
      .filter((f): f is LogFact => !!f.personId && visible.has(f.personId));
    const remember = intent?.intent === 'add_fact' || intent?.intent === 'set_preference';
    const payload: ClarifyPayload = {
      text,
      kind,
      at: when.at,
      date: when.date,
      interaction: !remember,
      resolved: [...new Set(resolved)],
      surface: '',
      pending: [],
      facts,
      unresolved: unresolved.filter((u) => !ambiguous.some((a) => a.surface === u)),
      llm: !!intent,
      ...(prefs.length ? { prefs } : {}),
      ...(created.length ? { created } : {}),
    };
    if (ambiguous.length) {
      const [first, ...rest] = ambiguous;
      payload.surface = first!.surface;
      payload.pending = rest.map((a) => ({ surface: a.surface, options: optionsFor(a.options) }));
      this.askWhich(first!.surface, optionsFor(first!.options), payload, ex);
      return;
    }
    if (!payload.resolved.length && this.imagesMissed && !this.images?.length) {
      ex.lines.push(
        this.imagesMissed === 'off'
          ? 'Reading screenshots is off (Settings → Agent). Tell me who it is by name.'
          : "I couldn't open the screenshot yet. Send it again in a minute.",
      );
      return;
    }
    if (!payload.resolved.length) {
      const hint = remember ? 'Try a full name like Sam R., or send their profile screenshot.' : 'Try a last initial, like "log: coffee with Sam R."';
      ex.lines.push(
        unresolved.length
          ? `${endSentence(`I couldn't find ${listJoin(unresolved.map((u) => truncate(u, 30)), 'or')}`)} ${hint}`
          : remember
            ? `Who do you mean? ${hint}`
            : 'Who was that with? Try "log: coffee with Sam R."',
      );
      return;
    }
    this.applyLogPlan(payload, msg, ex);
  }

  /** Opens a clarification owned by `owner` (the `log:` that named the people; it stays 'clarifying'). */
  private askWhich(surface: string, options: ClarifyOption[], payload: ClarifyPayload, ex: Exec, owner = this.cmd.id): void {
    const id = createClarification(this.db, owner, options, { ...payload, surface }, this.now);
    const who = truncate(surface.trim(), 30);
    ex.lines.push([`Which ${who || 'one'} did you mean?`, ...options.map((o, i) => `${i + 1}. ${o.label}`), `Reply ${options.length === 2 ? '1 or 2' : `1–${options.length}`}.`].join('\n'));
    ex.status = 'clarifying';
    ex.clarificationId = id;
  }

  private applyLogPlan(payload: ClarifyPayload, msg: MessageInfo, ex: Exec): void {
    const names = payload.resolved.map((id) => this.labelFor(id)).filter((n): n is string => !!n);
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
    const prefAcks = this.applyPrefs(payload, ex);
    ex.effect = ex.effect === 'none' || ex.effect === 'log' ? 'log' : 'mixed';
    const day = relativeDay(payload.date, localParts(this.now, this.tz).date, payload.at, this.tz);
    const what = kind === 'other' ? 'note' : logKindTitle(kind).toLowerCase();
    const shown = applied.facts
      .filter((f) => !f.sensitive)
      .slice(0, 2)
      .map((f) => `“${truncate(f.value, 40)}”`);
    const missing = payload.unresolved.length ? [endSentence(`I couldn't find ${listJoin(payload.unresolved.map((u) => truncate(u, 30)), 'or')}`)] : [];
    const created = new Set(payload.created ?? []);
    const who = listJoin(payload.resolved.map((id) => `${this.labelFor(id) ?? 'someone'}${created.has(id) ? ' (new, from your screenshot)' : ''}`));
    const when = day === 'today' || day === 'yesterday' ? day : `on ${day}`;
    const head = payload.interaction ? `✓ Logged ${LOG_PHRASE[kind]} ${who} ${when}.` : endSentence(`✓ Noted for ${who}`);
    const prefLines = prefAcks.map((a) => endSentence(a[0]!.toUpperCase() + a.slice(1)));
    ex.lines.push([head, ...(shown.length ? [`Noted: ${shown.join(', ')}`] : []), ...prefLines, ...missing].join('\n'));
    const prefNote = prefAcks.length ? ` + ${prefAcks.join(', ')}` : '';
    ex.summaries.push(payload.interaction ? `log for ${listJoin(names)} (${what} ${day})${prefNote}` : `note for ${listJoin(names)}${prefNote}`);
  }

  /** Standing preferences: each kind's circle gets its people, one journaled batch per kind. Returns the acks. */
  private applyPrefs(payload: ClarifyPayload, ex: Exec): string[] {
    const byKind = new Map<PreferenceKind, string[]>();
    for (const p of payload.prefs ?? []) {
      if (!p.personId || !payload.resolved.includes(p.personId)) continue;
      byKind.set(p.kind, [...new Set([...(byKind.get(p.kind) ?? []), p.personId])]);
    }
    const acks: string[] = [];
    for (const [kind, ids] of byKind) {
      const names = listJoin(ids.map((id) => this.labelFor(id) ?? 'someone'));
      const { batchId, changes } = withBatch(
        this.db,
        { runId: this.ensureRun(), kind: 'circle', title: `${names}: ${PREFERENCES[kind].ack} (text)`, subjectPersonId: ids[0], actor: 'user' },
        (t) => addToPreference(t, kind, ids),
        { now: this.now },
      );
      if (changes) ex.batchIds.push(batchId);
      acks.push(PREFERENCES[kind].ack);
    }
    return acks;
  }

  private async answerClarification(clar: ClarificationRow, answer: ClarAnswer, msg: MessageInfo): Promise<Exec> {
    this.parsedMeta = { ...this.parsedMeta, kind: 'clarification', verbs: ['clarify'] };
    const ex = this.blank();
    if (answer.cancel) {
      closeClarification(this.db, clar.id, 'cancelled', this.now, this.cmd.id);
      setCommandStatus(this.db, clar.command_id, 'ignored', this.now, 'clarification_cancelled');
      ex.lines.push('✓ OK, I dropped that log.');
      return ex;
    }
    const chosen = clar.options[answer.choice!]!;
    const payload: ClarifyPayload = {
      ...clar.payload,
      resolved: [...new Set([...clar.payload.resolved, chosen.personId])],
      // A preference waiting on this name now has its person.
      ...(clar.payload.prefs
        ? { prefs: clar.payload.prefs.map((p) => (p.personId === null && p.surface === clar.payload.surface ? { ...p, personId: chosen.personId } : p)) }
        : {}),
    };
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
      ex.lines.push('I can only undo your last command by text. Everything else is at yeackbot.com/today');
      return;
    }
    const r = undoLastCommandEffect(this.db, { at: msg.sentAt, now: this.now, byCommandId: this.cmd.id });
    if (r.status === 'undone') ex.lines.push(r.summary ? `✓ Undone: ${r.summary}` : '✓ Undid your last command.');
    else if (r.status === 'already') ex.lines.push("That's already undone, and there's nothing else I can undo by text.");
    else if (r.status === 'nothing') ex.lines.push("There's nothing to undo.");
    else ex.lines.push("I can't undo that by text because later changes depend on it. You can at yeackbot.com/today");
  }

  private pause(dur: string | null, msg: MessageInfo, ex: Exec): void {
    const until = resolveUntil(dur, msg.sentAt, this.tz);
    if (until === null) {
      ex.lines.push(`I didn't understand "${truncate(dur ?? '', 30)}". Try "pause 1w" or "pause until monday".`);
      return;
    }
    const r = writeSettings(this.db, { 'digest.paused_until': until }, { actor: 'user', runId: this.ensureRun(), title: 'Paused the brief (text)', now: this.now });
    if (r.batchId) ex.batchIds.push(r.batchId);
    ex.effect = ex.effect === 'none' || ex.effect === 'setting' ? 'setting' : 'mixed';
    const off = this.settings['digest.enabled'] ? '' : " (It's also turned off in Settings.)";
    ex.lines.push(`✓ Paused your brief until ${formatDay(until, this.tz, true)}.${off}\nText "resume" to start it again.`);
    ex.summaries.push(`pause until ${formatDay(until, this.tz)}`);
  }

  private resume(ex: Exec): void {
    const paused = this.settings['digest.paused_until'];
    if (paused === null || paused <= this.now) {
      ex.lines.push(this.settings['digest.enabled'] ? "Your brief isn't paused." : "Your brief isn't paused, but it's turned off in Settings.");
      return;
    }
    const r = writeSettings(this.db, { 'digest.paused_until': null }, { actor: 'user', runId: this.ensureRun(), title: 'Resumed the brief (text)', now: this.now });
    if (r.batchId) ex.batchIds.push(r.batchId);
    ex.effect = ex.effect === 'none' || ex.effect === 'setting' ? 'setting' : 'mixed';
    ex.lines.push(
      this.settings['digest.enabled']
        ? `✓ Your brief is back on. The next one comes at ${clockWords(this.settings['digest.time'])}.`
        : '✓ Unpaused. Turn the brief on in Settings to get it.',
    );
    ex.summaries.push('resume');
  }

  private more(digest: DigestRef | null, items: ItemRow[], ex: Exec): void {
    if (!digest) {
      ex.lines.push("I haven't sent you a brief in the last day and a half. Everything's at yeackbot.com/today");
      return;
    }
    // The next suggestion that can still be shown (an intro whose other person is hidden since is passed over).
    const next = Math.max(0, ...items.map((i) => i.ordinal)) + 1;
    const candidates = moreCandidates(this.db, digest.id, this.now, MORE_LOOKAHEAD, this.settings['learner.muted_kinds']);
    const item = candidates.map((c) => selectedItemById(this.db, c.suggestionId, next)).find((i) => i !== null) ?? null;
    if (
      !item ||
      !this.db
        .prepare(`INSERT OR IGNORE INTO command_more_items (digest_id, ordinal, suggestion_id, command_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(digest.id, next, item.suggestionId, this.cmd.id, this.now).changes
    ) {
      ex.lines.push("That's all I've got for now. Everything's at yeackbot.com/today");
      return;
    }
    // Written like a brief item: the numbered headline and its context, then how to act on it. Named alongside the
    // brief's people, so a short name the brief already uses for someone else gets the full last name.
    const brief = peopleInfo(this.db, items.flatMap((i) => [i.personId, i.relatedPersonId]).filter((id): id is string => !!id));
    const names = briefNames([...brief.values(), ...item.people], ownerNames(this.db));
    const copy = templateCopy(item, { db: this.db, now: this.now, timeZone: this.tz, names });
    const lines = itemLines({ line: mainLine(next, copy.headline, item.sensitive), body: copy.body, openers: [], copy: 'template', sensitive: item.sensitive });
    ex.lines.push([...lines, '', `Reply "done ${next}", "skip ${next}", or "more" for another.`].join('\n'));
    ex.replyItem = { digestId: digest.id, ordinal: next };
  }

  private statusLine(): string {
    const s = this.settings;
    const paused = s['digest.paused_until'] !== null && s['digest.paused_until'] > this.now;
    const last = this.db.prepare(`SELECT max(sent_at) FROM digests WHERE status IN ('sent','fallback_sent')`).pluck().get() as number | null;
    return [
      s['digest.enabled'] ? `Your brief is on, every day at ${clockWords(s['digest.time'])}.` : 'Your brief is off. You can turn it on in Settings.',
      ...(paused ? [`It's paused until ${formatDay(s['digest.paused_until']!, this.tz, true)}.`] : []),
      last ? `The last one went out ${formatDay(last, this.tz, true)}.` : "I haven't sent one yet.",
      this.services.llm.canSpend('steady').ok ? 'AI features are on.' : 'AI features are off (no key or budget).',
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

/** The parse names the person in the screenshot (ref IMG) somewhere. */
function usesImage(r: IntentResult): boolean {
  return !!r.log?.people.some((p) => p.image) || !!r.log?.facts.some((f) => f.image) || r.preferences.some((p) => p.image);
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
    // No number: the item the message replies to (or the only open one), resolved in itemClause.
    case 'snooze':
      return { verb: 'snooze', sel, dur: c.dur };
    case 'skip':
      return { verb: 'skip', sel };
    case 'wrong':
      return { verb: 'wrong', sel, note: null };
    case 'why':
    case 'draft':
      return sel && sel.nums.length !== 1 ? null : { verb: c.verb, n: sel ? sel.nums[0]! : null };
    case 'undo':
      return { verb: 'undo', target: null };
    case 'pause':
      return { verb: 'pause', dur: c.dur };
    default:
      return { verb: c.verb };
  }
}

/** "✓ Logged coffee with Sam R. today." */
const LOG_PHRASE: Record<LogKind, string> = {
  coffee: 'coffee with',
  meal: 'a meal with',
  drinks: 'drinks with',
  call: 'a call with',
  party: 'a party with',
  met: 'time with',
  other: 'a note for',
};

const PAST: Record<ItemAck['verb'], string> = { done: 'done', snooze: 'snoozed', skip: 'skipped', wrong: 'marked wrong' };

/** Short form for the journal and "Undone: …" ("2 done (Priya S.)", "1 snoozed → Oct 28"). */
function ackSummary(a: ItemAck, tz: string): string {
  const names = a.names.filter((n): n is string => !!n);
  const who = names.length && names.length <= 2 ? ` (${[...new Set(names)].join(', ')})` : '';
  const until = a.verb === 'snooze' && a.until ? ` → ${formatDay(a.until, tz)}` : '';
  return `${a.ordinals.join(', ')} ${PAST[a.verb]}${who}${until}`;
}

/** "Priya S." / "Priya S. and #3" / "#1 and #3" */
function ackWho(a: ItemAck): string {
  return listJoin(a.ordinals.map((n, k) => a.names[k] ?? `#${n}`));
}

/** One acknowledgement sentence: "✓ Nice, marked Priya S. done." */
function ackText(a: ItemAck, tz: string): string {
  const who = ackWho(a);
  switch (a.verb) {
    case 'done':
      return `✓ Nice, marked ${who} done.`;
    case 'snooze':
      return endSentence(`✓ Snoozed ${who}${a.until ? ` until ${formatDay(a.until, tz, true)}` : ''}`);
    case 'skip':
      return `${endSentence(`✓ Skipped ${who}`)} I'll suggest things like that a bit less.`;
    case 'wrong':
      return `✓ Marked ${who} as wrong. Thanks, I'll learn from that.`;
  }
}

/** One reply: the item acks first (one line each), then other lines, then how to take it back. */
function composeReply(ex: Exec, tz: string, effectful: boolean): string | null {
  const parts: string[] = [...ex.acks.map((a) => ackText(a, tz)), ...ex.lines];
  if (!parts.length) return null;
  const body = parts.join('\n');
  return effectful && ex.purpose === 'reply' && ex.status === 'handled' ? `${body}\n\n(Text "undo" to take that back.)` : body;
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
