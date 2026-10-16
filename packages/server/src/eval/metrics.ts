/**
 * The eval report (GET /api/v1/eval/report, `yb eval report`): metrics against the intelligence §8 targets,
 * computed from the labeled golden sets, plus automatic checks (groundedness, schema validity, refusal rate,
 * citation validity) and online signals. Counts and rates only — no names, values or message text.
 *
 *   extraction  precision per category on applied items (facts per category, interests together, commitments,
 *               needs_reply, relations, all), candidates (informational), recall (true items shown ÷ all true
 *               items: correct shown + correct-but-hidden candidates + the owner's "missing"), due date within
 *               ±1 day, groundedness (every applied claim's quotes found verbatim in the cited NEW line as sent),
 *               schema-valid and refusal rate over the last 30 days, precision by prompt_version, and the latest
 *               shadow run (agreement, worst per-category precision drop on G1, spot-check progress).
 *   identity    auto-merge pairwise precision; duplicate recall (true duplicates the system merged or flagged)
 *   reply_debt  precision / recall at the frozen time
 *   ask         recall@10 of the expected people; citation validity (kept citations that still resolve and
 *               weren't judged wrong ÷ every citation the model wrote, stripped ones included)
 *   online      digest action / dismiss / "wrong" rates, agent-action and merge undo rates (last 30 days)
 */
import type { EvalMetric, EvalReport } from '@yb/shared';
import type { DB } from '../db/connection';
import { bucketOf, matchClaims } from './match';
import { INTEREST_CATS, keyedFromStored } from './predictions';
import { latestShadowRun, shadowItems, type ShadowRunRow } from './shadowStore';
import { itemsOf } from './store';
import { SET_NAMES, type ExtractionPayload, type Item, type KeyedPrediction, type SetName, type StoredLabel } from './types';
import { DAY, HOUR, quoteGrounded, ratio, round } from './util';
import { ASK_TOP_K } from './sample/ask';

/** Targets the report scores against (intelligence §8, PLAN Phase 4 "Verify"). */
export const EVAL_TARGETS = {
  extraction: { precision: 0.9, interestPrecision: 0.85, recall: 0.7, groundedness: 0.99, schemaValid: 0.995, refusalRateMax: 0.005, dueDateWithin1d: 0.9 },
  identity: { autoMergePrecision: 0.995, duplicateRecall: 0.85 },
  replyDebt: { precision: 0.85, recall: 0.8 },
  commitments: { precision: 0.85 },
  ask: { recallAt10: 0.8, citationValidity: 1 },
  online: { digestActionRate: 0.35, dismissRateMax: 0.25, wrongRateMax: 0.03, agentUndoRateMax: 0.02, mergeUndoRateMax: 0.01 },
  /** Promotion gate for a new prompt_version (intelligence §8 "Shadow mode"). */
  shadow: { maxPrecisionDrop: 0.02, spotCheck: 20 },
} as const;

const ONLINE_WINDOW = 30 * DAY;
const ACT_WINDOW = 72 * HOUR;

export function metric(name: string, value: number | null, n: number, target: number, o: { higherIsBetter?: boolean; informational?: boolean } = {}): EvalMetric {
  const hib = o.higherIsBetter ?? true;
  const v = value === null ? null : round(value);
  return { name, value: v, target, higherIsBetter: hib, pass: o.informational || v === null ? null : hib ? v >= target - 1e-9 : v <= target + 1e-9, n };
}

type Verdict = 'correct' | 'incorrect' | 'unsure';
const verdictsOf = (label: StoredLabel | null): Map<string, Verdict> => new Map((label?.verdicts ?? []).map((v) => [v.predictionId, v.verdict]));

