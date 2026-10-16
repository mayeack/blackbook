/**
 * Merges are pointers (architecture §4): the merged person gets merged_into_id = survivor and person_canon is
 * rebuilt. No child row moves. Display fields on the survivor are filled only where empty (never names), as
 * journaled updates, so undo restores them exactly.
 */
import { uuidv7 } from '@yb/shared';
import { canonicalId, canonicalMembers, rebuildPersonCanon } from '../db/canon';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { withBatch, type Actor } from '../journal/batch';

export type MergeMethod = 'deterministic' | 'probabilistic' | 'llm_tiebreak' | 'user' | 'legacy' | 'migration';

export type MergeRefusal = 'not_found' | 'same_person' | 'suppressed' | 'me_mismatch' | 'do_not_merge' | 'priority_absorbed';

export class MergeRefusedError extends Error {
  constructor(
    readonly reason: MergeRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'MergeRefusedError';
  }
}

interface PersonRow {
  id: string;
  display_name: string;
  kind: string;
  status: string;
  company: string | null;
  job_title: string | null;
  birthday: string | null;
  family_details: string | null;
  photo_path: string | null;
  custom: string | null;
  is_hidden: number;
  is_priority: number;
  locked_fields: string;
  created_at: number;
}

/** Scalars filled from the merged person when empty on the survivor (ContactMergeService.swift:43-68). */
const FILL_EMPTY = ['company', 'job_title', 'birthday', 'family_details', 'photo_path'] as const;

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const getPerson = (db: DB, id: string) => db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined;
const PROBABILISTIC: ReadonlySet<MergeMethod> = new Set(['probabilistic', 'llm_tiebreak']);

/**
 * True if a do_not_merge pair spans the two canonical sets, i.e. {canon(x), canon(y)} = {a, b} for some
 * do_not_merge(x, y). This makes the block transitive through earlier merges.
 */
export function doNotMergeApplies(db: DB, a: string, b: string): boolean {
  const sa = JSON.stringify(canonicalMembers(db, canonicalId(db, a)));
  const sb = JSON.stringify(canonicalMembers(db, canonicalId(db, b)));
  const hit = db
    .prepare(
      `SELECT 1 FROM do_not_merge
       WHERE (a_id IN (SELECT value FROM json_each(@sa)) AND b_id IN (SELECT value FROM json_each(@sb)))
          OR (a_id IN (SELECT value FROM json_each(@sb)) AND b_id IN (SELECT value FROM json_each(@sa)))
       LIMIT 1`,
    )
    .get({ sa, sb });
  return hit !== undefined;
}

export interface MergeInput {
  survivorId: string;
  mergedId: string;
  method: MergeMethod;
  runId: string;
  actor: Actor;
  score?: number | null;
  /** Evidence summary for the feed and "why" (ids/counts, not raw handles). */
  evidence?: unknown;
  confidence?: number | null;
  title?: string;
  now?: number;
}

export interface MergeResult {
  batchId: string;
  mergeId: string;
  survivorId: string;
  mergedId: string;
}

/** Merges two people (resolved to their canonical roots) inside one journaled batch. Refusals throw. */
export function mergePeople(db: DB, input: MergeInput): MergeResult {
  return tx(db, () => {
    if (!getPerson(db, input.survivorId) || !getPerson(db, input.mergedId)) {
      throw new MergeRefusedError('not_found', 'Unknown person.');
    }
    const survivorId = canonicalId(db, input.survivorId);
    const mergedId = canonicalId(db, input.mergedId);
    if (survivorId === mergedId) throw new MergeRefusedError('same_person', 'These are already the same person.');
    const s = getPerson(db, survivorId)!;
    const m = getPerson(db, mergedId)!;
    if (s.status === 'suppressed' || m.status === 'suppressed') {
      throw new MergeRefusedError('suppressed', 'A suppressed person cannot be merged.');
    }
    if ((s.kind === 'me') !== (m.kind === 'me')) throw new MergeRefusedError('me_mismatch', 'Only your own records can merge into you.');
    if (PROBABILISTIC.has(input.method) && (m.is_priority || m.is_hidden) && !(s.is_priority || s.is_hidden)) {
      throw new MergeRefusedError('priority_absorbed', 'A priority or hidden person is never absorbed probabilistically.');
    }
    if (doNotMergeApplies(db, survivorId, mergedId)) {
      throw new MergeRefusedError('do_not_merge', 'These people were marked as different (do-not-merge).');
    }

    const now = input.now ?? Date.now();
    const mergeId = uuidv7(now);
    const { batchId } = withBatch(
      db,
      {
        runId: input.runId,
        kind: 'merge',
        title: input.title ?? `Merged ${m.display_name} into ${s.display_name}`,
        subjectPersonId: survivorId,
        confidence: input.confidence ?? input.score ?? null,
        actor: input.actor,
      },
      (t) => {
        t.insert('merges', {
          id: mergeId,
          survivor_id: survivorId,
          merged_id: mergedId,
          method: input.method,
          score: input.score ?? null,
          evidence: input.evidence === undefined ? null : JSON.stringify(input.evidence),
          batch_id: t.batchId,
          created_at: now,
        });
        t.update('people', { id: mergedId }, { merged_into_id: survivorId, status: 'merged' });
        const fill = survivorFill(s, m);
        if (Object.keys(fill).length) t.update('people', { id: survivorId }, fill);
      },
      { now },
    );
    rebuildPersonCanon(db);
    return { batchId, mergeId, survivorId, mergedId };
  });
}

