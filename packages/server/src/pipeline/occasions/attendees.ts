/**
 * Journaled attendee rows for an occasion (PLAN step 4; event_attendees rows on occasions are class J). One batch
 * (kind 'attendee') per occasion whose rows change, so each inference is undoable on its own:
 *   score ≥ 0.75 → 'going' (upcoming) / 'attended' (past), counted;  0.5–0.75 → 'possible', shown only.
 * Re-runs are idempotent (a row changes only when its status, role or source changes or its confidence moves by
 * ≥ 0.05). Decisions the agent must not redo:
 *   - 'rejected' rows (an undone insert, or the user's "wasn't there") block that person on the occasion and on
 *     every occasion merged into it;
 *   - rows from the user or legacy data are never touched, and the LLM adjudicator's only when nothing supports
 *     them any more (the person is no longer a candidate at all, e.g. a clue now belongs to another plan): then
 *     they are withdrawn like the agent's own;
 *   - a row whose last change was an undo stays as the undo left it.
 * Agent rows that lose their support are retracted with status 'withdrawn' (journaled), never deleted.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { withBatch } from '../../journal/batch';
import type { PeopleIndex } from './people';
import { COUNTED, POSSIBLE, type Signal } from './signals';
import type { AttendeeRole, PersonCandidate } from './infer';

export type AttendeeSource = 'inferred' | 'calendar_explicit' | 'calendar_text' | 'partiful';

/** Sources this pipeline writes (the older 'calendar'/'inference' spellings count as ours too). */
const AGENT_SOURCES = new Set(['inferred', 'calendar_explicit', 'calendar_text', 'partiful', 'calendar', 'inference']);
const CONF_STEP = 0.05;

export interface AttendeeRow {
  id: string;
  occasion_id: string;
  person_id: string;
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  evidence: string;
}

export interface ApplyStats {
  inserted: number;
  updated: number;
  withdrawn: number;
  blocked: number;
}

const FAMILY: Record<string, AttendeeSource> = {
  explicit: 'calendar_explicit',
  explicit_name: 'calendar_explicit',
  partiful_going: 'partiful',
  partiful_maybe: 'partiful',
  partiful_host: 'partiful',
  title_name: 'calendar_text',
  notes_name: 'calendar_text',
  pair_name: 'calendar_text',
  ticket_holder: 'calendar_text',
};
const SOURCE_RANK: Record<AttendeeSource, number> = { calendar_explicit: 3, partiful: 2, calendar_text: 1, inferred: 0 };

/** The attendee source: the family of the strongest signal (explicit > Partiful > calendar text > messages on ties). */
export function sourceOf(signals: readonly Signal[]): AttendeeSource {
  let best: { src: AttendeeSource; w: number } = { src: 'inferred', w: -1 };
  for (const s of signals) {
    const src = FAMILY[s.type] ?? 'inferred';
    if (s.weight > best.w + 1e-9 || (Math.abs(s.weight - best.w) <= 1e-9 && SOURCE_RANK[src] > SOURCE_RANK[best.src])) best = { src, w: s.weight };
  }
  return best.src;
}

/** Evidence as stored: signal types, weights and ids only (never message text). */
export const evidenceJson = (signals: readonly Signal[]): string => JSON.stringify(signals.map((s) => ({ t: s.type, w: s.weight, ...(s.m ? { m: s.m } : {}), ...(s.ref ? { ref: s.ref } : {}) })));

export interface OccasionRef {
  id: string;
  /** This occasion plus every occasion merged into it. */
  chain: string[];
  endsAt: number;
  localDate: string;
}

interface Op {
  kind: 'insert' | 'update' | 'withdraw';
  row?: AttendeeRow;
  personId: string;
  patch: Record<string, unknown>;
}

export function lastChangeWasUndo(db: DB, rowId: string): boolean {
  const kind = db
    .prepare(
      `SELECT cb.kind FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
       WHERE cl.entity = 'event_attendees' AND cl.entity_key = ? ORDER BY cl.seq DESC LIMIT 1`,
    )
    .pluck()
    .get(rowId) as string | undefined;
  return kind === 'undo';
}

/**
 * Brings the occasion's attendee rows in line with `candidates` (pass [] to withdraw everything the agent
 * inferred, e.g. when the occasion stops being social, is cancelled or was merged away). `support`: everyone the
 * pass still holds as a candidate (persons kept for the adjudicator, names' and groups' people); the adjudicator's
 * rows for anyone else are withdrawn. Without it they are left alone.
 */
