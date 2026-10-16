/**
 * Settings → "What I've learned" (GET /learner): per-kind propensity and 14-day trend, the wildcard hit rate per
 * generator, muted and cooled people (visible people only), and the adaptive cap. Reads only.
 */
import { addDays, localDate, SUGGESTION_KINDS, WILDCARD_GENERATORS, type LearnerState, type SuggestionKind, type WildcardGenerator } from '@yb/shared';
import type { DB } from '../../db/connection';
import { settingsSnapshot } from '../../settings/registry';
import { adaptiveCap, allPersonStates, propensityAsOf, readArm } from './learner';
import { PeopleCache } from './people';
import { armKey } from './types';

const TREND_EPS = 0.02;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const ACTED = `(s.status = 'done' OR s.acted_at IS NOT NULL OR EXISTS (SELECT 1 FROM suggestion_outcomes o WHERE o.suggestion_id = s.id AND o.effective = 1 AND o.reward >= 1))`;

export function learnerState(db: DB, now = Date.now()): LearnerState {
  const settings = settingsSnapshot(db);
  const tz = settings.tz;
  const today = localDate(now, tz);
  const since = addDays(today, -30);
  const muted = new Set(settings['learner.muted_kinds']);

  const perKind = new Map(
    (
      db
        .prepare(
          `SELECT s.kind, count(*) AS shown, sum(CASE WHEN ${ACTED} THEN 1 ELSE 0 END) AS acted
           FROM digest_items di JOIN digests d ON d.id = di.digest_id JOIN suggestions s ON s.id = di.suggestion_id
           WHERE d.local_date >= ? GROUP BY s.kind`,
        )
        .all(since) as { kind: SuggestionKind; shown: number; acted: number }[]
    ).map((r) => [r.kind, r]),
  );
  const kinds = SUGGESTION_KINDS.map((kind) => {
    const post = readArm(db, armKey.kind(kind), now);
    const old = propensityAsOf(db, armKey.kind(kind), addDays(today, -14));
    const delta = old === null ? 0 : post.mean - old;
    return {
      kind,
      alpha: r3(post.alpha),
      beta: r3(post.beta),
      propensity: r3(post.mean),
      trend: delta > TREND_EPS ? ('up' as const) : delta < -TREND_EPS ? ('down' as const) : ('flat' as const),
      trendDelta: r3(delta),
      shown30d: perKind.get(kind)?.shown ?? 0,
      acted30d: perKind.get(kind)?.acted ?? 0,
      muted: muted.has(kind),
    };
  });

  const wild = db
    .prepare(
      `SELECT r.local_date, r.wildcard_generator AS generator, ${ACTED} AS acted
       FROM digest_rankings r JOIN suggestions s ON s.id = r.wildcard_suggestion_id ORDER BY r.local_date`,
    )
    .all() as { local_date: string; generator: WildcardGenerator; acted: number }[];
  const shown = wild.length;
  const acted = wild.filter((w) => w.acted).length;
  const generators = WILDCARD_GENERATORS.map((g) => ({
    generator: g,
    propensity: r3(readArm(db, armKey.wildcard(g), now).mean),
    shown: wild.filter((w) => w.generator === g).length,
    acted: wild.filter((w) => w.generator === g && w.acted).length,
  }));

  const people = new PeopleCache(db);
  const mutedPeople: LearnerState['mutedPeople'] = [];
  const cooledPeople: LearnerState['cooledPeople'] = [];
  for (const s of allPersonStates(db)) {
    const chip = people.chip(s.personId);
    if (!chip) continue; // hidden / merged-away people never show here
    if (s.muted || s.mutedKinds.length) mutedPeople.push({ person: chip, kinds: s.muted ? [...SUGGESTION_KINDS] : s.mutedKinds, since: s.updatedAt });
    if (s.cooldownUntil !== null && s.cooldownUntil > now) cooledPeople.push({ person: chip, cooldownUntil: s.cooldownUntil, consecutiveIgnores: s.consecutiveIgnores });
  }
  cooledPeople.sort((a, b) => b.cooldownUntil - a.cooldownUntil);

  const cap = adaptiveCap(db, settings, now, tz, false);
  const updatedAt = (db.prepare('SELECT max(updated_at) FROM learner_arms').pluck().get() as number | null) ?? null;
  return {
    kinds,
    wildcard: {
      epsilon: settings['learner.wildcard_epsilon'],
      hitRate: shown ? r3(acted / shown) : null,
      shown,
      acted,
      lastShownDate: wild.at(-1)?.local_date ?? null,
      generators,
    },
    mutedPeople,
    cooledPeople,
    adaptiveCap: { current: cap.cap, lateActRate: cap.lateActRate === null ? null : r3(cap.lateActRate) },
    updatedAt,
  };
}

