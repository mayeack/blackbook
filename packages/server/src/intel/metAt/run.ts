/**
 * The nightly met-at pass (job 'met-at', AGENT_TIMES.metAt 06:40: after identity-match and occasions, before graph
 * and intel). Design docs/design/tickets-met-at.md §2 with the [met] review amendments.
 *
 *   1. derive, per candidate person (signals.ts) and past happening (events.ts):
 *        - every trusted signal scores the happenings whose window holds it (score.ts), skipping a happening the
 *          person was known before (evidence earlier than its start − 12 h), one their name/handle IS (performer,
 *          venue, title), and one the owner rejected for them (any key of its chain / Partiful link): a 'rejected'
 *          row, or a withdrawn one whose last status change was the owner's undo (undoing a re-activation is as
 *          sticky as undoing an insert, which the journal tombstones to 'rejected');
 *          a ticket performer never gets a link at all (the name, or the handle with an artist word around it);
 *        - signals on the same happening combine (noisy-OR, ≤ 0.95); kept at ≥ 0.5; the earliest happening wins:
 *          at most one active link per person.
 *   2. write, one journaled 'met_at' batch per person that changes (a nightly run, opened only when needed):
 *        - the same happening → the existing row is updated in place (active ↔ withdrawn; 'rejected' is never
 *          revived), retargeted to the surviving occasion only when its target is no longer a member;
 *        - a different happening → the old row is withdrawn and the new one inserted;
 *        - no longer derived (signal gone, person now known, hidden, merged into the owner, …) → withdrawn;
 *        - an active row the owner's undo had the last word on (it brought the row back, or put it back as it was) is
 *          held like his own link: never updated or withdrawn, and no other link is written beside it;
 *        - a roster-only person with an active link ≥ 0.6 is brought forward to provisional in the same batch, unless
 *          the owner's undo is what sent them back; a person whose only promotion was met-at's (no interactions, no
 *          other active link, nothing the owner did about them since, no linked screenshot, no Contacts card, no
 *          record merged in that was shown on its own) goes back to roster-only when the link is gone (withdrawn, or
 *          rejected as "Wrong").
 * Re-running over unchanged data writes nothing (no batch, no run). Undoing the run tombstones its inserts to
 * 'rejected' (never re-created) and restores the statuses it changed, and the next run leaves all of it as the undo
 * left it (a link it re-activated goes back to withdrawn and stays so). Logs carry counts only.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { withBatch, type JournalTx } from '../../journal/batch';
import { finishRun, startRun } from '../../journal/runs';
import { nullLogger, type Logger } from '../../ops/logger';
import { survivingOccasion } from '../../pipeline/occasions/build';
import { drive } from '../common';
import { loadHappenings, ticketPerformers, type Happening, type Member } from './events';
import { BASE, choose, combine, gapFactor, isPerformer, MET_AT, namesHappening, round3, type Scored, type SignalKind } from './score';
import { loadInputs, type Candidate, type Signal } from './signals';
import { SHOT_SQL, targetKeys, type MetAtRow } from './store';

export interface MetAtRunOptions {
  now?: number;
  signal?: AbortSignal;
  log?: Logger;
  jobRunId?: number | null;
}

export interface MetAtRunResult {
  /** False when the scheduler's signal stopped the pass early or a person's batch failed (what was written stays consistent). */
  complete: boolean;
  /** The nightly run the batches went into; null when nothing changed. */
  runId: string | null;
  counts: Record<string, number>;
}

/** What the run wants for one person. */
export interface MetAtDesire {
  happening: Happening;
  member: Member;
  confidence: number;
  signal: SignalKind;
  signalAt: number;
  /** Per-signal contributions, stored as person_met_at.signals (ids and numbers only). */
  signals: { s: SignalKind; t: number; c: number }[];
}

interface Skips {
  known: number;
  named: number;
  rejected: number;
  performer: number;
  ambiguous: number;
}

// ---------------------------------------------------------------------------------------------- derive

/** Happenings whose window [start − 2 h, end + 36 h] holds t (sorted by start; maxLen = longest happening). */
function inWindow(hs: readonly Happening[], maxLen: number, t: number): Happening[] {
  let lo = 0;
  let hi = hs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hs[mid]!.startsAt <= t + MET_AT.beforeMs) lo = mid + 1;
    else hi = mid;
  }
  const out: Happening[] = [];
  const floor = t - MET_AT.afterMs - maxLen;
  for (let i = lo - 1; i >= 0 && hs[i]!.startsAt >= floor; i--) {
    const h = hs[i]!;
    if (t >= h.startsAt - MET_AT.beforeMs && t <= h.endsAt + MET_AT.afterMs) out.push(h);
  }
  return out;
}