/** Fill-empty-only patch for the survivor; never names, never locked fields; custom fields union (survivor wins). */
export function survivorFill(s: PersonRow, m: PersonRow): Record<string, unknown> {
  const locked = new Set(JSON.parse(s.locked_fields || '[]') as string[]);
  const patch: Record<string, unknown> = {};
  for (const f of FILL_EMPTY) {
    if (!locked.has(f) && isEmpty(s[f]) && !isEmpty(m[f])) patch[f] = m[f];
  }
  if (!locked.has('custom') && m.custom) {
    const merged = { ...(JSON.parse(m.custom) as object), ...(s.custom ? (JSON.parse(s.custom) as object) : {}) };
    const next = JSON.stringify(merged);
    if (next !== (s.custom ?? null) && Object.keys(merged).length) patch.custom = next;
  }
  return patch;
}

/**
 * How much a person carries, summed over its canonical set (port of ContactDeduplicationService.swift:147-168):
 * interactions×3, notes×2, commitments, tags, circles, events, phones+emails+addresses, photo +5,
 * tie strength/10, recency bonus (≤3, last 30 days), age bonus (years since created).
 */
export function dataRichness(db: DB, personId: string, now = Date.now()): number {
  const canonical = canonicalId(db, personId);
  const members = JSON.stringify(canonicalMembers(db, canonical));
  const one = (sql: string) => Number(db.prepare(sql).pluck().get(members) ?? 0);
  const inSet = 'IN (SELECT value FROM json_each(?))';
  const interactions = one(`SELECT count(*) FROM interactions WHERE retracted_at IS NULL AND person_id ${inSet}`);
  const notes = one(`SELECT count(*) FROM notes WHERE status = 'active' AND person_id ${inSet}`);
  const commitments = one(`SELECT count(*) FROM commitments WHERE status <> 'retracted' AND person_id ${inSet}`);
  const tags = one(`SELECT count(DISTINCT tag_id) FROM person_tags WHERE person_id ${inSet}`);
  const circles = one(`SELECT count(DISTINCT circle_id) FROM circle_members WHERE excluded = 0 AND person_id ${inSet}`);
  const events = one(`SELECT count(*) FROM event_attendees WHERE status <> 'rejected' AND person_id ${inSet}`);
  const fields =
    one(`SELECT count(*) FROM identities WHERE kind IN ('phone','email') AND status = 'active' AND person_id ${inSet}`) +
    one(`SELECT count(*) FROM facts WHERE type = 'address' AND status IN ('tentative','confirmed') AND person_id ${inSet}`);
  const photo = one(`SELECT count(*) FROM people WHERE photo_path IS NOT NULL AND id ${inSet}`) > 0 ? 5 : 0;
  const tie = Number(db.prepare('SELECT tie_strength FROM person_stats WHERE person_id = ?').pluck().get(canonical) ?? 0);
  const last = db.prepare(`SELECT max(started_at) FROM interactions WHERE retracted_at IS NULL AND person_id ${inSet}`).pluck().get(members) as
    | number
    | null;
  const recency = last ? Math.max(0, 30 - (now - last) / 86_400_000) / 10 : 0;
  const createdAt = Number(db.prepare('SELECT created_at FROM people WHERE id = ?').pluck().get(canonical));
  const age = Math.max(0, (now - createdAt) / 86_400_000) / 365;
  return interactions * 3 + notes * 2 + commitments + tags + circles + events + fields + photo + tie / 10 + recency + age;
}

/**
 * Picks the survivor of a pair: "me" first, then priority/hidden (G7: never absorbed), then richer data,
 * then the older record, then the smaller id (deterministic).
 */
export function chooseSurvivor(db: DB, aId: string, bId: string, now = Date.now()): { survivorId: string; mergedId: string } {
  const a = getPerson(db, canonicalId(db, aId))!;
  const b = getPerson(db, canonicalId(db, bId))!;
  const rank = (p: PersonRow) => [p.kind === 'me' ? 1 : 0, p.is_priority || p.is_hidden ? 1 : 0, dataRichness(db, p.id, now), -p.created_at];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i]! > rb[i]! ? { survivorId: a.id, mergedId: b.id } : { survivorId: b.id, mergedId: a.id };
  }
  return a.id < b.id ? { survivorId: a.id, mergedId: b.id } : { survivorId: b.id, mergedId: a.id };
}
