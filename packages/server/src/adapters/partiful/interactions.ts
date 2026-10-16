/**
 * Partiful co-attendance as interactions (intelligence §3: "Partiful co-attendance (both GOING, event in the past)
 * 1.5 units"), class (D): rebuilt from the Partiful attendee rows on every daily pass, never journaled, so an
 * undone attendee (status 'rejected') loses its interaction on the next pass. One row per (person, event):
 * kind 'event', channel 'partiful', origin 'derived', event_id = events.id, started_at = the event start.
 * Counted: a started, non-canceled event that I hosted or went to (going / approved / checked in), and a guest who
 * went too (or hosted), whose canonical person is visible (active / provisional, never me, a service or a
 * roster-only stranger). The calendar-occasion pipeline skips its own interaction for a person this already
 * covers. person_id is the pre-canon person (reads join person_canon).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';

export const PARTIFUL_EVENT_UNITS = 1.5;
const WENT = `('going','approved','checked_in','attended','host')`;

interface Want {
  person_id: string;
  event_id: string;
  starts_at: number;
  ends_at: number | null;
}

export function rebuildPartifulInteractions(db: DB, now: number): { upserted: number; deleted: number } {
  return tx(db, () => {
    const want = db
      .prepare(
        `SELECT a.person_id, a.event_id, min(e.starts_at) AS starts_at, max(e.ends_at) AS ends_at
         FROM event_attendees a
         JOIN events e ON e.id = a.event_id AND e.source = 'partiful'
         JOIN person_canon pc ON pc.person_id = a.person_id
         JOIN people p ON p.id = pc.canonical_id
         WHERE a.source = 'partiful' AND a.status IN ${WENT}
           AND e.starts_at IS NOT NULL AND e.starts_at <= @now AND coalesce(e.status, '') NOT LIKE '%cancel%'
           AND (e.my_role = 'host' OR e.my_rsvp IN ('going','approved','checked_in','attended'))
           AND p.kind = 'person' AND p.status IN ('active','provisional')
         GROUP BY a.person_id, a.event_id`,
      )
      .all({ now }) as Want[];
    const wanted = new Map(want.map((w) => [`${w.person_id}|${w.event_id}`, w]));
    const existing = db
      .prepare(`SELECT id, person_id, event_id FROM interactions WHERE origin = 'derived' AND kind = 'event' AND channel = 'partiful'`)
      .all() as { id: string; person_id: string; event_id: string | null }[];
    const del = db.prepare('DELETE FROM interactions WHERE id = ?');
    let deleted = 0;
    for (const e of existing) if (!wanted.has(`${e.person_id}|${e.event_id}`)) deleted += del.run(e.id).changes;
    const upsert = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, channel, event_id, started_at, ended_at, units, origin, created_at, updated_at)
       VALUES (@id, @person_id, 'event', 'partiful', @event_id, @starts_at, @ends_at, @units, 'derived', @now, @now)
       ON CONFLICT (dedupe_key) WHERE origin = 'derived' DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
         units = excluded.units, channel = excluded.channel, retracted_at = NULL, updated_at = excluded.updated_at
       WHERE started_at IS NOT excluded.started_at OR ended_at IS NOT excluded.ended_at OR units IS NOT excluded.units
         OR channel IS NOT excluded.channel OR retracted_at IS NOT NULL`,
    );
    let upserted = 0;
    for (const w of wanted.values()) {
      upserted += upsert.run({ id: uuidv7(now), ...w, units: PARTIFUL_EVENT_UNITS, now }).changes;
    }
    return { upserted, deleted };
  });
}