/** The best member of a happening for a signal at t (tie: contains t and shortest, then occasions, then id). */
function bestMember(h: Happening, kind: SignalKind, t: number): { member: Member; score: number } {
  const inside = (m: Member) => t >= m.startsAt && t <= m.endsAt;
  const len = (m: Member) => m.endsAt - m.startsAt;
  const better = (a: Member, sa: number, b: Member, sb: number): boolean => {
    if (sa !== sb) return sa > sb;
    if (inside(a) !== inside(b)) return inside(a);
    if (len(a) !== len(b)) return len(a) < len(b);
    if (a.type !== b.type) return a.type === 'occasion';
    return a.id < b.id;
  };
  let best: { member: Member; score: number } | null = null;
  for (const m of h.members) {
    const score = BASE[kind] * gapFactor(t, m.startsAt, m.endsAt) * m.weight;
    if (!best || better(m, score, best.member, best.score)) best = { member: m, score };
  }
  return best!;
}

/** The one link a person should have, or null. */
export function derivePerson(
  person: Candidate,
  signals: readonly Signal[],
  o: {
    happenings: readonly Happening[];
    maxLen: number;
    knownSince: number | undefined;
    rejectedKeys: ReadonlySet<string>;
    performers: ReadonlySet<string>;
    skips?: Skips;
  },
): MetAtDesire | null {
  if (!signals.length) return null;
  if (isPerformer(person.labels, o.performers)) {
    if (o.skips) o.skips.performer++;
    return null;
  }
  const per = new Map<string, { h: Happening; parts: { s: SignalKind; t: number; c: number; member: Member }[] }>();
  for (const s of signals) {
    const scored: Scored<{ h: Happening; member: Member }>[] = [];
    for (const h of inWindow(o.happenings, o.maxLen, s.t)) {
      if ([...h.keys].some((k) => o.rejectedKeys.has(k))) {
        if (o.skips) o.skips.rejected++;
        continue;
      }
      if (o.knownSince !== undefined && o.knownSince < h.startsAt - MET_AT.knownCutoffMs) {
        if (o.skips) o.skips.known++;
        continue;
      }
      if (namesHappening(person.labels, h.labels)) {
        if (o.skips) o.skips.named++;
        continue;
      }
      const b = bestMember(h, s.kind, s.t);
      scored.push({ item: { h, member: b.member }, score: b.score, start: h.startsAt, end: h.endsAt, venues: h.venues });
    }
    const pick = choose(s.t, scored);
    if (!pick) continue;
    if (pick.ambiguous && o.skips) o.skips.ambiguous++;
    const cur = per.get(pick.item.h.key) ?? { h: pick.item.h, parts: [] };
    cur.parts.push({ s: s.kind, t: s.t, c: round3(pick.score), member: pick.item.member });
    per.set(pick.item.h.key, cur);
  }
  let best: MetAtDesire | null = null;
  for (const { h, parts } of per.values()) {
    const confidence = round3(combine(parts.map((p) => p.c)));
    if (confidence < MET_AT.minWrite) continue;
    if (best && best.happening.startsAt <= h.startsAt) continue;
    const top = [...parts].sort((a, b) => b.c - a.c || a.t - b.t)[0]!;
    best = {
      happening: h,
      member: top.member,
      confidence,
      signal: top.s,
      signalAt: top.t,
      signals: parts.map(({ s, t, c }) => ({ s, t, c })).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.t - b.t)),
    };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- write

interface ExistingRow extends MetAtRow {
  canonical_id: string;
}

interface PersonRow {
  id: string;
  display_name: string;
  status: string;
}

const memberKeysOf = (h: Happening) => new Set(h.members.map((m) => m.key));

interface StatusChange {
  seq: number;
  kind: string;
  undone_at: number | null;
  /** The change_log row's seq. */
  log_seq: number;
  status: string;
  before: string | null;
}

/** A person record's last status change (optionally only those logged before `beforeLogSeq`). */
function lastStatusChange(db: DB, personId: string, beforeLogSeq = Number.MAX_SAFE_INTEGER): StatusChange | undefined {
  return db
    .prepare(
      `SELECT b.seq, b.kind, b.undone_at, l.seq AS log_seq, json_extract(l.after, '$.status') AS status, json_extract(l.before, '$.status') AS before
       FROM change_log l JOIN change_batches b ON b.id = l.batch_id
       WHERE l.entity = 'people' AND l.entity_key = ? AND json_extract(l.after, '$.status') IS NOT NULL AND l.seq < ?
       ORDER BY l.seq DESC LIMIT 1`,
    )
    .get(personId, beforeLogSeq) as StatusChange | undefined;
}

