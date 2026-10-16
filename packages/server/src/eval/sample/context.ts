/** What every sampler gets: the database, a seeded RNG, the target size and the subjects already in the set. */
import type { DB } from '../../db/connection';
import { settingTimeZone } from '../../settings/registry';
import type { NewItem } from '../types';
import { allocate, canonFn, interleave, meId, rng, visibleFn, yieldToLoop, type PersonInfo } from '../util';

export interface SampleContext {
  db: DB;
  now: number;
  tz: string;
  rand: () => number;
  /** How many items to add. */
  size: number;
  /** subject_refs already in the set (top-ups never duplicate). */
  exclude: ReadonlySet<string>;
  canon: (id: string) => string;
  visible: (id: string | null | undefined) => PersonInfo | null;
  meId: string | null;
}

export interface SampleResult {
  items: NewItem[];
  /** Candidates the sampler could draw from (counts only). */
  pool: number;
}

export function sampleContext(db: DB, o: { now: number; seed: number; size: number; exclude: ReadonlySet<string> }): SampleContext {
  return { db, now: o.now, tz: settingTimeZone(db), rand: rng(o.seed), size: o.size, exclude: o.exclude, canon: canonFn(db), visible: visibleFn(db), meId: meId(db) };
}

/**
 * Fills per-stratum quotas from shuffled candidate lists. `build` may reject a candidate (null: hidden person,
 * vanished rows); its stratum then draws the next one, and whatever a stratum can't fill is re-allocated to the
 * others in a second round.
 */
export async function fillStrata<C>(
  groups: Map<string, C[]>,
  weights: (stratum: string) => number,
  size: number,
  build: (c: C, stratum: string) => NewItem | null,
  yieldEvery = 10,
): Promise<NewItem[]> {
  const cursor = new Map<string, number>([...groups.keys()].map((k) => [k, 0]));
  const picked = new Map<string, NewItem[]>([...groups.keys()].map((k) => [k, []]));
  let built = 0;
  let need = size;
  for (let round = 0; round < 4 && need > 0; round++) {
    const strata = [...groups.entries()].map(([key, list]) => ({ key, weight: weights(key), available: list.length - cursor.get(key)! }));
    const quota = allocate(need, strata);
    let progress = 0;
    for (const [key, n] of quota) {
      const list = groups.get(key)!;
      let got = 0;
      while (got < n && cursor.get(key)! < list.length) {
        const c = list[cursor.get(key)!]!;
        cursor.set(key, cursor.get(key)! + 1);
        const item = build(c, key);
        if (++built % yieldEvery === 0) await yieldToLoop();
        if (!item) continue;
        picked.get(key)!.push(item);
        got++;
      }
      progress += got;
    }
    need -= progress;
    if (!progress) break;
  }
  return interleave([...picked.values()]);
}
