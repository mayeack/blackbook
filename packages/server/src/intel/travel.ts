/**
 * travel_overlap candidates (intelligence §5 "Travel intel"):
 *   - a trip departing in 3–10 days with people you know there: the top 5 by 0.6·T + 0.4·H ("Austin Thu–Sun: Sam
 *     (lives there since Mar), Jess, Priya"); shown at most once per trip, and forced in on its last eligible day
 *     (3 days out) if the ranker hasn't picked it by then;
 *   - the inverse case: someone's travel_plan brings them to your city in 1–3 days (forced in within 48 h).
 * Pure reads over trips / trip_people (rebuilt by the 'intel' job before the suggestions stage) and facts.
 */
import type { DB } from '../db/connection';
import type { Candidate } from '../pipeline/suggestions/types';
import { hiddenNameRedactor } from '../routes/people';
import { DAY, addDays, dayStart, daysBetween, localDate } from './common';
import { homePlace, storedTrips, visitors } from './trips';

export const TRAVEL = {
  /** Emit a trip item this many days before departure. */
  minDays: 3,
  maxDays: 10,
  /** Visitors: 1–3 days before they arrive. */
  visitorMinDays: 1,
  visitorMaxDays: 3,
  people: 5,
  /** People below this tie score (0–1) are listed on /trips but not suggested. */
  minScore: 0.05,
  base: 0.75,
  /** Visitors within 48 h are time-critical (SELECTION.travelForceMs). */
  forceWithinDays: 2,
} as const;

export function tripCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const today = localDate(now, timeZone);
  const out: Candidate[] = [];
  const redact = hiddenNameRedactor(db);
  for (const t of storedTrips(db, { fromDay: addDays(today, TRAVEL.minDays), toDay: addDays(today, TRAVEL.maxDays) })) {
    const until = daysBetween(today, t.startsOn);
    if (until < TRAVEL.minDays || until > TRAVEL.maxDays) continue;
    const people = t.people.filter((p) => p.score >= TRAVEL.minScore).slice(0, TRAVEL.people);
    if (!people.length) continue;
    const startsAt = dayStart(t.startsOn, timeZone);
    out.push({
      kind: 'travel_overlap',
      personIds: people.map((p) => p.personId),
      subjectKey: t.id,
      base: TRAVEL.base,
      evidenceIds: [...t.occasionIds.map((id) => `occ:${id}`), ...people.filter((p) => p.factId).map((p) => `F${p.factId}`)].slice(0, 20),
      expiresAt: startsAt,
      timeCritical: until <= TRAVEL.minDays,
      links: { tripId: t.id },
      payload: {
        city: t.key.startsWith('metro:') ? t.label : redact(t.label),
        startsAt,
        endsAt: dayStart(addDays(t.endsOn, 1), timeZone) - 1,
        tripDays: daysBetween(t.startsOn, t.endsOn) + 1,
        daysUntil: until,
        peopleCount: t.people.length,
        reasons: people.map((p) => p.reason),
      },
    });
  }
  return out;
}

export function visitorCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const home = homePlace(db, now);
  if (!home) return [];
  const today = localDate(now, timeZone);
  const from = dayStart(addDays(today, TRAVEL.visitorMinDays), timeZone);
  const to = dayStart(addDays(today, TRAVEL.visitorMaxDays + 1), timeZone);
  return visitors(db, { home, timeZone, from: now, to, now })
    .filter((v) => v.startsAt >= from && v.startsAt < to)
    .map((v) => {
      const until = daysBetween(today, v.startsOn);
      return {
        kind: 'travel_overlap' as const,
        personIds: [v.personId],
        subjectKey: `visit:${v.factId}`,
        base: TRAVEL.base,
        evidenceIds: [`F${v.factId}`],
        expiresAt: (v.endsAt ?? v.startsAt) + DAY,
        timeCritical: until <= TRAVEL.forceWithinDays,
        payload: { city: home.label, startsAt: v.startsAt, endsAt: v.endsAt, inverse: true, daysUntil: until },
      };
    });
}
