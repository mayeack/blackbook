/**
 * Reply debt (intelligence §5), hourly and deterministic, confirmed by the extraction's `needs_reply` verdicts:
 *
 * Candidate — per iMessage / WhatsApp / Instagram DM or small group (n ≤ 8, me included) active in the last
 * 30 days: the last non-reaction message is inbound, from a visible person (never a service), at least 4 h old in a
 * DM / 12 h in a group, and nothing went from me to that person afterwards on any channel (nor did we meet or log
 * an interaction). In a group the message must address me (my name, an @mention or a reply to my message).
 * Excluded: closers ("lol", "ok", "thanks", …), attachment/link/sticker-only messages without a question, messages
 * I tapbacked (unless they ask or request something), and anything already decided (a dismissed, done, retracted
 * or dropped debt covers its messages for good: re-ingestion can't redo a decision).
 *
 * Decision — a current verdict (it covers the last inbound message) decides: needs_reply ≥ 0.6 → debt
 * (classifier 'llm'); no_reply_needed / already_replied ≥ 0.7 → none. Without one, h ≥ 0.6 → debt shown as
 * "likely" (classifier 'heuristic').
 *
 * One live debt per conversation: newer inbound messages roll it forward (last_inbound_msg), the question it is
 * about (debt_msg, asked_at) stays.
 *
 * Auto-close (journaled with a reason, each its own batch so it can be undone from the feed): any outbound from me
 * to them after the debt message on any channel → 'replied'; time together (log:, call, occasion, Partiful) →
 * 'replied' ('together'); a current verdict no_reply_needed → 'dismissed' / already_replied → 'replied'; 30 days
 * after it was asked → 'dropped'; a snooze that ran out → 'open'. An undone close never re-fires on the same
 * signal: only signals newer than the undo count.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { withBatch, type JournalTx } from '../../journal/batch';
import { redact } from '../../ops/redact';
import { HOUR, LIVE_DEBT, REPLY_DEBT } from './constants';
import {
  canonical,
  dmConversationsOf,
  dmCounterpart,
  firstOutbound,
  firstTogether,
  ownerProfile,
  senderPerson,
  undoneAt,
  type OwnerProfile,
} from './signals';
import { atMentionsMe, hasQuestion, mentionsMe, scoreMessage, type DebtReason, type Urgency } from './text';

// ------------------------------------------------------------------------------------------------- rows

export interface DebtRow {
  id: string;
  conversation_id: string;
  person_id: string;
  last_inbound_msg: number;
  asked_at: number;
  reason: string | null;
  urgency: Urgency | null;
  classifier: 'heuristic' | 'llm';
  confidence: number | null;
  status: string;
  snoozed_until: number | null;
  closed_at: number | null;
  closed_reason: string | null;
  closed_by_msg: number | null;
  debt_msg: number | null;
  heuristic_score: number | null;
  llm_state: string | null;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface VerdictRow {
  conversation_id: string;
  through_msg: number;
  through_at: number;
  state: 'needs_reply' | 'no_reply_needed' | 'already_replied' | 'n_a';
  msg_id: number | null;
  reason: DebtReason | null;
  urgency: Urgency;
  confidence: number;
  created_at: number;
}

interface ConvRow {
  id: string;
  kind: 'direct' | 'group';
  source: string;
}

interface Msg {
  id: number;
  sent_at: number;
  is_from_me: number;
  sender_identity_id: string | null;
  kind: string;
  text: string | null;
  reply_to_msg_id: number | null;
}

/** priority = urg · (0.3 + 0.7·T/100 + 0.3·priority) · age_w; age_w = min(1, age_h/48), × 0.5 after 14 days. */
export function debtPriority(d: { urgency: string | null; asked_at: number }, tie: number | null, isPriority: boolean, now: number): number {
  const urg = REPLY_DEBT.urgency[(d.urgency ?? 'normal') as Urgency] ?? 1;
  const ageMs = Math.max(0, now - d.asked_at);
  let ageW = Math.min(1, ageMs / HOUR / REPLY_DEBT.ageFullH);
  if (ageMs > REPLY_DEBT.staleAfterMs) ageW *= REPLY_DEBT.staleFactor;
  const t = Math.max(0, Math.min(100, tie ?? 0));
  return urg * (0.3 + (0.7 * t) / 100 + 0.3 * (isPriority ? 1 : 0)) * ageW;
}