const byMetAt = (c: StatusChange | undefined): boolean => !!c && c.kind === 'met_at' && c.undone_at === null && c.status === 'provisional';

/**
 * The person was made visible by met-at alone: the last status change is a live met_at batch's, the owner hasn't
 * done anything about them since (a live user batch about any of their records — a rename, a note, a tag — other
 * than a met-at "Wrong"), and nothing else would show them, whenever it came (before or after met-at): no
 * interactions, no linked contact screenshot, no Contacts card, no record merged in that was shown on its own.
 */
function promotedOnlyByMetAt(db: DB, personId: string): boolean {
  const last = lastStatusChange(db, personId);
  if (!last || !byMetAt(last)) return false;
  const members = `SELECT person_id FROM person_canon WHERE canonical_id = @id`;
  const other = db
    .prepare(
      `SELECT 1 FROM change_batches b WHERE b.subject_person_id IN (${members}) AND b.seq > @seq AND b.actor = 'user' AND b.undone_at IS NULL AND b.kind <> 'met_at'
       UNION ALL SELECT 1 FROM interactions i WHERE i.person_id IN (${members}) AND i.retracted_at IS NULL
       UNION ALL SELECT 1 FROM contact_screenshots s WHERE s.person_id IN (${members}) AND ${SHOT_SQL}
       UNION ALL SELECT 1 FROM identities i WHERE i.person_id IN (${members}) AND i.kind = 'addressbook_id' AND i.status = 'active'
       LIMIT 1`,
    )
    .get({ id: personId, seq: last.seq });
  if (other) return false;
  // A record merged in (by anyone, the matcher included) that was shown before the merge, and not by met-at.
  const merged = db
    .prepare(
      `SELECT mg.merged_id AS id, l.seq AS log_seq, json_extract(l.before, '$.status') AS status
       FROM merges mg JOIN change_log l ON l.batch_id = mg.batch_id AND l.entity = 'people' AND l.entity_key = mg.merged_id
       WHERE mg.merged_id IN (${members}) AND mg.undone_at IS NULL`,
    )
    .all({ id: personId }) as { id: string; log_seq: number; status: string | null }[];
  return !merged.some((m) => m.status === 'active' || (m.status === 'provisional' && !byMetAt(lastStatusChange(db, m.id, m.log_seq))));
}

/** The owner's undo sent the person back from provisional to the roster: met-at never brings them forward again. */
function sentBackByUndo(db: DB, personId: string): boolean {
  const last = lastStatusChange(db, personId);
  return !!last && last.kind === 'undo' && last.undone_at === null && last.status === 'roster_only' && last.before === 'provisional';
}

interface Counts {
  inserted: number;
  updated: number;
  reactivated: number;
  retargeted: number;
  withdrawn: number;
  brought_forward: number;
  demoted: number;
  batches: number;
}

