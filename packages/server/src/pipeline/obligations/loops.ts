/**
 * Read model of open loops (shared DTOs: @yb/shared api/loops.ts) for Today's strip, Person → Overview, event
 * briefs and Ask:
 *   personOpenLoops(db, personId)          one person (every waiting-on item of theirs, snoozed ones included)
 *   openLoops(db, {cursor, limit})          everyone (waiting-on gated: priority people or T ≥ 60)
 *   openLoopCounts(db) / todayOpenLoops(db) "reply debt n · promises n" + a short preview
 *   openLoopsByPerson(db, personIds)        flat lists per person (briefs, Ask get_person)
 * Every person comes through person_visible (canonical; never hidden, merged-away, roster-only, service or me):
 * a loop whose person isn't visible is not shown at all. Titles are templates or the extracted `what`; sensitive
 * commitments read "Something personal" and never carry quotes. Quotes are ≤ 160 chars with phones and emails
 * masked. Low-stakes promises ("bring tomatoes", stakes.ts) are listed after the rest and never in Today's preview.
 */
import type { DueWindow, EvidenceRef, OpenLoop, OpenLoopCounts, OpenLoopList, PersonChip } from '@yb/shared';
import type { DB } from '../../db/connection';
import { redact } from '../../ops/redact';
import { readSetting } from '../../settings/registry';
import { commitmentPeople, dueMoment, lapseMoment, madeAt, otherIds, type CommitmentRow } from './commitments';
import { COMMITMENT } from './constants';
import { shortDate } from './dates';
import { debtPriority, type DebtRow } from './replyDebt';
import { canonical } from './signals';
import { stakesOf } from './stakes';

export interface LoopQuery {
  now?: number;
  timeZone?: string;
  /** Include snoozed loops (default: false; the person page passes true). */
  includeSnoozed?: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  beeper: 'Instagram',
  instagram_dyi: 'Instagram',
};
const sourceLabel = (s: string | null): string => (s ? (SOURCE_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)) : 'Messages');

const DEBT_TITLES: Record<string, string> = {
  question: 'Asked you something',
  request: 'Asked you for something',
  invitation: 'Invited you',
  plan_confirm: 'Waiting on you to confirm plans',
  emotional: 'Shared something with you',
  other: 'Waiting on your reply',
};

const OWNER_DETAIL = { me: 'You promised', them: 'They promised', both: 'You both planned' } as const;

// ------------------------------------------------------------------------------------------------- chips

/** PersonChips of visible canonical people (others are dropped). */
export function personChips(db: DB, ids: readonly string[]): Map<string, PersonChip> {
  const out = new Map<string, PersonChip>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT pv.id, pv.display_name, pv.first_name, ps.state FROM person_visible pv LEFT JOIN person_stats ps ON ps.person_id = pv.id
       WHERE pv.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(ids)])) as { id: string; display_name: string; first_name: string | null; state: PersonChip['state'] }[];
  for (const r of rows) out.set(r.id, { id: r.id, displayName: r.display_name, firstName: r.first_name, state: r.state ?? null });
  return out;
}

// ------------------------------------------------------------------------------------------------- rows

interface DebtView extends DebtRow {
  pid: string;
  source: string | null;
  conv_kind: string | null;
  msg_id: number | null;
  msg_text: string | null;
  msg_at: number | null;
  tie_strength: number | null;
  is_priority: number;
}

interface CommitView extends CommitmentRow {
  pid: string;
  tie_strength: number | null;
  is_priority: number;
}

const debtStatuses = (o: LoopQuery) => JSON.stringify(o.includeSnoozed ? ['open', 'snoozed'] : ['open']);
const commitStatuses = (o: LoopQuery) => JSON.stringify(o.includeSnoozed ? ['open', 'due', 'snoozed'] : ['open', 'due']);