class Tally {
  private m = new Map<string, { ok: number; bad: number }>();
  add(key: string, v: Verdict | undefined): void {
    if (v !== 'correct' && v !== 'incorrect') return;
    let t = this.m.get(key);
    if (!t) this.m.set(key, (t = { ok: 0, bad: 0 }));
    if (v === 'correct') t.ok++;
    else t.bad++;
  }
  get(key: string): { ok: number; bad: number } {
    return this.m.get(key) ?? { ok: 0, bad: 0 };
  }
  keys(): string[] {
    return [...this.m.keys()].sort();
  }
  precision(key: string): { value: number | null; n: number } {
    const t = this.get(key);
    return { value: ratio(t.ok, t.ok + t.bad), n: t.ok + t.bad };
  }
}

/** "fact: …", "interest: …", "commitment: …", "reply: …", "relation: …" → the kind a missing item is about. */
export function missingKind(s: string): 'fact' | 'commitment' | 'needs_reply' | 'relation' | null {
  const m = /^\s*([a-z_ ]{3,20})\s*:/i.exec(s);
  if (!m) return null;
  const t = m[1]!.trim().toLowerCase().replace(/\s+/g, '_');
  if (t === 'commitment' || t === 'promise' || t === 'plan') return 'commitment';
  if (t === 'reply' || t === 'needs_reply') return 'needs_reply';
  if (t === 'relation' || t === 'relationship') return 'relation';
  if (t === 'fact' || t === 'interest' || t === 'activity_pref' || t === 'food_drink' || t.startsWith('location') || ['hometown', 'employer', 'role', 'school', 'pet', 'travel_plan', 'other', 'job', 'trip'].includes(t))
    return 'fact';
  return null;
}

// ---------------------------------------------------------------------------------------------- G1

export function extractionMetrics(db: DB, now: number): EvalMetric[] {
  const T = EVAL_TARGETS.extraction;
  const items = itemsOf(db, 'extraction', { origin: 'sample' });
  const labeled = items.filter((i) => i.label);
  const t = new Tally();
  const byVersion = new Tally();
  let truePos = 0;
  let hiddenTrue = 0;
  let missing = 0;
  const missingByKind: Record<string, number> = { fact: 0, commitment: 0, needs_reply: 0, relation: 0 };
  const truePosByKind: Record<string, number> = { fact: 0, commitment: 0, needs_reply: 0, relation: 0 };
  for (const it of labeled) {
    const v = verdictsOf(it.label);
    for (const p of it.predictions) {
      const verdict = v.get(p.id);
      if (p.kind === 'fact') {
        if (p.m.applied === false) {
          t.add('candidate', verdict);
          if (verdict === 'correct') {
            hiddenTrue++;
            missingByKind.fact!++;
          }
          continue;
        }
        t.add(`fact.${p.m.cat}`, verdict);
        t.add('facts', verdict);
        if (INTEREST_CATS.has(p.m.cat ?? '')) t.add('interest', verdict);
      } else if (p.kind === 'due_date') {
        t.add('due_date', verdict);
        continue;
      } else if (p.kind === 'commitment' || p.kind === 'needs_reply' || p.kind === 'relation') {
        t.add(p.kind, verdict);
      } else continue;
      t.add('all', verdict);
      if (it.promptVersion) byVersion.add(it.promptVersion, verdict);
      if (verdict === 'correct') {
        truePos++;
        truePosByKind[p.kind]!++;
      }
    }
    for (const s of it.label!.missing) {
      missing++;
      const k = missingKind(s);
      if (k) missingByKind[k]!++;
    }
  }

  const out: EvalMetric[] = [];
  const all = t.precision('all');
  out.push(metric('precision', all.value, all.n, T.precision));
  const facts = t.precision('facts');
  out.push(metric('precision.facts', facts.value, facts.n, T.precision));
  const interest = t.precision('interest');
  out.push(metric('precision.interest', interest.value, interest.n, T.interestPrecision));
  for (const k of t.keys().filter((x) => x.startsWith('fact.'))) {
    const cat = k.slice(5);
    const pr = t.precision(k);
    out.push(metric(`precision.fact.${cat}`, pr.value, pr.n, INTEREST_CATS.has(cat) ? T.interestPrecision : T.precision));
  }
  const kp = t.precision('commitment');
  out.push(metric('precision.commitment', kp.value, kp.n, EVAL_TARGETS.commitments.precision));
  const nr = t.precision('needs_reply');
  out.push(metric('precision.needs_reply', nr.value, nr.n, EVAL_TARGETS.replyDebt.precision));
  const rel = t.precision('relation');
  out.push(metric('precision.relation', rel.value, rel.n, T.precision));
  const cand = t.precision('candidate');
  out.push(metric('precision.candidate', cand.value, cand.n, 0.5, { informational: true }));

  const recallDen = truePos + hiddenTrue + missing;
  out.push(metric('recall', ratio(truePos, recallDen), recallDen, T.recall));
  for (const k of ['fact', 'commitment', 'needs_reply', 'relation'] as const) {
    const den = truePosByKind[k]! + missingByKind[k]!;
    out.push(metric(`recall.${k}`, ratio(truePosByKind[k]!, den), den, T.recall, { informational: true }));
  }
  const due = t.precision('due_date');
  out.push(metric('due_date_±1d', due.value, due.n, T.dueDateWithin1d));

  const g = groundedness(items);
  out.push(metric('groundedness', ratio(g.ok, g.n), g.n, T.groundedness));
  const sv = schemaValidity(db, now);
  out.push(metric('schema_valid', ratio(sv.valid, sv.n), sv.n, T.schemaValid));
  const rr = refusalRate(db, now);
  out.push(metric('refusal_rate', ratio(rr.refused, rr.n), rr.n, T.refusalRateMax, { higherIsBetter: false }));

  const versions = byVersion.keys();
  if (versions.length > 1) {
    for (const ver of versions) {
      const pr = byVersion.precision(ver);
      out.push(metric(`precision@${ver}`, pr.value, pr.n, T.precision, { informational: true }));
    }
  }
  out.push(...shadowMetrics(db));
  return out;
}