export function applyAttendees(
  db: DB,
  people: PeopleIndex,
  occ: OccasionRef,
  candidates: readonly PersonCandidate[],
  o: { runId: () => string; now: number; support?: ReadonlySet<string> },
): ApplyStats {
  const stats: ApplyStats = { inserted: 0, updated: 0, withdrawn: 0, blocked: 0 };
  const rows = db
    .prepare(`SELECT id, occasion_id, person_id, status, role, source, confidence, evidence FROM event_attendees WHERE occasion_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(occ.chain)) as AttendeeRow[];
  const blocked = new Set<string>();
  const foreign = new Set<string>();
  const mine = new Map<string, AttendeeRow>();
  const stale: AttendeeRow[] = [];
  const unsupported: AttendeeRow[] = [];
  for (const r of rows) {
    const c = people.canonicalOf(r.person_id);
    if (r.status === 'rejected') blocked.add(c);
    else if (!AGENT_SOURCES.has(r.source)) {
      foreign.add(c);
      if (o.support && r.source === 'llm' && r.occasion_id === occ.id && r.status !== 'withdrawn' && !o.support.has(c)) unsupported.push(r);
    } else if (r.occasion_id === occ.id && !mine.has(c)) mine.set(c, r);
    else stale.push(r);
  }

  const ended = occ.endsAt <= o.now;
  const ops: Op[] = [];
  const targeted = new Set<string>();
  for (const c of candidates) {
    if (c.score < POSSIBLE) continue;
    if (blocked.has(c.personId)) {
      stats.blocked++;
      continue;
    }
    if (foreign.has(c.personId)) continue;
    targeted.add(c.personId);
    const status = c.score >= COUNTED ? (ended ? 'attended' : 'going') : 'possible';
    const want = { status, role: c.role satisfies AttendeeRole, source: sourceOf(c.signals), confidence: c.score, evidence: evidenceJson(c.signals) };
    const row = mine.get(c.personId);
    if (!row) {
      ops.push({ kind: 'insert', personId: c.personId, patch: want });
      continue;
    }
    const material = row.status !== want.status || row.role !== want.role || row.source !== want.source || Math.abs(row.confidence - want.confidence) >= CONF_STEP;
    if (!material || lastChangeWasUndo(db, row.id)) continue;
    ops.push({ kind: 'update', row, personId: c.personId, patch: want });
  }
  for (const [pid, row] of mine) {
    if (targeted.has(pid) || row.status === 'withdrawn' || lastChangeWasUndo(db, row.id)) continue;
    ops.push({ kind: 'withdraw', row, personId: pid, patch: { status: 'withdrawn' } });
  }
  for (const row of [...stale, ...unsupported]) {
    if (row.status === 'withdrawn' || lastChangeWasUndo(db, row.id)) continue;
    ops.push({ kind: 'withdraw', row, personId: people.canonicalOf(row.person_id), patch: { status: 'withdrawn' } });
  }
  if (!ops.length) return stats;

  const adds = ops.filter((x) => x.kind === 'insert').length;
  const title =
    adds && adds === ops.length
      ? `Found ${adds} ${adds === 1 ? 'person' : 'people'} at a get-together on ${occ.localDate}`
      : `Updated who was at a get-together on ${occ.localDate}`;
  const subjects = [...new Set(ops.map((x) => x.personId))];
  const best = Math.max(...ops.map((x) => Number(x.patch.confidence ?? 0)));
  withBatch(
    db,
    { runId: o.runId(), kind: 'attendee', title, subjectPersonId: subjects.length === 1 ? subjects[0]! : null, confidence: best > 0 ? best : null, actor: 'agent' },
    (t) => {
      for (const op of ops) {
        if (op.kind === 'insert') {
          t.insert('event_attendees', { id: uuidv7(o.now), occasion_id: occ.id, person_id: op.personId, ...op.patch, run_id: o.runId() });
          stats.inserted++;
        } else if (op.kind === 'update') {
          if (t.update('event_attendees', { id: op.row!.id }, { ...op.patch, run_id: o.runId() })) stats.updated++;
        } else if (t.update('event_attendees', { id: op.row!.id }, op.patch)) stats.withdrawn++;
      }
    },
    { now: o.now },
  );
  return stats;
}