/** Plans and applies one person's changes in one batch (none when nothing changes). */
function writePerson(
  db: DB,
  personId: string,
  desire: MetAtDesire | null,
  rows: readonly ExistingRow[],
  o: { now: number; runId: () => string; counts: Counts; held: ReadonlySet<string> },
): void {
  const person = db.prepare('SELECT id, display_name, status FROM people WHERE id = ?').get(personId) as PersonRow | undefined;
  if (!person) return;
  const inferred = rows.filter((r) => r.source === 'inferred' && r.status !== 'rejected');
  // The owner's own active link, or an inferred one his undo had the last word on (o.held): never touched here, and
  // no other link is written beside it.
  const ownerActive = rows.some((r) => r.status === 'active' && (r.source === 'user' || o.held.has(r.id)));
  const want = ownerActive ? null : desire;
  const keysOf = new Map(inferred.map((r) => [r.id, targetKeys(db, r)]));

  type Op = { kind: 'insert'; row: Record<string, unknown> } | { kind: 'update'; id: string; patch: Record<string, unknown>; reactivated: boolean; retargeted: boolean } | { kind: 'withdraw'; id: string };
  const ops: Op[] = [];
  let keep: ExistingRow | undefined;
  if (want) {
    const match = inferred.filter((r) => [...keysOf.get(r.id)!].some((k) => want.happening.keys.has(k)));
    keep = [...match].sort(
      (a, b) =>
        Number(b.target_key === want.member.key && b.person_id === personId) - Number(a.target_key === want.member.key && a.person_id === personId) ||
        Number(b.target_key === want.member.key) - Number(a.target_key === want.member.key) ||
        Number(b.status === 'active') - Number(a.status === 'active') ||
        b.updated_at - a.updated_at ||
        (a.id < b.id ? -1 : 1),
    )[0];
    const fields: Record<string, unknown> = {
      status: 'active',
      confidence: want.confidence,
      signal: want.signal,
      signal_at: want.signalAt,
      signals: JSON.stringify(want.signals),
    };
    if (keep) {
      let retargeted = false;
      if (!memberKeysOf(want.happening).has(keep.target_key)) {
        // Its occasion was merged (or now covers its Partiful event): the survivor of its own occasion when that is
        // still part of the happening, else the best member.
        const own = keep.occasion_id ? `o:${survivingOccasion(db, keep.occasion_id)}` : null;
        const to = want.happening.members.find((m) => m.key === own) ?? want.member;
        const taken = rows.some((r) => r.person_id === keep!.person_id && r.target_key === to.key && r.id !== keep!.id);
        if (!taken) {
          fields.occasion_id = to.type === 'occasion' ? to.id : null;
          fields.event_id = to.type === 'event' ? to.id : null;
          fields.target_key = to.key;
          retargeted = true;
        }
      }
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) if ((keep as unknown as Record<string, unknown>)[k] !== v) patch[k] = v;
      if (Object.keys(patch).length) {
        patch.run_id = o.runId();
        ops.push({ kind: 'update', id: keep.id, patch, reactivated: keep.status !== 'active', retargeted: retargeted && 'target_key' in patch });
      }
    } else if (!rows.some((r) => r.person_id === personId && r.target_key === want.member.key)) {
      // (A row of the owner's own for this exact target — any status — is his to keep: never collide with it.)
      ops.push({
        kind: 'insert',
        row: {
          id: uuidv7(o.now),
          person_id: personId,
          occasion_id: want.member.type === 'occasion' ? want.member.id : null,
          event_id: want.member.type === 'event' ? want.member.id : null,
          target_key: want.member.key,
          ...fields,
          source: 'inferred',
          run_id: o.runId(),
        },
      });
    }
  }
  for (const r of inferred) if (r !== keep && r.status === 'active' && !o.held.has(r.id)) ops.push({ kind: 'withdraw', id: r.id });

  const activeAfter = !!want || ownerActive;
  const bringForward = !!want && want.confidence >= MET_AT.bringForward && person.status === 'roster_only' && !sentBackByUndo(db, personId);
  const demote = !activeAfter && person.status === 'provisional' && promotedOnlyByMetAt(db, personId);
  if (!ops.length && !bringForward && !demote) return;

  const title =
    want && (ops.some((x) => x.kind === 'insert') || ops.some((x) => x.kind === 'update' && (x.reactivated || x.retargeted)))
      ? `Met ${person.display_name} at ${want.member.title ?? 'an event'}`
      : want
        ? `Where you met ${person.display_name}: updated`
        : `No longer sure where you met ${person.display_name}`;
  withBatch(
    db,
    { runId: o.runId(), kind: 'met_at', title, subjectPersonId: personId, confidence: want?.confidence ?? null, actor: 'agent' },
    (t: JournalTx) => {
      for (const op of ops) {
        if (op.kind === 'insert') {
          t.insert('person_met_at', op.row);
          o.counts.inserted++;
        } else if (op.kind === 'update') {
          if (t.update('person_met_at', { id: op.id }, op.patch)) {
            if (op.reactivated) o.counts.reactivated++;
            else o.counts.updated++;
            if (op.retargeted) o.counts.retargeted++;
          }
        } else if (t.update('person_met_at', { id: op.id }, { status: 'withdrawn', run_id: o.runId() })) o.counts.withdrawn++;
      }
      if (bringForward && t.update('people', { id: personId }, { status: 'provisional' })) o.counts.brought_forward++;
      if (demote && t.update('people', { id: personId }, { status: 'roster_only' })) o.counts.demoted++;
    },
    { now: o.now },
  );
  o.counts.batches++;
}

// ---------------------------------------------------------------------------------------------- run

interface RunState {
  runId: string | null;
  counts: Record<string, number>;
}