/** Every applied claim's quotes vs the cited line AS SENT (only windows that had a packet). */
export function groundedness(items: readonly Item[]): { ok: number; n: number } {
  let ok = 0;
  let n = 0;
  for (const it of items) {
    const p = it.payload as ExtractionPayload;
    if (p.kind !== 'extraction' || p.status !== 'applied') continue;
    const fresh = new Map(p.lines.filter((l) => l.role === 'new').map((l) => [l.msgId, l.body]));
    for (const pr of it.predictions) {
      if (pr.m.applied === false || !pr.m.evidence) continue;
      for (const e of pr.m.evidence) {
        if (e.quote === null) continue; // sensitive evidence keeps no quote
        n++;
        const body = fresh.get(e.msgId);
        if (body && quoteGrounded(e.quote, body)) ok++;
      }
    }
  }
  return { ok, n };
}

/** Extraction requests in the last 30 days whose output parsed (shadow replays excluded). */
export function schemaValidity(db: DB, now: number): { valid: number; n: number } {
  const r = db
    .prepare(
      `SELECT count(*) FILTER (WHERE status IN ('succeeded','applied')) AS valid, count(*) AS n FROM llm_requests
       WHERE kind IN ('extract','historical') AND status IN ('succeeded','applied','schema_invalid') AND created_at >= ?
         AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM eval_shadow_runs))`,
    )
    .get(now - ONLINE_WINDOW) as { valid: number; n: number };
  return r;
}

/** Windows that ended refused ÷ windows that got an answer (last 30 days). */
export function refusalRate(db: DB, now: number): { refused: number; n: number } {
  return db
    .prepare(
      `SELECT count(*) FILTER (WHERE status = 'refused') AS refused, count(*) AS n FROM windows
       WHERE mode IN ('steady','historical') AND status IN ('applied','refused') AND updated_at >= ?`,
    )
    .get(now - ONLINE_WINDOW) as { refused: number; n: number };
}

