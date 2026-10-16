/**
 * The per-person consolidation pass (intelligence §4.1 "Backfill windows"): one request per person with ≥8
 * shown facts after the historical backfill (batched), or on demand for one person (synchronous,
 * consolidatePerson). The model dedupes and normalizes the facts and writes a 2-sentence person summary; code
 * validates every id, applies merges / invalidations through the journal and stores the summary locally.
 * Sensitive facts are never sent and never touched.
 */
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { withBatch } from '../journal/batch';
import { startRun, finishRun } from '../journal/runs';
import { estimatePromptTokens, estimateRouteUsd, resolveRoute, type RouteParams } from '../llm/models';
import type { BudgetPool, Egress, LlmClient } from '../llm/types';
import { buildEnv, cardFirstName, localStamp, type Env } from './env';
import { CONSOLIDATION_PROMPT_VERSION, CONSOLIDATION_SYSTEM, CONSOLIDATION_SYSTEM_TOKENS, estimateTokens } from './prompt';
import { Consolidation } from './schema';
import { isLifeEventText, isSensitiveText, lineText, looksLikeIdentifier, normValue, truncateAtSentence } from './text';

export const CONSOLIDATE_MIN_FACTS = 8;
export const CONSOLIDATE_MAX_FACTS = 80;

export interface ConsolidationRequest {
  personId: string;
  userText: string;
  aliases: Record<string, { factId: string; cat: string }>;
  factCount: number;
  tokens: number;
}

interface LiveFact {
  id: string;
  type: string;
  value: string;
  value_norm: string;
  support: number;
  status: string;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
}

function liveFacts(db: DB, personId: string): LiveFact[] {
  return db
    .prepare(
      `SELECT f.id, f.type, f.value, f.value_norm, f.support, f.status, f.valid_from, f.valid_to, f.created_at FROM facts f
       JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE pc.canonical_id = ? AND f.status IN ('tentative','confirmed') AND f.superseded_at IS NULL AND f.retracted_at IS NULL AND f.sensitive = 0
       ORDER BY f.type, f.support DESC, f.created_at LIMIT ?`,
    )
    .all(personId, CONSOLIDATE_MAX_FACTS) as LiveFact[];
}

/** People with at least `min` shown, non-sensitive facts (canonical ids). */
export function consolidationCandidates(db: DB, min = CONSOLIDATE_MIN_FACTS): string[] {
  return db
    .prepare(
      `SELECT pc.canonical_id FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id JOIN people p ON p.id = pc.canonical_id
       WHERE f.status IN ('tentative','confirmed') AND f.superseded_at IS NULL AND f.retracted_at IS NULL AND f.sensitive = 0
         AND p.kind = 'person' AND p.is_hidden = 0
       GROUP BY pc.canonical_id HAVING count(*) >= ? ORDER BY pc.canonical_id`,
    )
    .pluck()
    .all(min) as string[];
}

/** The request for one person, or null when they have fewer than `min` facts or must not reach the model. */
export function buildConsolidation(env: Env, egress: Egress, personId: string, o: { min?: number } = {}): ConsolidationRequest | null {
  const id = env.canonical(personId);
  if (!env.usable(id)) return null;
  const facts = liveFacts(env.db, id);
  if (facts.length < (o.min ?? CONSOLIDATE_MIN_FACTS)) return null;
  const p = env.person(id)!;
  const token = egress.tokenFor(id);
  const aliases: ConsolidationRequest['aliases'] = {};
  const sections: { name: string; text: string }[] = [{ name: 'name', text: cardFirstName(p) ?? '' }];
  const ev = env.db.prepare(
    `SELECT min(m.sent_at) AS first, max(m.sent_at) AS last FROM evidence e JOIN messages m ON m.id = e.message_id WHERE e.subject_type = 'fact' AND e.subject_id = ?`,
  );
  facts.forEach((f, i) => {
    const alias = `F${i + 1}`;
    aliases[alias] = { factId: f.id, cat: f.type };
    const span = ev.get(f.id) as { first: number | null; last: number | null };
    const bits = [`support ${f.support}`];
    if (span.first) bits.push(`first ${localStamp(span.first, env.tz).slice(0, 10)}`);
    if (span.last) bits.push(`last ${localStamp(span.last, env.tz).slice(0, 10)}`);
    if (f.valid_from) bits.push(`from ${localStamp(f.valid_from, env.tz).slice(0, 10)}`);
    if (f.valid_to) bits.push(`to ${localStamp(f.valid_to, env.tz).slice(0, 10)}`);
    sections.push({ name: alias, text: `${lineText(f.value, 120)} · ${bits.join(' · ')}` });
  });
  const pz = egress.pseudonymize({ purpose: 'consolidate', sections, people: [{ personId: id, firstName: p.firstName, lastName: p.lastName }] });
  const out = new Map(pz.sections.map((s) => [s.name, s.text]));
  const lines = facts.map((f, i) => `F${i + 1} ${f.type}: ${out.get(`F${i + 1}`) ?? ''}`);
  const name = out.get('name');
  const userText = `as_of=${localStamp(env.now, env.tz).slice(0, 10)}\nperson: ${token}${name ? ` ${name}` : ''}\nFACTS:\n${lines.join('\n')}`;
  return { personId: id, userText, aliases, factCount: facts.length, tokens: estimateTokens(userText) };
}

