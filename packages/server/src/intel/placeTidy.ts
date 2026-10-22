/**
 * Place facts as place names, for what was stored before extraction wrote them that way (intel/placeNames.ts).
 * One journal batch per run, so the activity feed's undo takes the whole tidy back.
 *
 *   agent facts (job places-tidy, daily before the extraction submit): live location_current / location_next /
 *     hometown / home_location facts the agent inferred (source 'llm') get their place name ("LA" → "Los Angeles,
 *     CA"); the ones that name no place ("lives with you", "Bay Area", "France") are closed as not a fact; two that
 *     now say the same place for one person fold into the better one (evidence moves, like consolidation).
 *   owner data (job places-tidy-owner, MANUAL ONLY, after the owner said yes): facts the owner entered (legacy
 *     Blackbook, `log:`, Contacts) and the owner's Places collections are renamed the same way. Anything of the
 *     owner's that names no place ("Australia") is left exactly as it is, and a collection is never renamed onto
 *     another one's name.
 * planPlaceTidy is read-only (dry runs); applyPlaceTidy writes the plan.
 */
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { normValue } from '../extraction/text';
import { withBatch } from '../journal/batch';
import { finishRun, startRun } from '../journal/runs';
import { PLACE_FACT_TYPES, placeName } from './placeNames';

/** Facts the owner entered; never closed by a tidy, renamed only in the owner run. */
export const OWNER_FACT_SOURCES = ['legacy', 'user_log', 'user', 'addressbook'] as const;
const isOwnerSource = (source: string) => (OWNER_FACT_SOURCES as readonly string[]).includes(source);

export interface PlaceTidyFact {
  id: string;
  personId: string;
  type: string;
  source: string;
  from: string;
  /** rename: the place name · merge: the place name of the fact it folds into · retire / keep: null. */
  to: string | null;
  action: 'rename' | 'merge' | 'retire' | 'keep';
  /** merge: the fact it folds into. */
  into?: string;
}

export interface PlaceTidyCollection {
  id: string;
  from: string;
  to: string | null;
  action: 'rename' | 'keep';
}

export interface PlaceTidyPlan {
  owner: boolean;
  facts: PlaceTidyFact[];
  collections: PlaceTidyCollection[];
}

export interface PlaceTidyStats {
  renamed: number;
  merged: number;
  retired: number;
  /** Owner data that names no place (left alone). */
  kept: number;
  collectionsRenamed: number;
  collectionsKept: number;
  batchId: string | null;
}

interface Row {
  id: string;
  person_id: string;
  canonical: string;
  type: string;
  value: string;
  value_norm: string;
  source: string;
  status: string;
  support: number;
  confidence: number;
  created_at: number;
}

const RANK: Record<string, number> = { candidate: 0, tentative: 1, confirmed: 2 };

/** Which fact of several saying the same place stays: the owner's, then shown over hidden, support, confidence, age. */
const better = (a: Row, b: Row) =>
  Number(isOwnerSource(b.source)) - Number(isOwnerSource(a.source)) ||
  (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) ||
  b.support - a.support ||
  b.confidence - a.confidence ||
  a.created_at - b.created_at;

/** What a tidy would change (read-only). `owner`: the owner's own facts and collections instead of the agent's. */
export function planPlaceTidy(db: DB, o: { owner?: boolean } = {}): PlaceTidyPlan {
  const owner = o.owner ?? false;
  const rows = db
    .prepare(
      `SELECT f.id, f.person_id, coalesce(pc.canonical_id, f.person_id) AS canonical, f.type, f.value, f.value_norm, f.source, f.status,
              f.support, f.confidence, f.created_at
       FROM facts f LEFT JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE f.type IN (SELECT value FROM json_each(?)) AND f.status IN ('candidate','tentative','confirmed')
         AND f.retracted_at IS NULL AND f.superseded_at IS NULL
       ORDER BY f.created_at, f.seq`,
    )
    .all(JSON.stringify([...PLACE_FACT_TYPES])) as Row[];
  const inScope = (r: Row) => (owner ? isOwnerSource(r.source) : r.source === 'llm');

  const facts: PlaceTidyFact[] = [];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const place = placeName(r.value);
    if (!place) {
      if (inScope(r)) facts.push({ id: r.id, personId: r.canonical, type: r.type, source: r.source, from: r.value, to: null, action: owner ? 'keep' : 'retire' });
      continue;
    }
    // Every live fact joins its group (an owner fact can absorb an agent duplicate); only in-scope ones change.
    const key = `${r.canonical}|${r.type}|${place.name}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const name = key.slice(key.lastIndexOf('|') + 1);
    const keep = [...group].sort(better)[0]!;
    for (const r of group) {
      if (!inScope(r)) continue;
      if (r.id !== keep.id) facts.push({ id: r.id, personId: r.canonical, type: r.type, source: r.source, from: r.value, to: name, action: 'merge', into: keep.id });
      else if (r.value !== name) facts.push({ id: r.id, personId: r.canonical, type: r.type, source: r.source, from: r.value, to: name, action: 'rename' });
    }
  }

  const collections: PlaceTidyCollection[] = [];
  if (owner) {
    const locs = db.prepare(`SELECT id, name FROM locations WHERE status = 'active' ORDER BY created_at, id`).all() as { id: string; name: string }[];
    const taken = new Set(locs.map((l) => l.name.trim().toLowerCase()));
    for (const l of locs) {
      const to = placeName(l.name)?.name ?? null;
      if (to === l.name) continue;
      if (!to || taken.has(to.toLowerCase())) {
        collections.push({ id: l.id, from: l.name, to: null, action: 'keep' });
        continue;
      }
      taken.add(to.toLowerCase());
      collections.push({ id: l.id, from: l.name, to, action: 'rename' });
    }
  }
  return { owner, facts, collections };
}

/** The feed line: "Wrote places as place names: 12 renamed, 2 duplicates folded, 9 that weren't places closed". */
function titleOf(plan: PlaceTidyPlan): string {
  const n = (a: PlaceTidyFact['action']) => plan.facts.filter((f) => f.action === a).length;
  const renamedCollections = plan.collections.filter((c) => c.action === 'rename').length;
  const parts = [
    n('rename') ? `${n('rename')} renamed` : '',
    n('merge') ? `${n('merge')} duplicates folded` : '',
    n('retire') ? `${n('retire')} that weren't places closed` : '',
    renamedCollections ? `${renamedCollections} Places collections renamed` : '',
  ].filter(Boolean);
  return `${plan.owner ? 'Wrote your places as place names' : 'Wrote places as place names'}: ${parts.join(', ')}`;
}