// ---------------------------------------------------------------------------------------------- shadow (G1 gate)

export interface ShadowSummary {
  runId: string;
  promptVersion: string;
  effort: string;
  status: string;
  windows: number;
  byStatus: Record<string, number>;
  agree: number;
  added: number;
  removed: number;
  byBucket: Record<string, { agree: number; added: number; removed: number }>;
  /** Per bucket on labeled G1 windows: baseline precision vs the replay's (matched claims inherit labels). */
  golden: Record<string, { baseline: number | null; shadow: number | null; n: number; unlabeled: number }>;
  maxPrecisionDrop: number | null;
  spotCheck: { items: number; labeled: number; addedPrecision: number | null; addedN: number; removedStillTrue: number | null; removedN: number };
  costUsd: number;
}

export function shadowSummary(db: DB, run: ShadowRunRow): ShadowSummary {
  const rows = shadowItems(db, run.id);
  const byStatus: Record<string, number> = {};
  const byBucket: Record<string, { agree: number; added: number; removed: number }> = {};
  let agree = 0;
  let added = 0;
  let removed = 0;
  const bump = (b: string, k: 'agree' | 'added' | 'removed') => {
    const x = (byBucket[b] ??= { agree: 0, added: 0, removed: 0 });
    x[k]++;
  };
  const goldenItems = new Map(itemsOf(db, 'extraction', { origin: 'sample', labeledOnly: true }).map((i) => [i.id, i]));
  const golden: Record<string, { baselineOk: number; baselineN: number; shadowOk: number; shadowN: number; unlabeled: number }> = {};
  const g = (b: string) => (golden[b] ??= { baselineOk: 0, baselineN: 0, shadowOk: 0, shadowN: 0, unlabeled: 0 });
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status !== 'ok') continue;
    const m = matchClaims(r.baseline, r.shadow);
    for (const { a } of m.pairs) {
      agree++;
      bump(bucketOf(a), 'agree');
    }
    for (const b of m.onlyB) {
      added++;
      bump(bucketOf(b), 'added');
    }
    for (const a of m.onlyA) {
      removed++;
      bump(bucketOf(a), 'removed');
    }
    // Golden windows: the replay is scored with the owner's labels on the baseline claims it matches.
    const item = r.goldenItemId ? goldenItems.get(r.goldenItemId) : undefined;
    if (!item) continue;
    const v = verdictsOf(item.label);
    const labeledClaims = item.predictions
      .filter((p) => p.m.applied !== false && (p.kind === 'fact' || p.kind === 'commitment' || p.kind === 'relation' || p.kind === 'needs_reply'))
      .map((p) => ({ k: keyedFromStored([p])[0], verdict: v.get(p.id) }))
      .filter((x): x is { k: KeyedPrediction; verdict: Verdict | undefined } => !!x.k);
    for (const x of labeledClaims) {
      if (x.verdict !== 'correct' && x.verdict !== 'incorrect') continue;
      const b = g(bucketOf(x.k));
      b.baselineN++;
      if (x.verdict === 'correct') b.baselineOk++;
    }
    const mm = matchClaims(
      labeledClaims.map((x) => ({ ...x.k, verdict: x.verdict })),
      r.shadow,
    );
    for (const { a, b } of mm.pairs) {
      const bucket = g(bucketOf(b));
      if (a.verdict !== 'correct' && a.verdict !== 'incorrect') {
        bucket.unlabeled++;
        continue;
      }
      bucket.shadowN++;
      if (a.verdict === 'correct') bucket.shadowOk++;
    }
    for (const b of mm.onlyB) g(bucketOf(b)).unlabeled++;
  }
  const goldenOut: ShadowSummary['golden'] = {};
  let maxDrop: number | null = null;
  for (const [b, x] of Object.entries(golden)) {
    const base = ratio(x.baselineOk, x.baselineN);
    const sh = ratio(x.shadowOk, x.shadowN);
    goldenOut[b] = { baseline: base === null ? null : round(base), shadow: sh === null ? null : round(sh), n: x.shadowN, unlabeled: x.unlabeled };
    if (base !== null && sh !== null) maxDrop = Math.max(maxDrop ?? -Infinity, base - sh);
  }
  // Spot-check items this run created (diff windows): precision of what the new prompt added, and how often what it
  // dropped was actually true.
  const spot = itemsOf(db, 'extraction', { origin: 'shadow', shadowRunId: run.id });
  let addOk = 0;
  let addN = 0;
  let remTrue = 0;
  let remN = 0;
  for (const it of spot) {
    const v = verdictsOf(it.label);
    for (const p of it.predictions) {
      const verdict = v.get(p.id);
      if (verdict !== 'correct' && verdict !== 'incorrect') continue;
      if (p.m.shadow === 'added') {
        addN++;
        if (verdict === 'correct') addOk++;
      } else if (p.m.shadow === 'removed') {
        remN++;
        if (verdict === 'correct') remTrue++;
      }
    }
  }
  return {
    runId: run.id,
    promptVersion: run.prompt_version,
    effort: run.effort,
    status: run.status,
    windows: rows.length,
    byStatus,
    agree,
    added,
    removed,
    byBucket,
    golden: goldenOut,
    maxPrecisionDrop: maxDrop === null ? null : round(maxDrop),
    spotCheck: {
      items: spot.length,
      labeled: spot.filter((i) => i.label).length,
      addedPrecision: ratio(addOk, addN),
      addedN: addN,
      removedStillTrue: ratio(remTrue, remN),
      removedN: remN,
    },
    costUsd: round(run.cost_usd, 4),
  };
}