export function latestVerdict(db: DB, conversationId: string): VerdictRow | null {
  return (
    (db
      .prepare(`SELECT * FROM reply_verdicts WHERE conversation_id = ? ORDER BY through_at DESC, through_msg DESC LIMIT 1`)
      .get(conversationId) as VerdictRow | undefined) ?? null
  );
}

const sentAt = (db: DB, msgId: number): number | null =>
  (db.prepare('SELECT sent_at FROM messages WHERE id = ?').pluck().get(msgId) as number | undefined) ?? null;

const MESSAGE_OK = `retracted_at IS NULL AND is_bot = 0 AND is_spam = 0 AND dup_of IS NULL AND kind NOT IN ('system','group_event')`;

// ------------------------------------------------------------------------------------------------- evaluation

export type Evaluation =
  | { kind: 'none'; reason: string }
  | {
      kind: 'debt';
      personId: string;
      debtMsg: Msg;
      lastInbound: Msg;
      h: number;
      reason: DebtReason | null;
      urgency: Urgency;
      classifier: 'heuristic' | 'llm';
      confidence: number;
      llmState: VerdictRow['state'] | null;
    };

interface Scored {
  m: Msg;
  personId: string;
  h: number;
  reason: DebtReason | null;
  urgency: Urgency;
}

/** Whether a verdict reflects the conversation as of `msg` (it covered it). */
const covers = (v: VerdictRow | null, msg: Msg): v is VerdictRow => !!v && v.through_at >= msg.sent_at;