function debtRows(db: DB, o: LoopQuery, personId: string | null): DebtView[] {
  return db
    .prepare(
      `SELECT d.*, pc.canonical_id AS pid, c.source, c.kind AS conv_kind, m.id AS msg_id, m.text AS msg_text, m.sent_at AS msg_at,
              ps.tie_strength, pv.is_priority
       FROM reply_debts d
       JOIN person_canon pc ON pc.person_id = d.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pc.canonical_id
       LEFT JOIN conversations c ON c.id = d.conversation_id
       LEFT JOIN messages m ON m.id = coalesce(d.debt_msg, d.last_inbound_msg)
       WHERE d.status IN (SELECT value FROM json_each(@statuses)) AND (@pid IS NULL OR pc.canonical_id = @pid)`,
    )
    .all({ statuses: debtStatuses(o), pid: personId }) as DebtView[];
}

function commitRows(db: DB, o: LoopQuery, personId: string | null): CommitView[] {
  return db
    .prepare(
      `SELECT k.*, pc.canonical_id AS pid, ps.tie_strength, pv.is_priority
       FROM commitments k
       JOIN person_canon pc ON pc.person_id = k.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pc.canonical_id
       WHERE k.status IN (SELECT value FROM json_each(@statuses)) AND (@pid IS NULL OR pc.canonical_id = @pid)`,
    )
    .all({ statuses: commitStatuses(o), pid: personId }) as CommitView[];
}

/** owner = them items surface only for priority people or T ≥ 60 (intelligence §5). */
export const waitingOnSurfaces = (tie: number | null, isPriority: boolean): boolean => isPriority || (tie ?? 0) >= COMMITMENT.waitingMinTie;

// ------------------------------------------------------------------------------------------------- mapping

function debtLoop(d: DebtView, chips: Map<string, PersonChip>, tz: string, now: number): OpenLoop | null {
  const person = chips.get(d.pid);
  if (!person) return null;
  const evidence: EvidenceRef[] = [];
  if (d.msg_id !== null) {
    evidence.push({
      kind: 'message',
      ref: `m:${d.msg_id}`,
      label: `${sourceLabel(d.source)} · ${shortDate(d.msg_at ?? d.asked_at, tz, now)}`,
      at: d.msg_at ?? d.asked_at,
      quote: d.msg_text ? redact(d.msg_text, 160) : null,
      source: d.source,
      href: `/p/${d.pid}?m=${d.msg_id}`,
    });
  }
  if (d.conversation_id) {
    evidence.push({ kind: 'conversation', ref: `conv:${d.conversation_id}`, label: sourceLabel(d.source), at: null, quote: null, source: d.source, href: null });
  }
  return {
    type: 'reply_debt',
    id: d.id,
    person,
    otherPeople: [],
    title: DEBT_TITLES[d.reason ?? 'other'] ?? DEBT_TITLES.other!,
    detail: d.conv_kind === 'group' ? `${sourceLabel(d.source)} · group chat` : sourceLabel(d.source),
    since: d.asked_at,
    due: null,
    owner: 'me',
    status: d.status,
    likely: d.classifier === 'heuristic',
    urgency: d.urgency ?? 'normal',
    confidence: d.confidence,
    conversationId: d.conversation_id,
    evidence,
  };
}

function commitmentEvidence(db: DB, k: CommitView, tz: string, now: number): EvidenceRef[] {
  const rows = db
    .prepare(
      `SELECT e.message_id, e.quote, m.sent_at, c.source FROM evidence e
       JOIN messages m ON m.id = e.message_id LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE e.subject_type = 'commitment' AND e.subject_id = ? ORDER BY m.sent_at LIMIT 5`,
    )
    .all(k.id) as { message_id: number; quote: string | null; sent_at: number; source: string | null }[];
  const out: EvidenceRef[] = rows.map((r) => ({
    kind: 'message' as const,
    ref: `m:${r.message_id}`,
    label: `${sourceLabel(r.source)} · ${shortDate(r.sent_at, tz, now)}`,
    at: r.sent_at,
    quote: k.sensitive === 1 || !r.quote ? null : redact(r.quote, 160),
    source: r.source,
    href: `/p/${k.pid}?m=${r.message_id}`,
  }));
  out.unshift({ kind: 'commitment', ref: `K${k.id}`, label: null, at: madeAt(k), quote: null, source: null, href: `/p/${k.pid}` });
  return out;
}