function shadowMetrics(db: DB): EvalMetric[] {
  const run = latestShadowRun(db, { finishedOnly: true });
  if (!run) return [];
  const s = shadowSummary(db, run);
  const name = (k: string) => `shadow[${s.promptVersion}].${k}`;
  const union = s.agree + s.added + s.removed;
  const want = Math.min(EVAL_TARGETS.shadow.spotCheck, s.spotCheck.items);
  const goldenN = Object.values(s.golden).reduce((n, x) => n + x.n, 0);
  return [
    metric(name('agreement'), ratio(s.agree, union), union, 0.8, { informational: true }),
    metric(name('precision_drop_max'), s.maxPrecisionDrop, goldenN, EVAL_TARGETS.shadow.maxPrecisionDrop, { higherIsBetter: false }),
    metric(name('spot_check'), want ? Math.min(1, s.spotCheck.labeled / want) : null, s.spotCheck.labeled, 1),
    metric(name('precision.added'), s.spotCheck.addedPrecision, s.spotCheck.addedN, EVAL_TARGETS.extraction.precision),
  ];
}

// ---------------------------------------------------------------------------------------------- G2

export function identityMetrics(db: DB): EvalMetric[] {
  const T = EVAL_TARGETS.identity;
  let mergeOk = 0;
  let mergeN = 0;
  let reviewOk = 0;
  let reviewN = 0;
  let dupes = 0;
  let found = 0;
  for (const it of itemsOf(db, 'identity', { origin: 'sample', labeledOnly: true })) {
    const p = it.predictions[0];
    if (!p) continue;
    const verdict = verdictsOf(it.label).get(p.id);
    if (verdict !== 'correct' && verdict !== 'incorrect') continue;
    const claimSame = p.kind === 'merge' || p.kind === 'possible';
    const truthSame = claimSame === (verdict === 'correct');
    if (p.kind === 'merge') {
      mergeN++;
      if (verdict === 'correct') mergeOk++;
    } else if (p.kind === 'possible') {
      reviewN++;
      if (verdict === 'correct') reviewOk++;
    }
    if (truthSame) {
      dupes++;
      if (claimSame) found++;
    }
  }
  return [
    metric('identity.auto_merge_precision', ratio(mergeOk, mergeN), mergeN, T.autoMergePrecision),
    metric('identity.duplicate_recall', ratio(found, dupes), dupes, T.duplicateRecall),
    metric('identity.review_precision', ratio(reviewOk, reviewN), reviewN, 0.5, { informational: true }),
  ];
}

