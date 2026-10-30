/**
 * Commitments (intelligence §5): promises made in conversations, kept as journaled rows with a lifecycle
 *   open → due (due end passed; vague / undated ones 21 days after they were made)
 *        → done / cancelled (the extraction says so, or the user) | auto_closed (a signal says it happened)
 *        | lapsed (30 days past the due end with no signal; asked once "did this happen?", then archived)
 *
 * Writers:
 *   upsertCommitmentFromExtraction(t, input)   THE extraction hook, inside the window's journal batch:
 *       gate conf ≥ 0.70; a cited message is required; the due date is checked against chrono-node; a repeat of a
 *       live commitment (same person + kind, similar `what`, or a shared cited message) updates it (its stakes
 *       only ever go up: stakes.ts); status done/cancelled with `closes` (or a matching live one) closes it;
 *       anything already decided — including an undone or "wrong" row — is never re-created (sticky).
 *   commitmentSteps(...)                       the hourly lifecycle + auto-close pass:
 *       meet / plan / call → time together (log:, call, Partiful co-attendance, calendar occasion) or an occasion /
 *         Partiful event both of you are on, in [made_at, due_end + 7 d];
 *       send → owner me/both: my outbound attachment or link to them after it was made ("likely done");
 *              owner them: their inbound attachment or link;
 *       reply_later (owner me) → my outbound to them ≥ 2 h after it was made.
 *   An undone transition never re-fires on the same signal or deadline: only newer signals count and time-based
 *   transitions restart from the undo.
 *
 * owner = them items are "waiting on" items (surfaced for priority people or T ≥ 60 only, at rank weight × 0.5:
 * generators.ts, loops.ts).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { withBatch, type JournalTx } from '../../journal/batch';
import { redact } from '../../ops/redact';
import { readSetting } from '../../settings/registry';
import { COMMITMENT, LIVE_COMMITMENT } from './constants';
import { checkDue, resolveDue, type DueInput, type DuePrecision } from './dates';
import { higherStakes, isStakes, stakesOf, type Stakes } from './stakes';
import { canonical, dmConversationsOf, firstInboundFile, firstOutbound, firstScheduled, firstTogether, isVisible, undoneAt, type TogetherHit } from './signals';
import { whatNorm, whatSimilarity } from './text';

export const COMMITMENT_KINDS = ['meet', 'call', 'send', 'intro', 'reply_later', 'favor', 'plan', 'other'] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];
export type CommitmentOwner = 'me' | 'them' | 'both';

export interface CommitmentRow {
  id: string;
  person_id: string;
  other_person_ids: string;
  owner: CommitmentOwner;
  kind: CommitmentKind;
  what: string;
  due_at: number | null;
  due_start: number | null;
  due_end: number | null;
  due_precision: DuePrecision | null;
  conversation_id: string | null;
  confidence: number;
  status: string;
  snoozed_until: number | null;
  closed_at: number | null;
  closed_reason: string | null;
  closed_by_ref: string | null;
  run_id: string | null;
  prompt_version: string | null;
  origin: string;
  made_at: number | null;
  source_msg: number | null;
  what_norm: string | null;
  sensitive: number;
  /** null on rows from before the extraction labeled it (stakes.ts guesses). */
  stakes: Stakes | null;
  created_at: number;
  updated_at: number;
}

// ------------------------------------------------------------------------------------------------- timing

/** When the promise was made (the cited message's time; created_at for legacy reminders). */
export const madeAt = (c: Pick<CommitmentRow, 'made_at' | 'created_at'>): number => c.made_at ?? c.created_at;

/** The moment it becomes due: the due end of a dated one, made_at + 21 d for vague / undated ones. */
export function dueMoment(c: Pick<CommitmentRow, 'due_end' | 'due_at' | 'due_start' | 'due_precision' | 'made_at' | 'created_at'>): number {
  const dated = c.due_end ?? c.due_at ?? c.due_start;
  if (dated !== null && c.due_precision !== 'vague') return dated;
  return madeAt(c) + COMMITMENT.vagueDueMs;
}

/** When it lapses without a signal (30 days past the due moment). */
export const lapseMoment = (c: Parameters<typeof dueMoment>[0]): number => dueMoment(c) + COMMITMENT.lapseMs;

