/**
 * GET /today?date=YYYY-MM-DD → TodayResponse (@yb/shared api/today.ts). Default date: today in the `tz` setting.
 *
 * Built from read models other modules own, in screen order:
 *   digest      the day's `digests` row (delivery/preview todayDigestOf), with the live channel state for a digest
 *               that hasn't gone out yet ("texting off", "not set up") and why it wouldn't send (delivery/send);
 *   items       the ranker's picks with the composer's stored copy when it is current, else template copy (never
 *               spends: no LLM call happens here);
 *   openLoops   counts + the most pressing few (pipeline/obligations todayOpenLoops);
 *   checkThese  agent batches of the last 7 days the owner should look over: probabilistic / LLM merges and
 *               lower-confidence links, attendees and labels (not undone);
 *   alerts      open alerts (messages carry no personal data; masked anyway);
 *   activity    the latest agent run and the last 24 h of agent changes by family.
 *
 * Serving today's cards is an impression: each card shown here gets one 'seen' feedback row per showing, which
 * starts its reward window (pipeline/suggestions/rewards). Nothing else is written. People come through
 * person_visible only (hidden or merged-away people's items are dropped by the selection).
 */
import { Router } from 'express';
import {
  localDate,
  TodayQuery,
  type ActivityCounts,
  type ActivitySummary,
  type Alert,
  type ChannelDelivery,
  type CheckThisItem,
  type DigestItem,
  type TodayDigest,
  type TodayResponse,
} from '@yb/shared';
import type { DB } from '../db/connection';
import { composeSelection, compositionCurrent, storedComposition, toDigestItems } from '../delivery/compose';
import { todayDigestOf } from '../delivery/preview';
import { pushDeviceCount } from '../delivery/push';
import { readDigestSelection, type DigestSelection } from '../delivery/selection';
import { whyNotSent } from '../delivery/send';
import { lastNightLine } from '../delivery/status';
import type { BatchRow } from '../journal/undo';
import { todayOpenLoops } from '../pipeline/obligations';
import { recordImpressions } from '../pipeline/suggestions/rewards';
import { resolveServices, type AgentServices } from '../services';
import { settingsSnapshot } from '../settings/registry';
import { listAlerts } from './alerts';
import type { RouteDeps } from './index';

const DAY = 86_400_000;
/** "Check these": how far back, and the confidence below which an agent change is worth a second look. */
export const CHECK_THESE_DAYS = 7;
export const CHECK_THESE_MAX_CONFIDENCE = 0.9;
const CHECK_THESE_LIMIT = 30;
const CHECK_KINDS = ['merge', 'attach_identity', 'attendee', 'edge_label', 'create_person'] as const;

const FINAL = new Set(['sent', 'fallback_sent', 'failed', 'skipped']);

/** The header state, with the live channel situation for a digest that hasn't gone out yet. */
export function liveTodayDigest(db: DB, services: Pick<AgentServices, 'outbound' | 'push'>, sel: DigestSelection, now: number, itemCount: number): TodayDigest {
  const d = sel.digest;
  const base = todayDigestOf(d);
  if (FINAL.has(d.status)) return base;
  const s = settingsSnapshot(db);
  const imessage: ChannelDelivery =
    base.imessage !== 'pending' ? base.imessage : !s['digest.enabled'] ? 'disabled' : !services.outbound.configured || !s.self_handles.length ? 'not_configured' : 'pending';
  const push: ChannelDelivery =
    base.push !== 'pending' ? base.push : !s['push.enabled'] ? 'disabled' : !services.push.configured || pushDeviceCount(db) === 0 ? 'not_configured' : 'pending';
  const reason = d.skip_reason ?? whyNotSent(db, services.outbound.configured, { localDate: d.local_date, now, itemCount, digest: d });
  return { ...base, imessage, push, skipReason: reason };
}

/** The day's digest cards: the stored copy when it matches the current picks, else template copy. */
async function cards(db: DB, services: Pick<AgentServices, 'llm' | 'egress'>, sel: DigestSelection, date: string, now: number): Promise<DigestItem[]> {
  if (!sel.items.length) return [];
  const composed =
    (compositionCurrent(sel) || sel.digest.sent_at ? storedComposition(sel) : null) ??
    (await composeSelection(db, services, sel, { localDate: date, now, useLlm: false }));
  return toDigestItems(db, composed.items);
}