// ---------------------------------------------------------------------------------------------- G3

export function replyDebtMetrics(db: DB): EvalMetric[] {
  const T = EVAL_TARGETS.replyDebt;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let llmOk = 0;
  let llmN = 0;
  for (const it of itemsOf(db, 'reply_debt', { origin: 'sample', labeledOnly: true })) {
    const p = it.predictions[0];
    if (!p) continue;
    const verdict = verdictsOf(it.label).get(p.id);
    if (verdict !== 'correct' && verdict !== 'incorrect') continue;
    if (p.kind === 'needs_reply') {
      if (verdict === 'correct') tp++;
      else fp++;
      if (p.m.method === 'llm') {
        llmN++;
        if (verdict === 'correct') llmOk++;
      }
    } else if (verdict === 'incorrect') fn++;
  }
  return [
    metric('reply_debt.precision', ratio(tp, tp + fp), tp + fp, T.precision),
    metric('reply_debt.recall', ratio(tp, tp + fn), tp + fn, T.recall),
    metric('reply_debt.precision.llm', ratio(llmOk, llmN), llmN, T.precision, { informational: true }),
  ];
}

// ---------------------------------------------------------------------------------------------- G4

export function askMetrics(db: DB): EvalMetric[] {
  const T = EVAL_TARGETS.ask;
  const canon = db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck();
  const c = (id: string) => (canon.get(id) as string | undefined) ?? id;
  let recallSum = 0;
  let recallN = 0;
  let citeOk = 0;
  let citeN = 0;
  for (const it of itemsOf(db, 'ask', { origin: 'sample' })) {
    const v = verdictsOf(it.label);
    // recall@10 (labeled, with an expected set)
    if (it.label && it.expectedPersonIds.length) {
      const expected = new Set(it.expectedPersonIds.map(c));
      const top = new Set(
        it.predictions
          .filter((p) => p.kind === 'person' && (p.m.rank ?? Infinity) <= ASK_TOP_K && v.get(p.id) !== 'incorrect')
          .map((p) => c(p.m.personId!)),
      );
      let hit = 0;
      for (const e of expected) if (top.has(e)) hit++;
      recallSum += hit / expected.size;
      recallN++;
    }
    // citation validity (every answered item; stripped ids count against it)
    const p = it.payload;
    if (p.kind !== 'ask') continue;
    const cites = it.predictions.filter((x) => x.kind === 'citation');
    citeN += cites.length + p.violations;
    for (const ct of cites) if (v.get(ct.id) !== 'incorrect' && citationResolves(db, ct.m.cat ?? '', ct.refs[0] ?? '')) citeOk++;
  }
  return [metric('ask.recall@10', recallN ? recallSum / recallN : null, recallN, T.recallAt10), metric('ask.citation_validity', ratio(citeOk, citeN), citeN, T.citationValidity)];
}