/** Writes a plan as one journal batch in `runId` (no batch when nothing changes). */
export function applyPlaceTidy(db: DB, plan: PlaceTidyPlan, o: { runId: string; now: number }): PlaceTidyStats {
  const stats: PlaceTidyStats = { renamed: 0, merged: 0, retired: 0, kept: 0, collectionsRenamed: 0, collectionsKept: 0, batchId: null };
  for (const f of plan.facts) if (f.action === 'keep') stats.kept++;
  for (const c of plan.collections) if (c.action === 'keep') stats.collectionsKept++;
  if (!plan.facts.some((f) => f.action !== 'keep') && !plan.collections.some((c) => c.action === 'rename')) return stats;
  const moveEvidence = db.prepare(
    `INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote)
     SELECT 'fact', ?, message_id, quote FROM evidence WHERE subject_type = 'fact' AND subject_id = ?`,
  );
  const evidenceCount = db.prepare(`SELECT count(*) FROM evidence WHERE subject_type = 'fact' AND subject_id = ?`).pluck();
  const live = db.prepare(
    `SELECT value, support, source FROM facts WHERE id = ? AND status IN ('candidate','tentative','confirmed') AND superseded_at IS NULL AND retracted_at IS NULL`,
  );
  type LiveRow = { value: string; support: number; source: string };
  return tx(db, () => {
    const r = withBatch(
      db,
      { runId: o.runId, kind: 'fact', title: titleOf(plan), actor: 'agent' },
      (t) => {
        const keeps = new Set<string>();
        for (const f of plan.facts) {
          // The plan may be stale (a dry run, then extraction applied): only rows still live as planned change.
          const row = live.get(f.id) as LiveRow | undefined;
          if (!row || row.value !== f.from) continue;
          if (f.action === 'rename') {
            t.update('facts', { id: f.id }, { value: f.to, value_norm: normValue(f.to!, f.type) });
            stats.renamed++;
          } else if (f.action === 'merge') {
            // An owner fact that absorbs an agent duplicate stays exactly as the owner left it (no evidence or support).
            const into = live.get(f.into) as LiveRow | undefined;
            if (into && (plan.owner || !isOwnerSource(into.source))) {
              moveEvidence.run(f.into, f.id);
              keeps.add(f.into!);
            }
            t.update('facts', { id: f.id }, { status: 'invalidated', superseded_at: o.now, superseded_by: f.into });
            stats.merged++;
          } else if (f.action === 'retire') {
            t.update('facts', { id: f.id }, { status: 'invalidated', superseded_at: o.now });
            stats.retired++;
          }
        }
        for (const id of keeps) {
          const row = live.get(id) as LiveRow | undefined;
          if (row) t.update('facts', { id }, { support: Math.max(row.support, evidenceCount.get(id) as number) });
        }
        for (const c of plan.collections) {
          if (c.action !== 'rename') continue;
          if (t.update('locations', { id: c.id }, { name: c.to })) stats.collectionsRenamed++;
        }
      },
      { now: o.now },
    );
    stats.batchId = r.changes ? r.batchId : null;
    return stats;
  });
}

/** Plans and applies one tidy in its own run (the jobs). */
export function tidyPlaces(db: DB, o: { now: number; owner?: boolean; jobRunId?: number | null }): PlaceTidyStats {
  const plan = planPlaceTidy(db, { owner: o.owner });
  const runId = startRun(db, 'system', { now: o.now, jobRunId: o.jobRunId ?? null });
  try {
    const stats = applyPlaceTidy(db, plan, { runId, now: o.now });
    finishRun(db, runId, 'ok', { now: o.now, summary: { ...stats, batchId: undefined } as Record<string, unknown> });
    return stats;
  } catch (e) {
    finishRun(db, runId, 'error', { now: o.now });
    throw e;
  }
}
