/**
 * The nightly suggestions stage (job 'suggestions', after ties/obligations/intel, before compose):
 *
 *   1. every registered generator emits candidates → validated (canonical, visible people, never a record of mine
 *      (identity/self.ts); finite base) and upserted into `suggestions` by dedupe key; candidates no longer emitted
 *      are superseded, expired ones expire;
 *   2. 🎲 wildcard sources propose candidates (stored only if picked);
 *   3. eligibility: kind mutes (setting learner.muted_kinds), person mutes, the person ignore-cooldown
 *      (7 d × 2^n, cap 90), per-(person, kind) / per-subject cooldowns, max showings, intro rate limits
 *      (≤1 per 3 days, ≤4 per 30 days); time-critical items skip only the ignore-cooldown;
 *   4. score = base × w_kind × θ_kind × θ_bucket × θ_person (× θ_wild) × (1 + 0.3·priority) × fatigue
 *      (×0.5 if the person was in a digest in the last 3 days), with one seeded Thompson sample per arm;
 *   5. the ranker picks (forced, greedy + diversity, floor/relax, adaptive cap 3–5, maybe one wildcard);
 *   6. today's digest row (status 'composing', rng_seed, item_cap) + digest_items, the picked rows 'selected'
 *      with their factors, and the showing cooldowns — all in one transaction; compose writes the copy later.
 * One ranking per local day (a rerun the same day is a no-op). The event loop gets a turn between generators.
 * Nothing here sends anything, and nothing here writes a journaled table.
 */
import { addDays, localDate, uuidv7, type SuggestionKind, type WildcardGenerator } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { selfPeople } from '../../identity/self';
import { finishRun, startRun } from '../../journal/runs';
import { nullLogger, errorFields, type Logger } from '../../ops/logger';
import { settingsSnapshot, type SettingsSnapshot } from '../../settings/registry';
import { adaptiveCap, armsFor, ArmSampler, personState, sampleFactors, snapshotArms, type ArmRef, type ScoredFactors } from './learner';
import { PeopleCache, shortName } from './people';
import { rankDetailed, type DetailedRankResult } from './ranker';
import { allGenerators, allWildcardSources } from './registry';
import { newSeed, stream } from './rng';
import {
  blockingScopes,
  cooldownUntil,
  insertWildcardRow,
  liveRow,
  normalizeCandidate,
  pruneCooldowns,
  setCooldown,
  showingScopes,
  showingsOf,
  upsertCandidate,
  type SuggestionRow,
} from './store';
import {
  KIND_POLICY,
  SELECTION,
  suggestionDedupeKey,
  type Candidate,
  type CandidateGenerator,
  type GeneratorContext,
  type Ranker,
  type ScoredCandidate,
  type WildcardSource,
} from './types';

const DAY = 86_400_000;
const INTRO_MIN_GAP_DAYS = 3;
const INTRO_MAX_PER_30D = 4;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface StageOptions {
  now?: number;
  jobRunId?: number | null;
  /** Fixed RNG seed (tests, replays); default a fresh random seed, stored with the digest. */
  seed?: number;
  log?: Logger;
  signal?: AbortSignal;
  generators?: CandidateGenerator[];
  wildcardSources?: WildcardSource[];
  /** Replaces the default ranker (tests). */
  ranker?: Ranker;
}

export interface StageResult {
  status: 'ok' | 'skipped' | 'partial';
  reason: 'already_ranked' | 'digest_closed' | 'aborted' | null;
  localDate: string;
  digestId: string | null;
  runId: string | null;
  seed: number | null;
  cap: number | null;
  selectedIds: string[];
  wildcardId: string | null;
  stats: Record<string, number>;
}

interface Scored extends ScoredCandidate {
  factorDetails: ScoredFactors;
  /** What an outcome of this item trains. */
  arms: ArmRef[];
  adjustments: { fatigue: boolean; priority: boolean; weight: number };
  stored: boolean;
}