/** Kinds that are a follow-up someone said they'd do: send, call, intro, reply later, a favor. */
const FOLLOW_UP_KINDS = new Set(['send', 'call', 'intro', 'reply_later', 'favor']);
/** An "other" commitment worded as a follow-up ("text her the address", "pay back the tickets"). */
const FOLLOW_UP_WHAT =
  /^(?:send|call|text|email|e-mail|introduce|intro|pay|return|share|follow up|reply|write|ask|tell|let \S+ know|check in|lend|mail|post|schedule|invite|connect|book|order|buy|get back)\b/i;

/**
 * A documented intent to follow up: a reminder the owner set by text, or a promise to do something (send, call,
 * intro, reply later, a favor, or an "other" worded that way). A plan to meet or a thing tied to an event
 * ("Halloween party at mine", "bring tomatoes") is not: once its time has passed there is nothing left to do.
 */
export function followUpIntent(k: Pick<CommitmentRow, 'kind' | 'what' | 'origin'>): boolean {
  return k.origin === 'command' || FOLLOW_UP_KINDS.has(k.kind) || (k.kind === 'other' && FOLLOW_UP_WHAT.test(k.what.trim()));
}

/**
 * The plan or event a commitment is about is behind us: its date has passed, or (undated, and not a plan to meet
 * "sometime") it fell due weeks after it was made.
 */
export function eventPast(k: Parameters<typeof dueMoment>[0] & Pick<CommitmentRow, 'kind'>, now: number): boolean {
  // dueMoment's own notion of a date.
  const dated = k.due_precision !== 'vague' && (k.due_end ?? k.due_at ?? k.due_start) !== null;
  if (dated) return now > dueMoment(k);
  return k.kind !== 'meet' && k.kind !== 'plan' && now >= dueMoment(k);
}