function dueOf(k: CommitmentRow): DueWindow | null {
  const precision = k.due_precision ?? (k.due_at !== null ? 'date' : 'none');
  const end = k.due_end ?? k.due_at;
  if (precision === 'none' && end === null) return null;
  return { precision, start: k.due_start ?? (precision === 'date' ? end : null), end };
}

function commitmentLoop(db: DB, k: CommitView, chips: Map<string, PersonChip>, tz: string, now: number): OpenLoop | null {
  const person = chips.get(k.pid);
  if (!person) return null;
  const others = commitmentPeople(db, k)
    .slice(1)
    .map((id) => chips.get(id))
    .filter((c): c is PersonChip => !!c);
  return {
    type: 'commitment',
    id: k.id,
    person,
    otherPeople: others,
    title: k.sensitive === 1 ? 'Something personal' : k.what,
    detail: `${OWNER_DETAIL[k.owner]} · ${shortDate(madeAt(k), tz, now)}`,
    since: madeAt(k),
    due: dueOf(k),
    owner: k.owner,
    status: k.status,
    likely: false,
    urgency: null,
    confidence: k.confidence,
    conversationId: k.conversation_id,
    evidence: commitmentEvidence(db, k, tz, now),
  };
}

// ------------------------------------------------------------------------------------------------- lists

interface Built {
  replyDebts: { loop: OpenLoop; score: number }[];
  commitments: { loop: OpenLoop; score: number; due: number; low: boolean }[];
  waitingOn: { loop: OpenLoop; score: number; due: number; low: boolean }[];
}

function build(db: DB, o: LoopQuery, personId: string | null): Built {
  const now = o.now ?? Date.now();
  const tz = o.timeZone ?? readSetting(db, 'tz');
  const debts = debtRows(db, o, personId);
  const commits = commitRows(db, o, personId);
  const chipIds = [...debts.map((d) => d.pid), ...commits.flatMap((k) => [k.pid, ...otherIds(k).map((p) => canonical(db, p))])];
  const chips = personChips(db, chipIds);

  // One debt per conversation (someone can be waiting on two channels); most pressing first.
  const replyDebts: Built['replyDebts'] = [];
  for (const d of debts) {
    const loop = debtLoop(d, chips, tz, now);
    if (loop) replyDebts.push({ loop, score: debtPriority(d, d.tie_strength, d.is_priority === 1, now) });
  }
  replyDebts.sort((a, b) => b.score - a.score || a.loop.since - b.loop.since);

  const commitments: Built['commitments'] = [];
  const waitingOn: Built['waitingOn'] = [];
  for (const k of commits) {
    const them = k.owner === 'them';
    if (them && personId === null && !waitingOnSurfaces(k.tie_strength, k.is_priority === 1)) continue;
    const loop = commitmentLoop(db, k, chips, tz, now);
    if (!loop) continue;
    const due = dueMoment(k);
    const stakes = stakesOf(k);
    const base = (them ? 0.6 : 1) * (them ? COMMITMENT.waitingWeight : 1) * COMMITMENT.stakesWeight[stakes];
    const score = k.status === 'due' ? base : due - now <= COMMITMENT.upcomingMs ? base * 0.8 : base * 0.3;
    (them ? waitingOn : commitments).push({ loop, score, due, low: stakes === 'low' });
  }
  const byDue = (a: { loop: OpenLoop; due: number; low: boolean }, b: { loop: OpenLoop; due: number; low: boolean }) =>
    Number(a.low) - Number(b.low) ||
    Number(b.loop.status === 'due') - Number(a.loop.status === 'due') ||
    a.due - b.due ||
    b.loop.since - a.loop.since;
  commitments.sort(byDue);
  waitingOn.sort(byDue);
  return { replyDebts, commitments, waitingOn };
}