/** What the conversation says right now (pure read). */
export function evaluateConversation(db: DB, conv: ConvRow, now: number, owner: OwnerProfile): Evaluation {
  if (conv.kind === 'group') {
    const n = (db.prepare('SELECT count(*) FROM conversation_members WHERE conversation_id = ? AND is_active = 1').pluck().get(conv.id) as number) + 1;
    if (n > REPLY_DEBT.groupMaxSize) return { kind: 'none', reason: 'group_too_big' };
  }
  const rows = db
    .prepare(
      `SELECT id, sent_at, is_from_me, sender_identity_id, kind, text, reply_to_msg_id FROM messages
       WHERE conversation_id = ? AND ${MESSAGE_OK} AND sent_at >= ? AND sent_at <= ?
       ORDER BY sent_at DESC, id DESC LIMIT 60`,
    )
    .all(conv.id, now - REPLY_DEBT.expiryMs, now) as Msg[];
  if (!rows.length) return { kind: 'none', reason: 'quiet' };
  if (rows[0]!.is_from_me) return { kind: 'none', reason: 'answered' };
  const run: Msg[] = [];
  for (const m of rows) {
    if (m.is_from_me) break;
    run.push(m);
  }
  const lastInbound = run[0]!;
  const minAge = conv.kind === 'direct' ? REPLY_DEBT.dmMinAgeMs : REPLY_DEBT.groupMinAgeMs;
  if (now - lastInbound.sent_at < minAge) return { kind: 'none', reason: 'too_recent' };

  // Decided debts cover their messages for good.
  const decidedThrough =
    (db
      .prepare(
        `SELECT max(m.sent_at) FROM reply_debts d JOIN messages m ON m.id = d.last_inbound_msg
         WHERE d.conversation_id = ? AND d.status NOT IN ('open','snoozed')`,
      )
      .pluck()
      .get(conv.id) as number | null) ?? -Infinity;
  const fresh = run.filter((m) => m.sent_at > decidedThrough).slice(0, REPLY_DEBT.maxRunMessages);
  if (!fresh.length) return { kind: 'none', reason: 'decided' };

  const verdict = latestVerdict(db, conv.id);
  if (covers(verdict, lastInbound)) {
    if (verdict.state === 'no_reply_needed' && verdict.confidence >= REPLY_DEBT.llmSuppressMin) return { kind: 'none', reason: 'llm_no_reply_needed' };
    if (verdict.state === 'already_replied' && verdict.confidence >= REPLY_DEBT.llmSuppressMin) return { kind: 'none', reason: 'llm_already_replied' };
  }

  const counterpart = conv.kind === 'direct' ? dmCounterpart(db, conv.id) : null;
  if (conv.kind === 'direct' && !counterpart) return { kind: 'none', reason: 'no_person' };
  const reactedByMe = db.prepare(`SELECT 1 FROM message_reactions WHERE message_id = ? AND is_from_me = 1 AND removed = 0 LIMIT 1`).pluck();
  const repliedToMine = db.prepare('SELECT is_from_me FROM messages WHERE id = ?').pluck();

  const personOf = (m: Msg): string | null => {
    const p = senderPerson(db, m.sender_identity_id);
    if (conv.kind === 'direct') return p === null ? (m.sender_identity_id === null ? counterpart : null) : p === counterpart ? p : null;
    return p;
  };

  // Every fresh inbound message that could carry the debt, oldest first.
  const scored: Scored[] = [];
  for (const m of [...fresh].reverse()) {
    const personId = personOf(m);
    if (!personId) continue;
    const s = scoreMessage(m.text, owner.names);
    if (s.closer) continue;
    const text = m.text ?? '';
    const fileOnly = m.kind === 'attachment' || m.kind === 'sticker' || m.kind === 'link' || m.kind === 'poll';
    if (fileOnly && !hasQuestion(text)) continue;
    if (reactedByMe.get(m.id) !== undefined && !s.asks) continue;
    if (conv.kind === 'group') {
      const toMe = mentionsMe(text, owner.names) || atMentionsMe(text, owner.names) || (m.reply_to_msg_id !== null && repliedToMine.get(m.reply_to_msg_id) === 1);
      if (!toMe) continue;
    }
    scored.push({ m, personId, ...s });
  }

  // An LLM verdict naming a message of the unanswered run decides (even when newer messages came after it).
  let pick: Scored | null = null;
  let classifier: 'heuristic' | 'llm' = 'heuristic';
  let confidence = 0;
  let reason: DebtReason | null = null;
  let urgency: Urgency = 'normal';
  let llmState: VerdictRow['state'] | null = null;
  if (verdict && verdict.state === 'needs_reply' && verdict.confidence >= REPLY_DEBT.llmNeedsReplyMin) {
    const named = verdict.msg_id !== null ? fresh.find((m) => m.id === verdict.msg_id) : undefined;
    const current = covers(verdict, lastInbound);
    if (named || current) {
      const target = named ?? scored[0]?.m ?? lastInbound;
      const personId = scored.find((s) => s.m.id === target.id)?.personId ?? personOf(target);
      if (personId) {
        const s = scoreMessage(target.text, owner.names);
        pick = { m: target, personId, ...s };
        classifier = 'llm';
        confidence = verdict.confidence;
        reason = verdict.reason ?? s.reason;
        urgency = verdict.urgency;
        llmState = 'needs_reply';
      }
    }
  }
  if (!pick) {
    // The earliest message that clears the bar, so "since" is when they first asked.
    pick = scored.find((s) => s.h >= REPLY_DEBT.heuristicMin) ?? null;
    if (!pick) return { kind: 'none', reason: 'heuristic_below' };
    confidence = Math.max(...scored.filter((s) => s.personId === pick!.personId).map((s) => s.h));
    reason = pick.reason;
    urgency = scored.some((s) => s.personId === pick!.personId && s.urgency === 'high') ? 'high' : pick.urgency;
  }
  if (now - pick.m.sent_at > REPLY_DEBT.expiryMs) return { kind: 'none', reason: 'expired' };

  // Nothing from me to them since, on any channel, and no time together since.
  const convs = [...new Set([conv.id, ...dmConversationsOf(db, [pick.personId])])];
  if (firstOutbound(db, convs, pick.m.sent_at, { until: now })) return { kind: 'none', reason: 'replied_elsewhere' };
  if (firstTogether(db, [pick.personId], pick.m.sent_at, now)) return { kind: 'none', reason: 'together' };

  const h = Math.max(0, ...scored.filter((s) => s.personId === pick.personId).map((s) => s.h));
  return { kind: 'debt', personId: pick.personId, debtMsg: pick.m, lastInbound, h, reason, urgency, classifier, confidence: Math.min(1, confidence), llmState };
}

// ------------------------------------------------------------------------------------------------- writes

export interface DebtPassContext {
  db: DB;
  now: number;
  runId: () => string;
}

export interface DebtPassStats {
  conversations: number;
  created: number;
  updated: number;
  replied: number;
  together: number;
  dismissed: number;
  dropped: number;
  woke: number;
  confirmed: number;
}

export const emptyDebtStats = (): DebtPassStats => ({
  conversations: 0,
  created: 0,
  updated: 0,
  replied: 0,
  together: 0,
  dismissed: 0,
  dropped: 0,
  woke: 0,
  confirmed: 0,
});