export const otherIds = (c: Pick<CommitmentRow, 'other_person_ids'>): string[] => {
  try {
    const v = JSON.parse(c.other_person_ids) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Canonical ids of everyone a commitment is with (primary first, deduplicated). */
export function commitmentPeople(db: DB, c: Pick<CommitmentRow, 'person_id' | 'other_person_ids'>): string[] {
  return [...new Set([c.person_id, ...otherIds(c)].map((p) => canonical(db, p)))];
}

/**
 * Of `personIds` (canonical), the people with a documented intent to follow up made in [from, to]: a live commitment
 * (open, due, snoozed) with them that followUpIntent accepts. The generators about a past event ("Follow up with …"
 * the morning after, "A year ago today") keep only these people (intel/events.ts, suggestions/gen/memory.ts).
 */
export function followUpPeople(db: DB, personIds: readonly string[], from: number, to: number): Set<string> {
  const wanted = new Set(personIds);
  const out = new Set<string>();
  if (!wanted.size) return out;
  const rows = db
    .prepare(
      `SELECT person_id, other_person_ids, kind, what, origin FROM commitments
       WHERE status IN (SELECT value FROM json_each(?)) AND coalesce(made_at, created_at) BETWEEN ? AND ?`,
    )
    .all(JSON.stringify(LIVE_COMMITMENT), from, to) as Pick<CommitmentRow, 'person_id' | 'other_person_ids' | 'kind' | 'what' | 'origin'>[];
  for (const k of rows) {
    if (!followUpIntent(k)) continue;
    for (const p of commitmentPeople(db, k)) if (wanted.has(p)) out.add(p);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- extraction hook

export interface ExtractedCommitmentInput {
  /** The counterpart (the extraction's `with[0]`, resolved to a person id; any id of a merged person works). */
  personId: string;
  /** The rest of `with` (resolved). */
  otherPersonIds?: readonly string[];
  owner: CommitmentOwner | 'ME' | 'THEM' | 'BOTH';
  kind: CommitmentKind;
  /** Short, display-ready (de-pseudonymized) description: "Send the gym link". ≤ 200 chars kept. */
  what: string;
  /** How much it matters (stakes.ts); absent = guessed from `what`. */
  stakes?: Stakes | null;
  /** The schema's due ({kind, start, end} with YYYY-MM-DD dates) — `precision` or `kind` names the precision. */
  due: { precision?: DuePrecision; kind?: DuePrecision; start: string | number | null; end: string | number | null };
  status: 'open' | 'done' | 'cancelled';
  /** `closes` ("K<id>" or the bare id) of a commitment this one closes. */
  closes?: string | null;
  conversationId: string | null;
  /** Cited messages (ids resolved from "m:8812"; display-ready quotes). At least one must exist. */
  evidence: readonly { messageId: number; quote: string | null }[];
  confidence: number;
  sensitive?: boolean;
  promptVersion?: string | null;
  /** When it was made (default: the earliest cited message). */
  madeAt?: number | null;
  /** IANA zone for YYYY-MM-DD dates (default: settings tz). */
  timeZone?: string;
}

export type UpsertCommitmentResult =
  | { action: 'inserted' | 'updated' | 'closed'; commitmentId: string }
  | {
      action: 'skipped';
      commitmentId: string | null;
      reason: 'below_gate' | 'invalid' | 'no_person' | 'no_evidence' | 'already_decided' | 'blocked' | 'nothing_to_close' | 'duplicate';
    };

const PRECISION_RANK: Record<DuePrecision, number> = { none: 0, vague: 1, range: 2, date: 3 };
const ownerOf = (o: string): CommitmentOwner | null => {
  const v = o.toLowerCase();
  return v === 'me' || v === 'them' || v === 'both' ? v : null;
};
const stripK = (ref: string): string => (/^K/i.test(ref) && ref.length > 1 ? ref.slice(1) : ref);

function liveFor(db: DB, personId: string): CommitmentRow[] {
  return db
    .prepare(
      `SELECT k.* FROM commitments k JOIN person_canon pc ON pc.person_id = k.person_id
       WHERE pc.canonical_id = ? AND k.status IN (SELECT value FROM json_each(?)) ORDER BY k.created_at`,
    )
    .all(personId, JSON.stringify(LIVE_COMMITMENT)) as CommitmentRow[];
}

function addEvidence(db: DB, id: string, evidence: readonly { messageId: number; quote: string | null }[], sensitive: boolean): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote) VALUES ('commitment', ?, ?, ?)`);
  for (const e of evidence) ins.run(id, e.messageId, sensitive || !e.quote ? null : redact(e.quote, 200));
}

const batchRunId = (t: JournalTx): string | null =>
  (t.db.prepare('SELECT run_id FROM change_batches WHERE id = ?').pluck().get(t.batchId) as string | undefined) ?? null;

/**
 * THE extraction → commitments hook (one validated `commitments[]` item). Runs inside the caller's journal batch,
 * so undoing the window undoes it. Never throws on bad input: it answers 'skipped' with a reason.
 */
export function upsertCommitmentFromExtraction(t: JournalTx, input: ExtractedCommitmentInput): UpsertCommitmentResult {
  const db = t.db;
  const skip = (reason: Extract<UpsertCommitmentResult, { action: 'skipped' }>['reason'], commitmentId: string | null = null): UpsertCommitmentResult => ({
    action: 'skipped',
    commitmentId,
    reason,
  });
  const owner = ownerOf(String(input.owner ?? ''));
  const what = (input.what ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!owner || !(COMMITMENT_KINDS as readonly string[]).includes(input.kind) || !what || !Number.isFinite(input.confidence)) return skip('invalid');
  if (!['open', 'done', 'cancelled'].includes(input.status)) return skip('invalid');
  const confidence = Math.max(0, Math.min(1, input.confidence));
  if (confidence < COMMITMENT.gate) return skip('below_gate');
  const personId = canonical(db, input.personId);
  if (!isVisible(db, personId)) return skip('no_person');

  const msgAt = db.prepare('SELECT sent_at FROM messages WHERE id = ?').pluck();
  const evidence = (input.evidence ?? []).filter((e) => Number.isInteger(e.messageId) && msgAt.get(e.messageId) !== undefined);
  if (!evidence.length) return skip('no_evidence');
  const made = input.madeAt ?? Math.min(...evidence.map((e) => msgAt.get(e.messageId) as number));
  const sensitive = input.sensitive === true;
  const norm = whatNorm(what);
  const stakes: Stakes = isStakes(input.stakes) ? input.stakes : stakesOf({ what, kind: input.kind });
  const firstMsg = evidence[0]!.messageId;
  const ref = `m:${firstMsg}`;

  // Commitments of this kind that already cite one of these messages: the decision on them stands. (One message can
  // carry several promises of different kinds: "I'll send the link, and let's get dinner".)
  const citing = db
    .prepare(
      `SELECT k.* FROM evidence e JOIN commitments k ON k.id = e.subject_id JOIN person_canon pc ON pc.person_id = k.person_id
       WHERE e.subject_type = 'commitment' AND e.message_id IN (SELECT value FROM json_each(?)) AND pc.canonical_id = ? AND k.kind = ?
       GROUP BY k.id`,
    )
    .all(JSON.stringify(evidence.map((e) => e.messageId)), personId, input.kind) as CommitmentRow[];

  const live = liveFor(db, personId);
  const similar = (c: CommitmentRow, sameKind: boolean) =>
    (!sameKind || c.kind === input.kind) && whatSimilarity(c.what_norm ?? whatNorm(c.what), norm) >= COMMITMENT.similarWhat;

  // ---- a done / cancelled report closes the commitment it names (or a matching live one)
  if (input.status !== 'open') {
    const closesId = input.closes ? stripK(String(input.closes)) : null;
    // The named one may be live, or auto-closed on a "likely done" signal (the conversation now confirms it).
    const named = closesId
      ? (live.find((c) => c.id === closesId || c.id === input.closes) ??
        (db
          .prepare(
            `SELECT k.* FROM commitments k JOIN person_canon pc ON pc.person_id = k.person_id
             WHERE k.id IN (?, ?) AND pc.canonical_id = ? AND k.status = 'auto_closed'`,
          )
          .get(closesId, String(input.closes), personId) as CommitmentRow | undefined))
      : undefined;
    const target =
      named ??
      citing.find((c) => (LIVE_COMMITMENT as readonly string[]).includes(c.status)) ??
      live
        .filter((c) => similar(c, false))
        .sort((a, b) => whatSimilarity(b.what_norm ?? whatNorm(b.what), norm) - whatSimilarity(a.what_norm ?? whatNorm(a.what), norm))[0];
    if (!target) return skip('nothing_to_close');
    if (madeAt(target) > made) return skip('nothing_to_close');
    t.update('commitments', { id: target.id }, {
      status: input.status === 'done' ? 'done' : 'cancelled',
      closed_at: t.now,
      closed_reason: input.status === 'done' ? 'said_done' : 'said_cancelled',
      closed_by_ref: ref,
      snoozed_until: null,
    });
    addEvidence(db, target.id, evidence, sensitive || target.sensitive === 1);
    return { action: 'closed', commitmentId: target.id };
  }

  const tz = input.timeZone ?? readSetting(db, 'tz');
  const precision: DuePrecision = input.due?.precision ?? input.due?.kind ?? 'none';
  const due = checkDue(
    resolveDue({ precision, start: input.due?.start ?? null, end: input.due?.end ?? null } as DueInput, tz),
    evidence.map((e) => e.quote ?? '').filter(Boolean),
    made,
    tz,
  );
  const others = [...new Set((input.otherPersonIds ?? []).map((p) => canonical(db, p)))].filter((p) => p !== personId && isVisible(db, p));

  // ---- a repeat of something already decided is never re-created
  const decided = citing.find((c) => !(LIVE_COMMITMENT as readonly string[]).includes(c.status));
  if (decided) return skip('already_decided', decided.id);
  const blocked = db
    .prepare(
      `SELECT k.* FROM commitments k JOIN person_canon pc ON pc.person_id = k.person_id
       WHERE pc.canonical_id = ? AND k.kind = ? AND k.status = 'retracted'`,
    )
    .all(personId, input.kind) as CommitmentRow[];
  const wrong = blocked.find((c) => similar(c, true) && Math.abs(madeAt(c) - made) <= COMMITMENT.lapseMs);
  if (wrong) return skip('blocked', wrong.id);

  // ---- a repeat of a live one updates it
  const match = citing.find((c) => (LIVE_COMMITMENT as readonly string[]).includes(c.status)) ?? live.find((c) => similar(c, true));
  if (match) {
    const patch: Record<string, unknown> = { confidence: Math.max(match.confidence, confidence) };
    const oldRank = PRECISION_RANK[match.due_precision ?? 'none'];
    const newRank = PRECISION_RANK[due.precision];
    const rescheduled = newRank >= 2 && due.end !== null && due.end !== match.due_end && made >= madeAt(match);
    if (newRank > oldRank || rescheduled) {
      Object.assign(patch, { due_precision: due.precision, due_start: due.start, due_end: due.end, due_at: due.end });
      if (match.status === 'due' && due.end !== null && due.end > t.now) patch.status = 'open';
    }
    const mergedOthers = [...new Set([...otherIds(match), ...others])];
    if (mergedOthers.length !== otherIds(match).length) patch.other_person_ids = JSON.stringify(mergedOthers);
    if (sensitive && match.sensitive !== 1) patch.sensitive = 1;
    const raised = higherStakes(stakesOf(match), stakes);
    if (raised !== match.stakes) patch.stakes = raised;
    if (input.promptVersion) patch.prompt_version = input.promptVersion;
    if (!match.what_norm) patch.what_norm = whatNorm(match.what);
    const changed = t.update('commitments', { id: match.id }, patch);
    addEvidence(db, match.id, evidence, sensitive || match.sensitive === 1);
    return changed ? { action: 'updated', commitmentId: match.id } : skip('duplicate', match.id);
  }

  const id = uuidv7(t.now);
  t.insert('commitments', {
    id,
    person_id: personId,
    other_person_ids: JSON.stringify(others),
    owner,
    kind: input.kind,
    what,
    what_norm: norm,
    due_at: due.end,
    due_start: due.start,
    due_end: due.end,
    due_precision: due.precision,
    conversation_id: input.conversationId,
    confidence,
    status: 'open',
    run_id: batchRunId(t),
    prompt_version: input.promptVersion ?? null,
    origin: 'llm',
    made_at: made,
    source_msg: firstMsg,
    sensitive: sensitive ? 1 : 0,
    stakes,
  });
  addEvidence(db, id, evidence, sensitive);
  return { action: 'inserted', commitmentId: id };
}

/** Convenience for callers without a batch: one journaled batch (kind 'commitment') for a list of items. */
export function applyExtractedCommitments(
  db: DB,
  items: readonly ExtractedCommitmentInput[],
  o: { runId: string; now?: number; title?: string },
): { batchId: string | null; results: UpsertCommitmentResult[] } {
  const r = withBatch(
    db,
    { runId: o.runId, kind: 'commitment', title: o.title ?? 'Noted promises from a conversation', actor: 'agent' },
    (t) => items.map((i) => upsertCommitmentFromExtraction(t, i)),
    { now: o.now },
  );
  return { batchId: r.changes ? r.batchId : null, results: r.result };
}

/** Live commitments of these people, for the extraction's people cards ("open commitment ids", K refs). */
export function openCommitmentsForPeople(
  db: DB,
  personIds: readonly string[],
): { id: string; ref: string; personId: string; owner: CommitmentOwner; kind: CommitmentKind; what: string; dueEnd: number | null; status: string; sensitive: boolean }[] {
  const out = [];
  for (const pid of new Set(personIds.map((p) => canonical(db, p)))) {
    for (const c of liveFor(db, pid)) {
      out.push({ id: c.id, ref: `K${c.id}`, personId: pid, owner: c.owner, kind: c.kind, what: c.what, dueEnd: c.due_end ?? c.due_at, status: c.status, sensitive: c.sensitive === 1 });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- lifecycle

export interface CommitmentPassStats {
  commitments: number;
  autoClosed: number;
  due: number;
  lapsed: number;
  woke: number;
}

export const emptyCommitmentStats = (): CommitmentPassStats => ({ commitments: 0, autoClosed: 0, due: 0, lapsed: 0, woke: 0 });

export interface CommitmentPassContext {
  db: DB;
  now: number;
  runId: () => string;
}

export type CommitmentSignal = { reason: 'met' | 'call' | 'logged' | 'scheduled' | 'rsvp' | 'sent' | 'received' | 'replied'; ref: string; at: number };

const fromTogether = (h: TogetherHit): CommitmentSignal => ({
  reason: h.kind === 'call' ? 'call' : h.kind === 'manual' || h.kind === 'text_log' || h.kind === 'meeting' ? 'logged' : h.kind === 'rsvp' ? 'rsvp' : h.kind === 'scheduled' ? 'scheduled' : 'met',
  ref: h.ref,
  at: h.at,
});

/** The signal (if any) that a live commitment happened. `since` = made_at, or the last undo when newer. */
export function signalFor(db: DB, c: CommitmentRow, now: number): CommitmentSignal | null {
  const undo = undoneAt(db, 'commitments', c.id);
  const made = madeAt(c);
  const since = Math.max(made, undo ?? -Infinity);
  const people = commitmentPeople(db, c);
  const until = dueMoment(c) + COMMITMENT.closeGraceMs;
  if (c.kind === 'meet' || c.kind === 'plan' || c.kind === 'call') {
    const together = firstTogether(db, people, since, Math.min(now, until));
    if (together) return fromTogether(together);
    if (c.kind !== 'call') {
      const scheduled = firstScheduled(db, people, since, until);
      if (scheduled) return fromTogether(scheduled);
    }
    return null;
  }
  const convs = [...new Set([...(c.conversation_id ? [c.conversation_id] : []), ...dmConversationsOf(db, people)])];
  if (c.kind === 'send') {
    if (c.owner === 'them') {
      const got = firstInboundFile(db, convs, people, since, now);
      return got ? { reason: 'received', ref: `m:${got.id}`, at: got.at } : null;
    }
    const sent = firstOutbound(db, convs, since, { until: now, withFile: true });
    return sent ? { reason: 'sent', ref: `m:${sent.id}`, at: sent.at } : null;
  }
  if (c.kind === 'reply_later' && c.owner !== 'them') {
    const out = firstOutbound(db, convs, Math.max(made + COMMITMENT.replyLaterMinMs, since), { until: now });
    return out ? { reason: 'replied', ref: `m:${out.id}`, at: out.at } : null;
  }
  return null;
}

const SIGNAL_TITLES: Record<CommitmentSignal['reason'], string> = {
  met: 'Closed a promise: you got together',
  call: 'Closed a promise: you talked',
  logged: 'Closed a promise: you logged it',
  scheduled: 'Closed a promise: it is on the calendar',
  rsvp: 'Closed a promise: you are both going',
  sent: 'Closed a promise: you sent it',
  received: 'Closed a promise: they sent it',
  replied: 'Closed a promise: you got back to them',
};

/** One live commitment's step: wake → signal close → due → lapse (re-read inside the transaction). */
export function stepCommitment(c: CommitmentPassContext, id: string, stats: CommitmentPassStats): void {
  const { db, now } = c;
  tx(db, () => {
    const k = db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as CommitmentRow | undefined;
    if (!k || !(LIVE_COMMITMENT as readonly string[]).includes(k.status)) return;
    const personId = canonical(db, k.person_id);
    const batch = (title: string, fn: (t: JournalTx) => void) =>
      withBatch(db, { runId: c.runId(), kind: 'commitment', title, subjectPersonId: personId, confidence: k.confidence, actor: 'agent' }, fn, { now });

    const signal = signalFor(db, k, now);
    if (signal) {
      batch(SIGNAL_TITLES[signal.reason], (t) => {
        if (t.update('commitments', { id }, { status: 'auto_closed', closed_at: now, closed_reason: signal.reason, closed_by_ref: signal.ref, snoozed_until: null })) {
          stats.autoClosed++;
        }
      });
      return;
    }
    const undo = undoneAt(db, 'commitments', id);
    const dueAt = dueMoment(k);
    const lapseAt = Math.max(dueAt, undo ?? -Infinity) + COMMITMENT.lapseMs;
    if (k.status === 'snoozed') {
      if ((k.snoozed_until ?? 0) > now) return;
      const next = now >= dueAt ? 'due' : 'open';
      batch('A snoozed promise is back', (t) => {
        if (t.update('commitments', { id }, { status: next, snoozed_until: null })) stats.woke++;
      });
      return;
    }
    if (now >= lapseAt) {
      batch('A promise lapsed', (t) => {
        if (t.update('commitments', { id }, { status: 'lapsed', closed_at: now, closed_reason: 'lapsed' })) stats.lapsed++;
      });
      return;
    }
    // An undo after the due moment means "not due yet, as far as I'm concerned": don't flip it back.
    if (k.status === 'open' && now >= dueAt && (undo === null || dueAt > undo)) {
      batch('A promise is due', (t) => {
        if (t.update('commitments', { id }, { status: 'due' })) stats.due++;
      });
    }
  });
}

export function liveCommitments(db: DB): CommitmentRow[] {
  return db
    .prepare(`SELECT * FROM commitments WHERE status IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`)
    .all(JSON.stringify(LIVE_COMMITMENT)) as CommitmentRow[];
}

export function* commitmentSteps(c: CommitmentPassContext, stats: CommitmentPassStats): Generator<void> {
  for (const k of liveCommitments(c.db)) {
    stats.commitments++;
    stepCommitment(c, k.id, stats);
    yield;
  }
}