/** Person ids that appeared in a digest over the `days` local days before `today`. */
function recentDigestPeople(db: DB, today: string, days: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT s.person_ids FROM digest_items di JOIN digests d ON d.id = di.digest_id JOIN suggestions s ON s.id = di.suggestion_id
       WHERE d.local_date >= ? AND d.local_date < ?`,
    )
    .pluck()
    .all(addDays(today, -days), today) as string[];
  return new Set(rows.flatMap((r) => JSON.parse(r) as string[]));
}

function hadWildcard(db: DB, date: string): boolean {
  return !!db.prepare('SELECT 1 FROM digest_rankings WHERE local_date = ? AND wildcard_suggestion_id IS NOT NULL').pluck().get(date);
}

function introCounts(db: DB, now: number): { last3d: number; last30d: number } {
  const q = db.prepare(`SELECT count(*) FROM suggestions WHERE kind = 'intro' AND selected_at >= ?`).pluck();
  return { last3d: q.get(now - INTRO_MIN_GAP_DAYS * DAY) as number, last30d: q.get(now - 30 * DAY) as number };
}

export async function runSuggestionsStage(db: DB, o: StageOptions = {}): Promise<StageResult> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const settings: SettingsSnapshot = settingsSnapshot(db);
  const timeZone = settings.tz;
  const today = localDate(now, timeZone);
  const stats: Record<string, number> = {};
  const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
  const result = (r: Partial<StageResult> & Pick<StageResult, 'status'>): StageResult => ({
    reason: null,
    localDate: today,
    digestId: null,
    runId: null,
    seed: null,
    cap: null,
    selectedIds: [],
    wildcardId: null,
    stats,
    ...r,
  });

  if (db.prepare('SELECT 1 FROM digest_rankings WHERE local_date = ?').pluck().get(today)) return result({ status: 'skipped', reason: 'already_ranked' });
  // Delivery writes an empty placeholder when the ranker is late (downtime, a slow night). Nothing went out for it,
  // so a late ranking takes it over instead of losing the day's brief.
  takeOverPlaceholder(db, today);
  const existing = db.prepare('SELECT id, status FROM digests WHERE local_date = ?').get(today) as { id: string; status: string } | undefined;
  if (existing && existing.status !== 'composing') return result({ status: 'skipped', reason: 'digest_closed', digestId: existing.id });

  const runId = startRun(db, 'nightly', { jobRunId: o.jobRunId ?? null, now });
  const seed = o.seed ?? newSeed();
  const ctx: GeneratorContext = { db, now, timeZone, settings, runId, log, ...(o.signal ? { signal: o.signal } : {}) };
  const aborted = () => !!o.signal?.aborted;
  const finishAborted = () => {
    finishRun(db, runId, 'partial', { summary: { stage: 'suggestions', aborted: 1, ...stats }, now });
    return result({ status: 'partial', reason: 'aborted', runId, seed });
  };

  try {
    // Records of the owner (me, merged into me, holding my handles) never become anyone's suggestion.
    const self = selfPeople(db);
    // 1. generators → stored candidates
    const okKinds = new Set<SuggestionKind>();
    for (const g of o.generators ?? allGenerators()) {
      if (aborted()) return finishAborted();
      let raw: Candidate[] = [];
      try {
        raw = await g.generate(ctx);
        okKinds.add(g.kind);
      } catch (e) {
        bump('generatorErrors');
        log.warn('suggestions.generator_failed', { job: 'suggestions', run_id: runId, error_code: g.kind, ...errorFields(e) });
        continue;
      }
      tx(db, () => {
        for (const c of raw) {
          const n = normalizeCandidate(db, c, now, self);
          if (!n) {
            bump('dropped');
            continue;
          }
          upsertCandidate(db, n, runId, now);
          bump('emitted');
          bump(`emitted_${n.kind}`);
        }
      });
      await yieldToLoop();
    }
    tx(db, () => {
      const kinds = [...okKinds];
      if (kinds.length) {
        stats.superseded = db
          .prepare(
            `UPDATE suggestions SET status = 'superseded', updated_at = ?
             WHERE status IN ('candidate','snoozed') AND coalesce(last_seen_run, '') <> ? AND kind IN (${kinds.map(() => '?').join(',')})`,
          )
          .run(now, runId, ...kinds).changes;
      }
      stats.expired = db
        .prepare(`UPDATE suggestions SET status = 'expired', updated_at = ? WHERE status IN ('candidate','snoozed') AND expires_at IS NOT NULL AND expires_at <= ?`)
        .run(now, now).changes;
    });

    // 2. regular pool: rows this run emitted that can be shown again
    const rows = db
      .prepare(
        `SELECT * FROM suggestions WHERE last_seen_run = ? AND status IN ('candidate','selected','delivered')
           AND (expires_at IS NULL OR expires_at > ?) ORDER BY dedupe_key`,
      )
      .all(runId, now) as SuggestionRow[];
    const regular: { id: string; c: Candidate }[] = rows.map((r) => ({
      id: r.id,
      c: {
        kind: r.kind,
        personIds: JSON.parse(r.person_ids) as string[],
        subjectKey: r.subject_key ?? r.dedupe_key.slice(r.kind.length + 1),
        base: r.base_score ?? 0,
        evidenceIds: JSON.parse(r.evidence_ids) as string[],
        expiresAt: r.expires_at,
        timeCritical: r.time_critical === 1,
        sensitive: r.sensitive === 1,
        links: {
          eventId: r.event_id,
          occasionId: r.occasion_id,
          circleId: r.circle_id,
          commitmentId: r.commitment_id,
          replyDebtId: r.reply_debt_id,
          tripId: r.trip_id,
          relatedPersonId: r.related_person_id,
        },
        payload: JSON.parse(r.signals) as Candidate['payload'],
      },
    }));

    // 🎲 pool
    const wildRng = stream(seed, 2);
    const wild: { id: string; stored: boolean; c: Candidate; g: WildcardGenerator }[] = [];
    for (const s of o.wildcardSources ?? allWildcardSources()) {
      if (aborted()) return finishAborted();
      try {
        const seen = new Set<string>();
        for (const raw of await s.generate(ctx, wildRng)) {
          const n = normalizeCandidate(db, raw, now, self);
          if (!n) continue;
          const key = suggestionDedupeKey(n);
          if (seen.has(key)) continue;
          seen.add(key);
          const live = liveRow(db, key);
          if (live && !['candidate', 'selected', 'delivered'].includes(live.status)) continue;
          wild.push({ id: live?.id ?? uuidv7(now), stored: !!live, c: n, g: s.generator });
        }
      } catch (e) {
        bump('wildcardErrors');
        log.warn('suggestions.wildcard_failed', { job: 'suggestions', run_id: runId, error_code: s.generator, ...errorFields(e) });
      }
      await yieldToLoop();
    }
    stats.wildcardPool = wild.length;

    // 3. eligibility
    const mutedKinds = new Set(settings['learner.muted_kinds']);
    const intros = introCounts(db, now);
    const eligible = (c: Candidate): string | null => {
      if (mutedKinds.has(c.kind)) return 'muted';
      for (const p of c.personIds) {
        const ps = personState(db, p);
        if (ps.muted || ps.mutedKinds.includes(c.kind)) return 'muted';
        if (!c.timeCritical && ps.cooldownUntil !== null && ps.cooldownUntil > now) return 'ignore_cooldown';
      }
      const cd = cooldownUntil(db, blockingScopes(c));
      if (cd !== null && cd > now) return 'cooldown';
      const max = KIND_POLICY[c.kind].maxShowings;
      if (max !== null && showingsOf(db, suggestionDedupeKey(c)) >= max) return 'max_showings';
      if (c.kind === 'intro' && (intros.last3d >= 1 || intros.last30d >= INTRO_MAX_PER_30D)) return 'intro_rate';
      return null;
    };

    // 4. scoring
    const people = new PeopleCache(db);
    const circleName = db.prepare('SELECT name FROM circles WHERE id = ?').pluck();
    const sampler = new ArmSampler(db, now, stream(seed, 0), settings['learner.enabled']);
    const fatigued = recentDigestPeople(db, today, SELECTION.fatigueDays);
    const score = (id: string, c: Candidate, g: WildcardGenerator | null, stored: boolean): Scored => {
      const primary = c.personIds[0] ? people.get(c.personIds[0]) : null;
      const f = sampleFactors(
        sampler,
        c.kind,
        primary,
        primary ? shortName(primary) : null,
        g,
        (cid) => (circleName.get(cid) as string | undefined) ?? null,
        c.links?.circleId ?? null,
      );
      const fatigue = c.personIds.some((p) => fatigued.has(p));
      const priority = !!primary?.isPriority;
      const weight = KIND_POLICY[c.kind].weight;
      const s =
        c.base * weight * f.kind * f.bucket * f.person * f.wildcard * (priority ? 1 + SELECTION.priorityBoost : 1) * (fatigue ? SELECTION.fatigueFactor : 1);
      return {
        ...c,
        suggestionId: id,
        score: Number.isFinite(s) ? s : 0,
        factors: { kind: f.kind, bucket: f.bucket, person: f.person, wildcard: f.wildcard },
        isWildcard: g !== null,
        wildcardGenerator: g,
        factorDetails: f,
        arms: armsFor(c.kind, primary, g, c.links?.circleId ?? null),
        adjustments: { fatigue, priority, weight },
        stored,
      };
    };
    const scored: Scored[] = [];
    let i = 0;
    for (const r of regular) {
      const why = eligible(r.c);
      if (why) {
        bump(`skip_${why}`);
        continue;
      }
      scored.push(score(r.id, r.c, null, true));
      if (++i % 200 === 0) await yieldToLoop();
    }
    for (const w of wild) if (!eligible(w.c)) scored.push(score(w.id, w.c, w.g, w.stored));
    stats.eligible = scored.filter((s) => !s.isWildcard).length;

    // 5. rank
    const cap = adaptiveCap(db, settings, now, timeZone).cap;
    const wildcardYesterday = hadWildcard(db, addDays(today, -1));
    const rankCtx = { ...ctx, rng: stream(seed, 1), seed, cap, wildcardYesterday };
    const ranked: DetailedRankResult = o.ranker
      ? { ...rankDetailed([], { ...rankCtx, rng: () => 1 }), ...o.ranker.rank(scored, rankCtx) }
      : rankDetailed(scored, rankCtx);
    if (aborted()) return finishAborted();

    // 6. write
    const byId = new Map(scored.map((s) => [s.suggestionId, s]));
    const written = tx(db, () => {
      db.prepare(
        `INSERT INTO digests (id, local_date, run_id, status, rng_seed, item_cap) VALUES (?, ?, ?, 'composing', ?, ?)
         ON CONFLICT(local_date) DO UPDATE SET run_id = excluded.run_id, rng_seed = excluded.rng_seed, item_cap = excluded.item_cap
         WHERE digests.status = 'composing'`,
      ).run(existing?.id ?? uuidv7(now), today, runId, seed, cap);
      const id = db.prepare('SELECT id FROM digests WHERE local_date = ?').pluck().get(today) as string;
      db.prepare('DELETE FROM digest_items WHERE digest_id = ?').run(id);

      // scores of everything considered (for the history list), then the picks
      const upd = db.prepare('UPDATE suggestions SET score = ?, learned_factors = ?, updated_at = ? WHERE id = ?');
      for (const s of scored) if (s.stored && !s.isWildcard) upd.run(s.score, factorsJson(s), now, s.suggestionId);

      const pickStmt = db.prepare(
        `UPDATE suggestions SET status = 'selected', score = ?, base_score = ?, learned_factors = ?, rank_details = ?, selected_at = ?,
           digest_id = ?, showings = showings + 1, is_wildcard = ?, wildcard_generator = ?, cooldown_until = ?, run_id = ?,
           decided_at = NULL, delivered_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('candidate','selected','delivered')`,
      );
      const item = db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, ?, ?)');
      const picked: string[] = [];
      for (const sel of ranked.selected) {
        // The ranker hands back the scored objects themselves (a regular item and its 🎲 twin share an id).
        const s = (sel as Scored).arms ? (sel as Scored) : byId.get(sel.suggestionId)!;
        if (s.isWildcard && !s.stored) insertWildcardRow(db, s.suggestionId, s, runId, now);
        const idx = picked.length;
        const scopes = showingScopes(s);
        const until = scopes.length ? Math.max(...scopes.map((x) => now + x.days * DAY)) : null;
        const d = ranked.details.get(s.suggestionId);
        const details = {
          ordinal: idx + 1,
          forced: d?.forced ?? false,
          penalized: d?.penalized ?? false,
          relaxedFloor: d?.relaxedFloor ?? false,
          merged: d?.merged ?? [],
          fatigue: s.adjustments.fatigue,
          priority: s.adjustments.priority,
          weight: s.adjustments.weight,
          cap,
          seed,
          learnerEnabled: settings['learner.enabled'],
        };
        const changed = pickStmt.run(
          s.score,
          s.base,
          factorsJson(s),
          JSON.stringify(details),
          now,
          id,
          s.isWildcard ? 1 : 0,
          s.wildcardGenerator,
          until,
          runId,
          now,
          s.suggestionId,
        ).changes;
        // Feedback (done / wrong / snooze, a text command, the rewards job) landed while the stage was yielding:
        // that decision stands and the item stays out of today's digest.
        if (!changed) {
          bump('decidedMeanwhile');
          continue;
        }
        picked.push(s.suggestionId);
        item.run(id, idx + 1, s.suggestionId);
        for (const x of scopes) setCooldown(db, x.scope, now + x.days * DAY, 'shown', now);
      }
      db.prepare(
        `INSERT INTO digest_rankings (digest_id, local_date, run_id, seed, cap, wildcard_allowed, wildcard_roll, wildcard_suggestion_id,
           wildcard_generator, considered, selected_count, ranked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        today,
        runId,
        seed,
        cap,
        ranked.wildcardAllowed ? 1 : 0,
        ranked.wildcardRoll,
        ranked.wildcard && picked.includes(ranked.wildcard.suggestionId) ? ranked.wildcard.suggestionId : null,
        ranked.wildcard && picked.includes(ranked.wildcard.suggestionId) ? ranked.wildcard.wildcardGenerator : null,
        JSON.stringify(ranked.considered),
        picked.length,
        now,
      );
      return { id, picked };
    });
    const pickedIds = written.picked;
    stats.selected = pickedIds.length;
    stats.wildcard = ranked.wildcard ? 1 : 0;
    stats.merged = ranked.merged;
    stats.cap = cap;

    snapshotArms(db, now, timeZone);
    stats.cooldownsPruned = pruneCooldowns(db, now);
    finishRun(db, runId, 'ok', { summary: { stage: 'suggestions', ...stats }, now });
    log.info('suggestions.ranked', { job: 'suggestions', run_id: runId, counts: stats });
    return result({
      status: 'ok',
      digestId: written.id,
      runId,
      seed,
      cap,
      selectedIds: pickedIds,
      wildcardId: ranked.wildcard && pickedIds.includes(ranked.wildcard.suggestionId) ? ranked.wildcard.suggestionId : null,
    });
  } catch (e) {
    finishRun(db, runId, 'error', { summary: { stage: 'suggestions', ...stats }, now });
    throw e;
  }
}

/**
 * A late ranking takes over delivery's placeholder: an empty 'skipped' row (skip_reason 'empty') with no items, no
 * ranking and nothing sent for it (no digest, notice or heartbeat text). It goes back to 'composing'.
 */
export function takeOverPlaceholder(db: DB, localDay: string): boolean {
  return (
    db
      .prepare(
        `UPDATE digests SET status = 'composing', skip_reason = NULL, imessage_status = NULL, push_status = NULL, delivery_checked_at = NULL,
           composed_at = NULL, imessage_text = NULL, web_body = NULL
         WHERE local_date = ? AND status = 'skipped' AND skip_reason = 'empty' AND sent_at IS NULL AND push_sent_at IS NULL
           AND outbound_id IS NULL AND notice_outbound_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM digest_items di WHERE di.digest_id = digests.id)
           AND NOT EXISTS (SELECT 1 FROM digest_rankings dr WHERE dr.digest_id = digests.id)`,
      )
      .run(localDay).changes > 0
  );
}

/** learned_factors JSON: the four factors, the arms the item trains (and their weights), and the per-arm detail. */
function factorsJson(s: Scored): string {
  return JSON.stringify({ ...s.factors, arms: s.arms, details: s.factorDetails.details });
}