const debtBatch = (c: DebtPassContext, title: string, personId: string, confidence: number | null, fn: (t: JournalTx) => void) =>
  withBatch(c.db, { runId: c.runId(), kind: 'reply_debt', title, subjectPersonId: personId, confidence, actor: 'agent' }, fn, { now: c.now });

function addEvidence(db: DB, debtId: string, msg: Msg): void {
  db.prepare(`INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote) VALUES ('reply_debt', ?, ?, ?)`).run(
    debtId,
    msg.id,
    msg.text ? redact(msg.text, 160) : null,
  );
}

/** Brings one conversation's live debt in line with its evaluation (creates or rolls forward; never closes). */
export function reconcileConversation(c: DebtPassContext, conv: ConvRow, owner: OwnerProfile, stats: DebtPassStats): void {
  const { db, now } = c;
  tx(db, () => {
    const ev = evaluateConversation(db, conv, now, owner);
    if (ev.kind !== 'debt') return;
    const live = db
      .prepare(`SELECT * FROM reply_debts WHERE conversation_id = ? AND status IN ('open','snoozed') ORDER BY asked_at DESC LIMIT 1`)
      .get(conv.id) as DebtRow | undefined;
    if (live) {
      const patch: Record<string, unknown> = {};
      if (live.last_inbound_msg !== ev.lastInbound.id) {
        const taken = db.prepare('SELECT 1 FROM reply_debts WHERE conversation_id = ? AND last_inbound_msg = ?').pluck().get(conv.id, ev.lastInbound.id);
        if (taken === undefined) patch.last_inbound_msg = ev.lastInbound.id;
      }
      if ((live.heuristic_score ?? 0) < ev.h) patch.heuristic_score = ev.h;
      if (ev.classifier === 'llm' && (live.classifier !== 'llm' || live.confidence !== ev.confidence || live.llm_state !== ev.llmState)) {
        Object.assign(patch, { classifier: 'llm', confidence: ev.confidence, llm_state: ev.llmState, reason: ev.reason, urgency: ev.urgency });
      } else if (live.classifier === 'heuristic' && ev.classifier === 'heuristic' && (live.confidence ?? 0) < ev.confidence) {
        patch.confidence = ev.confidence;
      }
      if (!Object.keys(patch).length) return;
      const upgraded = patch.classifier === 'llm' && live.classifier !== 'llm';
      debtBatch(c, upgraded ? 'Confirmed a reply you owe' : 'Updated a reply you owe', canonical(db, live.person_id), ev.confidence, (t) => {
        if (t.update('reply_debts', { id: live.id }, { ...patch, run_id: c.runId() })) {
          if (upgraded) stats.confirmed++;
          else stats.updated++;
        }
      });
      return;
    }
    if (db.prepare('SELECT 1 FROM reply_debts WHERE conversation_id = ? AND last_inbound_msg = ?').pluck().get(conv.id, ev.lastInbound.id) !== undefined) return;
    const id = uuidv7(now);
    debtBatch(c, ev.classifier === 'llm' ? 'Noticed a reply you owe' : 'Noticed a message that may need your reply', ev.personId, ev.confidence, (t) => {
      t.insert('reply_debts', {
        id,
        conversation_id: conv.id,
        person_id: ev.personId,
        last_inbound_msg: ev.lastInbound.id,
        asked_at: ev.debtMsg.sent_at,
        reason: ev.reason,
        urgency: ev.urgency,
        classifier: ev.classifier,
        confidence: ev.confidence,
        status: 'open',
        debt_msg: ev.debtMsg.id,
        heuristic_score: ev.h,
        llm_state: ev.llmState,
        run_id: c.runId(),
      });
      addEvidence(db, id, ev.debtMsg);
    });
    stats.created++;
  });
}

export type DebtClose =
  | { status: 'replied'; reason: 'outbound'; byMsg: number }
  | { status: 'replied'; reason: 'together' | 'already_replied'; byMsg: null }
  | { status: 'dismissed'; reason: 'no_reply_needed'; byMsg: null }
  | { status: 'dropped'; reason: 'expired'; byMsg: null };

const CLOSE_TITLES: Record<DebtClose['reason'], string> = {
  outbound: 'Closed a reply debt: you replied',
  together: 'Closed a reply debt: you got together',
  already_replied: 'Closed a reply debt: already answered',
  no_reply_needed: 'Closed a reply debt: no reply needed',
  expired: 'Dropped a reply debt after 30 days',
};

