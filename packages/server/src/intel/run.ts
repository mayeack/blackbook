/**
 * The nightly intel pass (job 'intel', AGENT_TIMES.intel — after graph and ties, before the suggestions stage):
 *   1. trips: detect from the calendar's lodging / flight / multi-day / distant-venue occasions, match people;
 *   2. intro pairs: eligibility and scores (setting intros.enabled);
 *   3. occasion effects: interactions + co_attend edges re-derived when adjudicated attendees changed.
 * Every step is small and synchronous; runIntel hands the event loop back between them (the 10 s iMessage tail
 * stays responsive) and stops early on the scheduler's signal. Derived tables only: nothing here is journaled.
 */
import type { DB } from '../db/connection';
import { nullLogger, type Logger } from '../ops/logger';
import { deriveOccasionEffects } from '../pipeline/occasions/effects';
import { readSetting, settingTimeZone } from '../settings/registry';
import { drain, drive, EFFECTS_DIRTY, getFlag } from './common';
import { scorePairsSteps, storePairs } from './intros';
import { refreshTripsSteps, type TripRefreshStats } from './trips';

export interface IntelRunOptions {
  now?: number;
  timeZone?: string;
  signal?: AbortSignal;
  log?: Logger;
}

export interface IntelRunResult {
  complete: boolean;
  stats: Record<string, number>;
}

/** Re-derives occasion effects if an adjudication changed attendees since the last time. */
export function deriveEffectsIfDirty(db: DB, now: number): Record<string, number> | null {
  const dirty = getFlag<number>(db, EFFECTS_DIRTY);
  if (dirty === null) return null;
  const stats = deriveOccasionEffects(db, now);
  // A flag set again while we derived (a later apply) stays for the next tick.
  db.prepare('DELETE FROM intel_state WHERE key = ? AND value = ?').run(EFFECTS_DIRTY, JSON.stringify(dirty));
  return { ...stats };
}

export async function runIntel(db: DB, o: IntelRunOptions = {}): Promise<IntelRunResult> {
  const now = o.now ?? Date.now();
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const log = o.log ?? nullLogger;
  const stats: Record<string, number> = {};
  const trips = await drive(refreshTripsSteps(db, { now, timeZone }), { signal: o.signal });
  if (!trips.complete) return { complete: false, stats };
  for (const [k, v] of Object.entries(trips.value as TripRefreshStats)) stats[`trips_${k}`] = v;
  if (readSetting(db, 'intros.enabled')) {
    const pairs = await drive(scorePairsSteps(db, now), { signal: o.signal });
    if (!pairs.complete) return { complete: false, stats };
    stats.intro_pairs = storePairs(db, pairs.value!, now);
    stats.intro_suggestable = pairs.value!.filter((p) => p.score >= 0.45).length;
  }
  const effects = deriveEffectsIfDirty(db, now);
  if (effects) for (const [k, v] of Object.entries(effects)) stats[`effects_${k}`] = v;
  log.info('intel.run', { job: 'intel', counts: stats });
  return { complete: true, stats };
}

/** The same pass, synchronously (tests, scripts). */
export function runIntelSync(db: DB, o: IntelRunOptions = {}): Record<string, number> {
  const now = o.now ?? Date.now();
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(drain(refreshTripsSteps(db, { now, timeZone })))) stats[`trips_${k}`] = v;
  if (readSetting(db, 'intros.enabled')) stats.intro_pairs = storePairs(db, drain(scorePairsSteps(db, now)), now);
  const effects = deriveEffectsIfDirty(db, now);
  if (effects) for (const [k, v] of Object.entries(effects)) stats[`effects_${k}`] = v;
  return stats;
}