export interface ConsolidationStats {
  merged: number;
  invalidated: number;
  renamed: number;
  summary: number;
  dropped: number;
  batchId: string | null;
}

/** Validates the answer against the request's aliases and applies it (one journal batch + the summary row). */
export function applyConsolidation(
  ctx: { env: Env; egress: Egress; runId: string; now: number; promptVersion?: string },
  req: ConsolidationRequest,
  c: Consolidation,
): ConsolidationStats {
  const db = ctx.env.db;
  const pv = ctx.promptVersion ?? CONSOLIDATION_PROMPT_VERSION;
  const stats: ConsolidationStats = { merged: 0, invalidated: 0, renamed: 0, summary: 0, dropped: 0, batchId: null };
  const live = (factId: string) =>
    db.prepare(`SELECT 1 FROM facts WHERE id = ? AND status IN ('tentative','confirmed') AND superseded_at IS NULL AND retracted_at IS NULL`).pluck().get(factId) !== undefined;
  return tx(db, () => {
    const touched = new Set<string>();
    const r = withBatch(
      db,
      { runId: ctx.runId, kind: 'fact', title: 'Tidied up what I know about someone', subjectPersonId: req.personId, actor: 'agent' },
      (t) => {
        for (const m of c.merges) {
          const keep = req.aliases[m.keep.trim()];
          if (!keep || touched.has(keep.factId) || !live(keep.factId)) {
            stats.dropped++;
            continue;
          }
          const drops = [...new Set(m.drop.map((d) => req.aliases[d.trim()]).filter((d): d is NonNullable<typeof d> => !!d))].filter(
            (d) => d.factId !== keep.factId && d.cat === keep.cat && !touched.has(d.factId) && live(d.factId),
          );
          if (drops.length !== m.drop.length) stats.dropped += m.drop.length - drops.length;
          for (const d of drops) {
            db.prepare(
              `INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote)
               SELECT 'fact', ?, message_id, quote FROM evidence WHERE subject_type = 'fact' AND subject_id = ?`,
            ).run(keep.factId, d.factId);
            t.update('facts', { id: d.factId }, { status: 'invalidated', superseded_at: ctx.now, superseded_by: keep.factId, prompt_version: pv });
            touched.add(d.factId);
            stats.merged++;
          }
          const patch: Record<string, unknown> = {
            support: db.prepare(`SELECT count(*) FROM evidence WHERE subject_type = 'fact' AND subject_id = ?`).pluck().get(keep.factId) as number,
            prompt_version: pv,
          };
          const value = m.value ? lineText(m.value, 200).trim() : '';
          if (value && value.length <= 60 && !looksLikeIdentifier(value) && !isLifeEventText(value) && !isSensitiveText(value)) {
            patch.value = ctx.egress.detokenize(value, {}).slice(0, 200);
            patch.value_norm = normValue(value, keep.cat);
            stats.renamed++;
          }
          if (drops.length || patch.value) t.update('facts', { id: keep.factId }, patch);
          touched.add(keep.factId);
        }
        for (const inv of c.invalidate) {
          const f = req.aliases[inv.fact.trim()];
          if (!f || touched.has(f.factId) || !live(f.factId)) {
            stats.dropped++;
            continue;
          }
          t.update('facts', { id: f.factId }, { status: 'invalidated', superseded_at: ctx.now, prompt_version: pv });
          touched.add(f.factId);
          stats.invalidated++;
        }
      },
      { now: ctx.now },
    );
    stats.batchId = r.changes ? r.batchId : null;
    let summary = truncateAtSentence(lineText(c.summary, 2000), 400);
    const sentences = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
    summary = sentences.slice(0, 2).join(' ');
    if (summary && !looksLikeIdentifier(summary) && !isLifeEventText(summary) && !isSensitiveText(summary)) {
      const display = ctx.egress.detokenize(summary, {});
      db.prepare(
        `INSERT INTO person_summaries (person_id, summary, fact_count, prompt_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (person_id) DO UPDATE SET summary = excluded.summary, fact_count = excluded.fact_count,
           prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`,
      ).run(req.personId, display, req.factCount, pv, ctx.now, ctx.now);
      stats.summary = 1;
    } else if (summary) stats.dropped++;
    return stats;
  });
}