/** The close (if any) the world implies for a live debt; `undo` = when an undo last touched it. */
export function closeFor(db: DB, d: DebtRow, now: number): DebtClose | null {
  const undo = undoneAt(db, 'reply_debts', d.id);
  const since = Math.max(d.asked_at, undo ?? -Infinity);
  const personId = canonical(db, d.person_id);
  const convs = [...new Set([d.conversation_id, ...dmConversationsOf(db, [personId])])];
  const out = firstOutbound(db, convs, since, { until: now });
  if (out) return { status: 'replied', reason: 'outbound', byMsg: out.id };
  if (firstTogether(db, [personId], since, now)) return { status: 'replied', reason: 'together', byMsg: null };
  const v = latestVerdict(db, d.conversation_id);
  const lastAt = sentAt(db, d.last_inbound_msg) ?? d.asked_at;
  if (v && v.through_at >= lastAt && (undo === null || v.created_at > undo) && v.confidence >= REPLY_DEBT.llmSuppressMin) {
    if (v.state === 'no_reply_needed') return { status: 'dismissed', reason: 'no_reply_needed', byMsg: null };
    if (v.state === 'already_replied') return { status: 'replied', reason: 'already_replied', byMsg: null };
  }
  if (now - since >= REPLY_DEBT.expiryMs) return { status: 'dropped', reason: 'expired', byMsg: null };
  return null;
}

/** Writes a close inside an existing journal transaction. */
export function writeDebtClose(t: JournalTx, d: DebtRow, close: DebtClose, extra: Record<string, unknown> = {}): boolean {
  return t.update('reply_debts', { id: d.id }, {
    status: close.status,
    closed_at: t.now,
    closed_reason: close.reason,
    closed_by_msg: close.byMsg,
    snoozed_until: null,
    ...extra,
  });
}

/** Closers and snooze wake-ups for one live debt (re-read inside the transaction). */
export function closeDebt(c: DebtPassContext, debtId: string, stats: DebtPassStats): void {
  const { db, now } = c;
  tx(db, () => {
    const d = db.prepare('SELECT * FROM reply_debts WHERE id = ?').get(debtId) as DebtRow | undefined;
    if (!d || !(LIVE_DEBT as readonly string[]).includes(d.status)) return;
    const close = closeFor(db, d, now);
    const personId = canonical(db, d.person_id);
    if (close) {
      debtBatch(c, CLOSE_TITLES[close.reason], personId, d.confidence, (t) => {
        if (writeDebtClose(t, d, close, { run_id: c.runId() })) {
          if (close.status === 'dropped') stats.dropped++;
          else if (close.status === 'dismissed') stats.dismissed++;
          else if (close.reason === 'together') stats.together++;
          else stats.replied++;
        }
      });
      return;
    }
    if (d.status === 'snoozed' && (d.snoozed_until ?? 0) <= now) {
      debtBatch(c, 'A snoozed reply debt is back', personId, d.confidence, (t) => {
        if (t.update('reply_debts', { id: d.id }, { status: 'open', snoozed_until: null })) stats.woke++;
      });
    }
  });
}

/** Live debts, oldest first. */
export function liveDebts(db: DB): DebtRow[] {
  return db.prepare(`SELECT * FROM reply_debts WHERE status IN (SELECT value FROM json_each(?)) ORDER BY asked_at, id`).all(JSON.stringify(LIVE_DEBT)) as DebtRow[];
}

/** Conversations the candidate pass looks at: DMs and groups with a message in the last 30 days. */
export function candidateConversations(db: DB, now: number): ConvRow[] {
  return db
    .prepare(
      `SELECT id, kind, source FROM conversations
       WHERE kind IN ('direct','group') AND agent_excluded = 0 AND coalesce(last_message_at, 0) >= ?
       ORDER BY last_message_at DESC, id`,
    )
    .all(now - REPLY_DEBT.expiryMs) as ConvRow[];
}

/**
 * The whole pass as small steps (each one synchronous and transactional), closers first: the async runner hands
 * the event loop back between them.
 */
export function* replyDebtSteps(c: DebtPassContext, stats: DebtPassStats): Generator<void> {
  const owner = ownerProfile(c.db);
  for (const d of liveDebts(c.db)) {
    closeDebt(c, d.id, stats);
    yield;
  }
  for (const conv of candidateConversations(c.db, c.now)) {
    stats.conversations++;
    reconcileConversation(c, conv, owner, stats);
    yield;
  }
}
