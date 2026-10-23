/**
 * Answered calls as interactions (intelligence §3: "Call … 1.2"), class (D): rebuilt from calls + call_handles on
 * every calls run, never journaled. One row per (person, call): kind 'call', channel 'phone' | 'facetime',
 * origin 'derived', call_id = calls.id, ended_at only when the call log has a duration. Counted: an answered call
 * whose handle is an active identity of a visible person (active / provisional, never me or a service). A call
 * matching two pre-canon records of one person counts once. Missed calls stay out (no conversation happened);
 * the timeline still shows them from the calls table. person_id is the pre-canon person (reads join person_canon).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';

interface Want {
  person_id: string;
  call_id: string;
  started_at: number;
  duration_ms: number;
  service: string;
  outgoing: number;
}

export function rebuildCallInteractions(db: DB, now: number): { upserted: number; deleted: number; linked: number } {
  return tx(db, () => {
    const want = db
      .prepare(
        `SELECT min(i.person_id) AS person_id, c.id AS call_id, c.started_at, c.duration_ms, c.service, c.outgoing
         FROM calls c
         JOIN call_handles h ON h.call_id = c.id
         JOIN identities i ON i.kind = h.kind AND i.key = h.key AND i.status = 'active'
         JOIN person_canon pc ON pc.person_id = i.person_id
         JOIN people p ON p.id = pc.canonical_id
         WHERE c.answered = 1 AND p.kind = 'person' AND p.status IN ('active','provisional')
         GROUP BY pc.canonical_id, c.id`,
      )
      .all() as Want[];
    const wanted = new Map(want.map((w) => [`${w.person_id}|${w.call_id}`, w]));
    const existing = db
      .prepare(`SELECT id, person_id, call_id FROM interactions WHERE origin = 'derived' AND kind = 'call'`)
      .all() as { id: string; person_id: string; call_id: string | null }[];
    const del = db.prepare('DELETE FROM interactions WHERE id = ?');
    let deleted = 0;
    for (const e of existing) if (!wanted.has(`${e.person_id}|${e.call_id}`)) deleted += del.run(e.id).changes;
    const upsert = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, channel, call_id, started_at, ended_at, initiated_by_me, origin, created_at, updated_at)
       VALUES (@id, @person_id, 'call', @channel, @call_id, @started_at, @ended_at, @outgoing, 'derived', @now, @now)
       ON CONFLICT (dedupe_key) WHERE origin = 'derived' DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
         channel = excluded.channel, initiated_by_me = excluded.initiated_by_me, retracted_at = NULL, updated_at = excluded.updated_at
       WHERE started_at IS NOT excluded.started_at OR ended_at IS NOT excluded.ended_at OR channel IS NOT excluded.channel
         OR initiated_by_me IS NOT excluded.initiated_by_me OR retracted_at IS NOT NULL`,
    );
    let upserted = 0;
    for (const w of wanted.values()) {
      upserted += upsert.run({
        id: uuidv7(now),
        person_id: w.person_id,
        call_id: w.call_id,
        channel: w.service.startsWith('facetime') ? 'facetime' : 'phone',
        started_at: w.started_at,
        ended_at: w.duration_ms > 0 ? w.started_at + w.duration_ms : null,
        outgoing: w.outgoing,
        now,
      }).changes;
    }
    return { upserted, deleted, linked: wanted.size };
  });
}
