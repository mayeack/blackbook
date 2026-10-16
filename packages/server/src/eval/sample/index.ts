/**
 * Golden-set sampling: builds a set (or tops it up to its target size) from the local database. Items are
 * snapshots: what the system said at sampling time, so the labels keep measuring the same predictions.
 *
 *   sampleSet(db, set, o)          explicit (yb eval sample)
 *   ensureSampled(db, sets, now)   lazy (GET /eval/items): an empty set is sampled at most hourly, a short one
 *                                  topped up at most daily, so the labeling page fills as data arrives
 */
import type { DB } from '../../db/connection';
import { EVAL_SET_TARGET_SIZES, existingRefs, insertItems, recordSample, sampleState, setCounts } from '../store';
import type { SetName } from '../types';
import { DAY, HOUR } from '../util';
import { sampleAsk } from './ask';
import { sampleContext, type SampleContext, type SampleResult } from './context';
import { sampleExtraction } from './extraction';
import { sampleIdentity } from './identity';
import { sampleReplyDebt } from './replyDebt';

const SAMPLERS: Record<SetName, (c: SampleContext) => Promise<SampleResult>> = {
  extraction: sampleExtraction,
  identity: sampleIdentity,
  reply_debt: sampleReplyDebt,
  ask: sampleAsk,
};

export interface SampleOutcome {
  set: SetName;
  added: number;
  pool: number;
  total: number;
  target: number;
}

/** Adds up to `size` (default: what the set lacks to reach its target) new items to `set`. */
export async function sampleSet(db: DB, set: SetName, o: { now?: number; seed?: number; size?: number } = {}): Promise<SampleOutcome> {
  const now = o.now ?? Date.now();
  const target = EVAL_SET_TARGET_SIZES[set];
  const before = db.prepare(`SELECT count(*) FROM eval_items WHERE set_name = ? AND origin = 'sample'`).pluck().get(set) as number;
  const size = Math.max(0, o.size ?? target - before);
  const exclude = existingRefs(db, set);
  const ctx = sampleContext(db, { now, seed: o.seed ?? now, size, exclude });
  const res = size > 0 ? await SAMPLERS[set](ctx) : { items: [], pool: 0 };
  const added = insertItems(db, res.items.slice(0, size), now);
  recordSample(db, set, now, res.pool, added);
  return { set, added, pool: res.pool, total: before + added, target };
}

const inflight = new WeakMap<DB, Promise<void>>();

/** Lazy top-up for the labeling page (serialized per database). */
export async function ensureSampled(db: DB, sets: readonly SetName[], now = Date.now()): Promise<void> {
  const prev = inflight.get(db);
  if (prev) await prev.catch(() => undefined);
  const run = (async () => {
    const counts = new Map(setCounts(db).map((c) => [c.set, c]));
    for (const set of sets) {
      const total = counts.get(set)?.total ?? 0;
      const state = sampleState(db, set);
      const age = state ? now - state.sampledAt : Infinity;
      if ((total === 0 && age >= HOUR) || (total < EVAL_SET_TARGET_SIZES[set] && age >= DAY)) await sampleSet(db, set, { now });
    }
  })();
  inflight.set(db, run);
  try {
    await run;
  } finally {
    if (inflight.get(db) === run) inflight.delete(db);
  }
}