// ---------------------------------------------------------------------------------------------- check these

interface MergeEvidence {
  p?: number;
  families?: string[];
  counts?: { shared_groups?: number; shared_events?: number };
}

const FAMILY: Record<string, string> = { name: 'name', handle: 'IG handle', self_id: 'self-intro', context: 'same city' };

function mergeReason(method: string, score: number | null, rawEvidence: string | null): string {
  let ev: MergeEvidence = {};
  try {
    ev = rawEvidence ? (JSON.parse(rawEvidence) as MergeEvidence) : {};
  } catch {
    ev = {};
  }
  const parts: string[] = [];
  for (const f of ev.families ?? []) {
    if (f !== 'graph') {
      if (FAMILY[f]) parts.push(FAMILY[f]!);
      continue;
    }
    const g = ev.counts?.shared_groups ?? 0;
    const e = ev.counts?.shared_events ?? 0;
    if (g) parts.push(`${g} shared group${g === 1 ? '' : 's'}`);
    if (e) parts.push(`${e} shared event${e === 1 ? '' : 's'}`);
    if (!g && !e) parts.push('shared friends');
  }
  const p = ev.p ?? score;
  const how = method === 'llm_tiebreak' ? 'Claude tie-break' : 'Merged';
  const on = parts.length ? ` on ${parts.join(' + ')}` : '';
  return `${how}${on}${p != null ? ` (p ${p.toFixed(2)})` : ''}`;
}

const KIND_REASON: Record<string, string> = {
  attach_identity: 'Linked an account',
  attendee: 'Guessed who was there',
  edge_label: 'Read a relationship from messages',
  create_person: 'Added a new person',
};

/** Agent changes of the last 7 days worth a second look (not undone, undoable), least sure first. */
export function checkThese(db: DB, now: number): CheckThisItem[] {
  const rows = db
    .prepare(
      `SELECT cb.*, (SELECT count(*) FROM change_log cl WHERE cl.batch_id = cb.id) AS change_count,
              m.method AS merge_method, m.score AS merge_score, m.evidence AS merge_evidence
       FROM change_batches cb
       LEFT JOIN merges m ON m.batch_id = cb.id AND m.undone_at IS NULL
       WHERE cb.actor = 'agent' AND cb.undone_at IS NULL AND cb.undoable = 1 AND cb.created_at >= ?
         AND cb.kind IN (SELECT value FROM json_each(?))
         AND (m.method IN ('probabilistic','llm_tiebreak') OR (cb.kind <> 'merge' AND cb.confidence IS NOT NULL AND cb.confidence < ?))
       ORDER BY coalesce(cb.confidence, m.score, 1), cb.seq DESC LIMIT ?`,
    )
    .all(now - CHECK_THESE_DAYS * DAY, JSON.stringify(CHECK_KINDS), CHECK_THESE_MAX_CONFIDENCE, CHECK_THESE_LIMIT) as (BatchRow & {
    change_count: number;
    merge_method: string | null;
    merge_score: number | null;
    merge_evidence: string | null;
  })[];
  // A batch about someone now hidden stays out of view (hidden people never appear outside Settings → Hidden).
  const canon = db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck();
  const vis = db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck();
  const visible = (id: string) => !!vis.get((canon.get(id) as string | undefined) ?? id);
  return rows
    .filter((b) => !b.subject_person_id || visible(b.subject_person_id))
    .map((b) => ({
      batch: {
        id: b.id,
        seq: b.seq,
        kind: b.kind,
        title: b.title,
        subjectPersonId: b.subject_person_id,
        confidence: b.confidence,
        actor: b.actor,
        undoable: b.undoable === 1,
        createdAt: b.created_at,
        undoneAt: b.undone_at,
        undoneByBatchId: b.undone_by_batch_id,
        revertsBatchId: b.reverts_batch_id,
        changeCount: b.change_count,
      },
      reason:
        b.kind === 'merge' && b.merge_method
          ? mergeReason(b.merge_method, b.merge_score, b.merge_evidence)
          : `${KIND_REASON[b.kind] ?? 'Changed something'}${b.confidence != null ? ` (p ${b.confidence.toFixed(2)})` : ''}`,
    }));
}