export type ConsolidateOutcome =
  | { status: 'ok'; stats: ConsolidationStats }
  | { status: 'skipped'; reason: 'too_few_facts' | 'not_usable' }
  | { status: 'unavailable'; reason: string }
  | { status: 'refused' | 'invalid' | 'max_tokens' };

/**
 * "Consolidate person": one synchronous call (route extract_consolidate) for one person. `min` defaults to 3 for on-demand use
 * (the backfill uses 8). Degrades to 'unavailable' without a key or budget; nothing changes then.
 */
export async function consolidatePerson(
  deps: { db: DB; llm: LlmClient; egress: Egress; now?: () => number; runId?: string },
  personId: string,
  o: { pool?: BudgetPool; min?: number } = {},
): Promise<ConsolidateOutcome> {
  const now = deps.now?.() ?? Date.now();
  const pool = o.pool ?? 'steady';
  const spend = deps.llm.canSpend(pool);
  if (!spend.ok) return { status: 'unavailable', reason: spend.reason };
  const env = buildEnv(deps.db, now);
  if (!env.usable(env.canonical(personId))) return { status: 'skipped', reason: 'not_usable' };
  const req = buildConsolidation(env, deps.egress, personId, { min: o.min ?? 3 });
  if (!req) return { status: 'skipped', reason: 'too_few_facts' };
  const out = await deps.llm.parse({
    kind: 'consolidate',
    route: 'extract_consolidate',
    subjectRef: req.personId,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    system: CONSOLIDATION_SYSTEM,
    messages: [{ role: 'user', content: req.userText }],
    pool,
    estimateUsd: estimateConsolidationUsd(req.tokens, 'sync', deps.llm.params('extract_consolidate')),
    schema: Consolidation,
    runId: deps.runId ?? null,
  });
  if (out.status === 'unavailable') return { status: 'unavailable', reason: out.reason };
  if (out.status !== 'ok') return { status: out.status };
  const ownRun = !deps.runId;
  const runId = deps.runId ?? startRun(deps.db, 'system', { now });
  try {
    const stats = applyConsolidation({ env, egress: deps.egress, runId, now }, req, out.value);
    if (ownRun) finishRun(deps.db, runId, 'ok', { now, summary: { ...stats, batchId: undefined } as Record<string, unknown> });
    return { status: 'ok', stats };
  } catch (e) {
    if (ownRun) finishRun(deps.db, runId, 'error', { now });
    throw e;
  }
}

/** Estimate for one consolidation request (`tokens` from the 4-chars packing count) on `params`' model. */
export function estimateConsolidationUsd(tokens: number, mode: 'sync' | 'batch', params: RouteParams = resolveRoute('extract_consolidate')): number {
  return estimateRouteUsd(params, { userTokens: estimatePromptTokens(tokens * 4), systemTokens: CONSOLIDATION_SYSTEM_TOKENS, mode });
}

/** The stored 2-sentence summary for a person (any id of a merged person), or null. */
export function personSummary(db: DB, personId: string): { summary: string; updatedAt: number; promptVersion: string } | null {
  const row = db
    .prepare(
      `SELECT s.summary, s.updated_at, s.prompt_version FROM person_summaries s
       WHERE s.person_id = (SELECT canonical_id FROM person_canon WHERE person_id = ?) OR s.person_id = ? ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .get(personId, personId) as { summary: string; updated_at: number; prompt_version: string } | undefined;
  return row ? { summary: row.summary, updatedAt: row.updated_at, promptVersion: row.prompt_version } : null;
}