/** Whether a cited id still points at something Ask may show ('m:<b36>', 'F<b36>', 'E<b36>', people). */
export function citationResolves(db: DB, kind: string, ref: string): boolean {
  const n = (s: string) => {
    const x = parseInt(s, 36);
    return Number.isSafeInteger(x) && x > 0 && /^[0-9a-z]+$/i.test(s) ? x : null;
  };
  if (kind === 'message') {
    const id = n(ref.replace(/^m:/, ''));
    return id !== null && db.prepare('SELECT 1 FROM messages WHERE id = ? AND retracted_at IS NULL').pluck().get(id) !== undefined;
  }
  if (kind === 'fact') {
    const seq = n(ref.replace(/^F/, ''));
    return (
      seq !== null &&
      db.prepare(`SELECT 1 FROM facts WHERE seq = ? AND status IN ('tentative','confirmed') AND retracted_at IS NULL`).pluck().get(seq) !== undefined
    );
  }
  if (kind === 'event') {
    const d = n(ref.replace(/^E/, ''));
    return d !== null && db.prepare('SELECT 1 FROM ask_fts_docs WHERE n = ?').pluck().get(d) !== undefined;
  }
  return kind === 'person';
}

// ---------------------------------------------------------------------------------------------- online

export function onlineMetrics(db: DB, now: number): EvalMetric[] {
  const T = EVAL_TARGETS.online;
  const since = now - ONLINE_WINDOW;
  const d = db
    .prepare(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE status = 'done' OR acted_at IS NOT NULL) AS acted,
              count(*) FILTER (WHERE status = 'dismissed') AS dismissed,
              count(*) FILTER (WHERE status = 'wrong') AS wrong
       FROM suggestions WHERE delivered_at IS NOT NULL AND delivered_at >= ? AND delivered_at <= ?`,
    )
    .get(since, now - ACT_WINDOW) as { n: number; acted: number; dismissed: number; wrong: number };
  const agent = db
    .prepare(`SELECT count(*) AS n, count(undone_at) AS undone FROM change_batches WHERE actor = 'agent' AND undoable = 1 AND created_at >= ?`)
    .get(since) as { n: number; undone: number };
  const merges = db
    .prepare(`SELECT count(*) AS n, count(undone_at) AS undone FROM merges WHERE method IN ('deterministic','probabilistic','llm_tiebreak') AND created_at >= ?`)
    .get(since) as { n: number; undone: number };
  return [
    metric('digest_action_rate', ratio(d.acted, d.n), d.n, T.digestActionRate),
    metric('dismiss_rate', ratio(d.dismissed, d.n), d.n, T.dismissRateMax, { higherIsBetter: false }),
    metric('wrong_rate', ratio(d.wrong, d.n), d.n, T.wrongRateMax, { higherIsBetter: false }),
    metric('agent_undo_rate', ratio(agent.undone, agent.n), agent.n, T.agentUndoRateMax, { higherIsBetter: false }),
    metric('merge_undo_rate', ratio(merges.undone, merges.n), merges.n, T.mergeUndoRateMax, { higherIsBetter: false }),
  ];
}

// ---------------------------------------------------------------------------------------------- report

const SET_METRICS: Record<SetName, (db: DB, now: number) => EvalMetric[]> = {
  extraction: extractionMetrics,
  identity: (db) => identityMetrics(db),
  reply_debt: (db) => replyDebtMetrics(db),
  ask: (db) => askMetrics(db),
};

export function buildReport(db: DB, o: { now?: number; sets?: readonly SetName[] } = {}): EvalReport {
  const now = o.now ?? Date.now();
  const sets = (o.sets ?? SET_NAMES).map((set) => ({
    set,
    labeled: db.prepare(`SELECT count(*) FROM eval_items WHERE set_name = ? AND origin = 'sample' AND label IS NOT NULL`).pluck().get(set) as number,
    metrics: SET_METRICS[set](db, now),
  }));
  const versions = new Set<string>([
    ...(db.prepare(`SELECT DISTINCT prompt_version FROM eval_items WHERE prompt_version IS NOT NULL`).pluck().all() as string[]),
    ...(db.prepare(`SELECT DISTINCT prompt_version FROM eval_shadow_runs`).pluck().all() as string[]),
  ]);
  return { generatedAt: now, sets, online: onlineMetrics(db, now), promptVersions: [...versions].sort() };
}