// ---------------------------------------------------------------------------------------------- activity

/** Agent changes in [since, until) by family (not undone). Facts and labels count rows; the rest count batches. */
export function agentChangeCounts(db: DB, since: number, until: number): ActivityCounts {
  const out: ActivityCounts = { merges: 0, links: 0, facts: 0, edges: 0, circles: 0, other: 0 };
  const batches = db
    .prepare(`SELECT kind, count(*) AS n FROM change_batches WHERE actor = 'agent' AND undone_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY kind`)
    .all(since, until) as { kind: string; n: number }[];
  const rows = db
    .prepare(
      `SELECT cl.entity, count(*) AS n FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
       WHERE cb.actor = 'agent' AND cb.undone_at IS NULL AND cb.created_at >= ? AND cb.created_at < ? AND cl.op = 'insert'
         AND cl.entity IN ('facts','edge_labels')
       GROUP BY cl.entity`,
    )
    .all(since, until) as { entity: string; n: number }[];
  for (const b of batches) {
    if (b.kind === 'merge') out.merges += b.n;
    else if (b.kind === 'attach_identity') out.links += b.n;
    else if (b.kind === 'circle') out.circles += b.n;
    else if (b.kind !== 'fact' && b.kind !== 'edge_label' && b.kind !== 'extraction') out.other += b.n;
  }
  for (const r of rows) {
    if (r.entity === 'facts') out.facts += r.n;
    else out.edges += r.n;
  }
  return out;
}

export function activitySummary(db: DB, now: number): ActivitySummary {
  const run = db
    .prepare(
      `SELECT r.id, r.kind, r.status, r.started_at, r.finished_at,
              (SELECT count(*) FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id WHERE cb.run_id = r.id) AS change_count
       FROM runs r WHERE r.kind IN ('nightly','weekly','ingest','import')
         AND EXISTS (SELECT 1 FROM change_batches cb WHERE cb.run_id = r.id AND cb.actor = 'agent')
       ORDER BY r.started_at DESC LIMIT 1`,
    )
    .get() as { id: string; kind: string; status: string; started_at: number; finished_at: number | null; change_count: number } | undefined;
  const last24h = agentChangeCounts(db, now - DAY, now + 1);
  return {
    lastRun: run
      ? { id: run.id, kind: run.kind, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, changeCount: run.change_count }
      : null,
    last24h,
    line: lastNightLine({ merges: last24h.merges, links: last24h.links, facts: last24h.facts }),
  };
}

// ---------------------------------------------------------------------------------------------- today

export async function todayView(db: DB, services: AgentServices, o: { date?: string; now: number }): Promise<TodayResponse> {
  const s = settingsSnapshot(db);
  const today = localDate(o.now, s.tz);
  const date = o.date ?? today;
  const sel = readDigestSelection(db, { localDate: date, now: o.now });
  const items = sel ? await cards(db, services, sel, date, o.now) : [];
  const digest = sel ? liveTodayDigest(db, services, sel, o.now, items.length) : null;
  if (date === today && items.length) {
    recordImpressions(
      db,
      items.filter((i) => i.status === 'selected' || i.status === 'delivered').map((i) => i.suggestionId),
      { now: o.now, channel: 'web' },
    );
  }
  const alerts: Alert[] = listAlerts(db, 'open');
  return {
    date,
    generatedAt: o.now,
    digest,
    items,
    allClear: !!digest && digest.status !== 'composing' && items.length === 0,
    openLoops: todayOpenLoops(db, { now: o.now, timeZone: s.tz }),
    checkThese: checkThese(db, o.now),
    alerts,
    activity: activitySummary(db, o.now),
  };
}

export function todayRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const r = Router();
  r.get('/today', async (req, res) => {
    const q = TodayQuery.parse(req.query);
    res.json((await todayView(db, resolveServices(deps), { date: q.date, now: Date.now() })) satisfies TodayResponse);
  });
  return r;
}