/** Open loops of one person (any id of theirs; merged-away ids resolve to the survivor). */
export function personOpenLoops(db: DB, personId: string, o: LoopQuery = {}): OpenLoopList {
  const pid = canonical(db, personId);
  const b = build(db, { includeSnoozed: true, ...o }, pid);
  return {
    replyDebts: b.replyDebts.map((x) => x.loop),
    commitments: b.commitments.map((x) => x.loop),
    waitingOn: b.waitingOn.map((x) => x.loop),
    nextCursor: null,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const encodeLoopCursor = (offset: number): string => `o${offset}`;
export function decodeLoopCursor(cursor: string | null | undefined): number {
  const m = /^o(\d{1,6})$/.exec(cursor ?? '');
  return m ? Number(m[1]) : 0;
}

/** Everyone's open loops (Today's expanded strip): each list paged by the same offset. */
export function openLoops(db: DB, o: LoopQuery & { cursor?: string | null; limit?: number } = {}): OpenLoopList {
  const b = build(db, o, null);
  const offset = decodeLoopCursor(o.cursor);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(o.limit ?? DEFAULT_LIMIT)));
  const page = <T extends { loop: OpenLoop }>(xs: T[]) => xs.slice(offset, offset + limit).map((x) => x.loop);
  const more = [b.replyDebts, b.commitments, b.waitingOn].some((xs) => xs.length > offset + limit);
  return {
    replyDebts: page(b.replyDebts),
    commitments: page(b.commitments),
    waitingOn: page(b.waitingOn),
    nextCursor: more ? encodeLoopCursor(offset + limit) : null,
  };
}

export function openLoopCounts(db: DB, o: LoopQuery = {}): OpenLoopCounts {
  const b = build(db, o, null);
  return { replyDebts: b.replyDebts.length, commitments: b.commitments.length, waitingOn: b.waitingOn.length };
}

/** Today's strip: counts plus the most pressing few (debts by priority, due promises, gated waiting-on; no low stakes). */
export function todayOpenLoops(db: DB, o: LoopQuery & { previewLimit?: number } = {}): { counts: OpenLoopCounts; preview: OpenLoop[] } {
  const b = build(db, o, null);
  const counts = { replyDebts: b.replyDebts.length, commitments: b.commitments.length, waitingOn: b.waitingOn.length };
  const all = [
    ...b.replyDebts.map((x) => ({ loop: x.loop, score: Math.min(1, x.score) })),
    ...[...b.commitments, ...b.waitingOn].filter((x) => !x.low).map((x) => ({ loop: x.loop, score: x.score })),
  ].sort((a, b2) => b2.score - a.score || a.loop.since - b2.loop.since);
  return { counts, preview: all.slice(0, Math.max(0, o.previewLimit ?? 5)).map((x) => x.loop) };
}

/** Flat open loops per canonical person (pre-event briefs, Ask). Waiting-on items included, snoozed ones not. */
export function openLoopsByPerson(db: DB, personIds: readonly string[], o: LoopQuery = {}): Map<string, OpenLoop[]> {
  const out = new Map<string, OpenLoop[]>();
  for (const raw of new Set(personIds)) {
    const pid = canonical(db, raw);
    if (out.has(pid)) continue;
    const b = build(db, { includeSnoozed: false, ...o }, pid);
    out.set(pid, [...b.replyDebts, ...b.commitments, ...b.waitingOn].map((x) => x.loop));
  }
  return out;
}

/** Lapsed commitments still in their "did this happen?" window (natural lapse within the last 7 days). */
export function recentlyLapsed(db: DB, now: number): CommitmentRow[] {
  const rows = db.prepare(`SELECT * FROM commitments WHERE status = 'lapsed' AND closed_reason = 'lapsed'`).all() as CommitmentRow[];
  return rows.filter((k) => now - lapseMoment(k) <= COMMITMENT.lapseAskWindowMs && lapseMoment(k) <= now);
}