function* steps(db: DB, o: { now: number; jobRunId: number | null; log: Logger; state: RunState }): Generator<void, void> {
  const inputs = loadInputs(db);
  yield;
  const happenings = loadHappenings(db, o.now);
  const maxLen = happenings.reduce((m, h) => Math.max(m, h.endsAt - h.startsAt), 0);
  const performers = ticketPerformers(db);
  yield;

  const existing = new Map<string, ExistingRow[]>();
  for (const r of db
    .prepare(`SELECT m.*, pc.canonical_id FROM person_met_at m JOIN person_canon pc ON pc.person_id = m.person_id ORDER BY m.created_at, m.id`)
    .all() as ExistingRow[]) {
    const l = existing.get(r.canonical_id) ?? [];
    l.push(r);
    existing.set(r.canonical_id, l);
  }
  // The owner's "no": 'rejected' rows, and withdrawn ones an undo (or redo) of his turned off. His "yes": an active
  // inferred row whose last change (any column: brought back, or put back as it was) came from his undo or redo is
  // held as he left it.
  const lastBatch = (statusOnly: boolean) =>
    db
      .prepare(
        `SELECT b.kind FROM change_log l JOIN change_batches b ON b.id = l.batch_id
         WHERE l.entity = 'person_met_at' AND l.entity_key = ? ${statusOnly ? `AND json_extract(l.after, '$.status') IS NOT NULL` : ''}
         ORDER BY l.seq DESC LIMIT 1`,
      )
      .pluck();
  const lastStatusBatch = lastBatch(true);
  const lastChangeBatch = lastBatch(false);
  const rejectedKeys = new Map<string, Set<string>>();
  const held = new Set<string>();
  for (const [pid, rows] of existing) {
    const keys = new Set<string>();
    for (const r of rows) {
      const inferred = r.source === 'inferred';
      const undone = inferred && r.status === 'withdrawn' && lastStatusBatch.get(r.id) === 'undo';
      if (r.status === 'rejected' || undone) for (const k of targetKeys(db, r)) keys.add(k);
      if (inferred && r.status === 'active' && lastChangeBatch.get(r.id) === 'undo') held.add(r.id);
    }
    if (keys.size) rejectedKeys.set(pid, keys);
  }

  Object.assign(o.state.counts, {
    people: inputs.candidates.size,
    happenings: happenings.length,
    ...Object.fromEntries(Object.entries(inputs.stats).map(([k, v]) => [`signals_${k}`, v])),
  });
  const skips: Skips = { known: 0, named: 0, rejected: 0, performer: 0, ambiguous: 0 };
  const desires = new Map<string, MetAtDesire>();
  for (const [pid, sigs] of inputs.signals) {
    const person = inputs.candidates.get(pid);
    if (!person) continue;
    const d = derivePerson(person, sigs, {
      happenings,
      maxLen,
      knownSince: inputs.knownSince.get(pid),
      rejectedKeys: rejectedKeys.get(pid) ?? new Set(),
      performers,
      skips,
    });
    if (d) desires.set(pid, d);
  }
  Object.assign(o.state.counts, {
    skipped_known: skips.known,
    skipped_named: skips.named,
    skipped_rejected: skips.rejected,
    skipped_performer: skips.performer,
    ambiguous: skips.ambiguous,
    derived: desires.size,
  });
  yield;

  const counts: Counts = { inserted: 0, updated: 0, reactivated: 0, retargeted: 0, withdrawn: 0, brought_forward: 0, demoted: 0, batches: 0 };
  const runId = () => (o.state.runId ??= startRun(db, 'nightly', { jobRunId: o.jobRunId, now: o.now }));
  const people = [...new Set([...desires.keys(), ...existing.keys()])].sort();
  let errors = 0;
  for (const pid of people) {
    try {
      writePerson(db, pid, desires.get(pid) ?? null, existing.get(pid) ?? [], { now: o.now, runId, counts, held });
    } catch (e) {
      // One person's rows never block everyone else's (the batch rolled back); counted and logged by class only.
      errors++;
      o.log.warn('met_at.person_failed', { job: 'met-at', error_class: e instanceof Error ? e.name : 'unknown' });
    }
    Object.assign(o.state.counts, counts, { errors });
    yield;
  }
  Object.assign(o.state.counts, counts, { errors });
}

/** The nightly pass (see the module header); yields the event loop between people and stops on `signal`. */
export async function runMetAt(db: DB, o: MetAtRunOptions = {}): Promise<MetAtRunResult> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const state: RunState = { runId: null, counts: {} };
  const r = await drive(steps(db, { now, jobRunId: o.jobRunId ?? null, log, state }), { signal: o.signal });
  const counts = state.counts;
  const complete = r.complete && !counts.errors;
  if (state.runId) finishRun(db, state.runId, complete ? 'ok' : 'partial', { summary: { stage: 'met-at', ...counts }, now });
  log.info('met_at.run', { job: 'met-at', ...(state.runId ? { run_id: state.runId } : {}), counts });
  return { complete, runId: state.runId, counts };
}
