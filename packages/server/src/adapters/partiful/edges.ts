/**
 * Partiful-sourced person↔person evidence (intelligence §2), class (D): rebuilt from the Partiful
 * event_attendees rows, never journaled. Only rows with ref 'event:<events.id>' of Partiful events and the four
 * Partiful types are ever deleted or written here (calendar occasions write 'occ:<id>' refs elsewhere).
 *   co_attend   undirected, w = s_a·s_b / log2(1+going), s: going/approved/checked-in/host 1, maybe 0.5,
 *               invited/waitlist 0.2 (only visible when I host), declined 0. Events with more than
 *               MAX_CO_ATTEND_PEOPLE participants add no pairs (quadratic, and too diffuse to mean much).
 *   invited_by  directed inviter → invitee, 1.5
 *   plus_one    directed anchor → plus-one, 3.0
 *   co_host     undirected among the hosts, 2.0
 * w_raw is the undecayed base weight and `at` the event start: the edge aggregator applies time decay
 * (co_attend e^(−age/365), the others 0.5^(age/730)) and person-status factors. a_id/b_id are canonical person ids
 * at derive time; the daily sync rebuilds everything, so merges and undos are picked up within a day. Me, service
 * and suppressed people never get edges here (ties to me are §3's business). Canceled events add nothing.
 */
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attendanceWeight } from './schemas';

export const PARTIFUL_EDGE_TYPES = ['co_attend', 'invited_by', 'plus_one', 'co_host'] as const;
export const MAX_CO_ATTEND_PEOPLE = 100;
export const EDGE_WEIGHTS = { invited_by: 1.5, plus_one: 3.0, co_host: 2.0 } as const;

interface AttRow {
  event_id: string;
  person_id: string;
  status: string;
  role: string | null;
  invited_by_person_id: string | null;
  plus_one_of_person_id: string | null;
  starts_at: number | null;
  event_status: string | null;
  going_count: number | null;
}

export interface EdgeRebuildResult {
  events: number;
  rows: number;
}

const TYPES_SQL = PARTIFUL_EDGE_TYPES.map((t) => `'${t}'`).join(',');

/** Rebuilds the Partiful edge evidence (all Partiful events, or just `eventIds`). */
export function rebuildPartifulEdges(db: DB, now: number, o: { eventIds?: readonly string[] } = {}): EdgeRebuildResult {
  return tx(db, () => {
    const only = o.eventIds ? JSON.stringify(o.eventIds) : null;
    const scope = only ? `AND e.id IN (SELECT value FROM json_each(@only))` : '';
    db.prepare(
      `DELETE FROM edge_evidence WHERE type IN (${TYPES_SQL})
         AND ref IN (SELECT 'event:' || e.id FROM events e WHERE e.source = 'partiful' ${scope})`,
    ).run(only ? { only } : {});
    const rows = db
      .prepare(
        `SELECT a.event_id, a.person_id, a.status, a.role, a.invited_by_person_id, a.plus_one_of_person_id,
           e.starts_at, e.status AS event_status, s.going_count
         FROM event_attendees a
         JOIN events e ON e.id = a.event_id AND e.source = 'partiful'
         LEFT JOIN partiful_event_sync s ON s.event_id = e.source_event_id
         WHERE a.source = 'partiful' AND a.status NOT IN ('rejected','possible') ${scope}`,
      )
      .all(only ? { only } : {}) as AttRow[];
    const canon = new Map(db.prepare('SELECT person_id, canonical_id FROM person_canon').raw().all() as [string, string][]);
    const eligible = new Set(
      db
        .prepare(`SELECT id FROM people WHERE kind = 'person' AND status IN ('active','provisional','roster_only') AND merged_into_id IS NULL`)
        .pluck()
        .all() as string[],
    );
    const c = (id: string | null): string | null => {
      if (!id) return null;
      const k = canon.get(id) ?? id;
      return eligible.has(k) ? k : null;
    };
    const insert = db.prepare(
      `INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (a_id, b_id, type, ref) DO UPDATE SET w_raw = max(edge_evidence.w_raw, excluded.w_raw), at = excluded.at`,
    );
    let written = 0;
    const put = (a: string, b: string, type: string, directed: boolean, ref: string, at: number | null, w: number) => {
      if (a === b || w <= 0) return;
      const [x, y] = directed || a < b ? [a, b] : [b, a];
      written += insert.run(x, y, type, directed ? 1 : 0, ref, at, Math.round(w * 1e6) / 1e6, now).changes;
    };

    const byEvent = new Map<string, AttRow[]>();
    for (const r of rows) {
      const list = byEvent.get(r.event_id);
      if (list) list.push(r);
      else byEvent.set(r.event_id, [r]);
    }
    let events = 0;
    for (const [eventId, list] of byEvent) {
      const first = list[0]!;
      if (/cancel/i.test(first.event_status ?? '')) continue;
      events++;
      const ref = `event:${eventId}`;
      const at = first.starts_at;
      // Strongest attendance per canonical person (two rows can share one after a merge).
      const s = new Map<string, number>();
      const hosts = new Set<string>();
      for (const r of list) {
        const p = c(r.person_id);
        if (!p) continue;
        const isHostRole = r.role === 'host' || r.role === 'co_host' || r.status === 'host';
        const w = isHostRole ? 1 : attendanceWeight(r.status);
        if (isHostRole) hosts.add(p);
        if (w > (s.get(p) ?? 0)) s.set(p, w);
      }
      const people = [...s.entries()].filter(([, w]) => w > 0);
      const going = Math.max(1, first.going_count ?? 0, people.filter(([, w]) => w === 1).length);
      if (people.length <= MAX_CO_ATTEND_PEOPLE) {
        const denom = Math.log2(1 + going);
        for (let i = 0; i < people.length; i++) {
          for (let j = i + 1; j < people.length; j++) {
            const [a, wa] = people[i]!;
            const [b, wb] = people[j]!;
            put(a, b, 'co_attend', false, ref, at, (wa * wb) / denom);
          }
        }
      }
      const h = [...hosts];
      for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) put(h[i]!, h[j]!, 'co_host', false, ref, at, EDGE_WEIGHTS.co_host);
      for (const r of list) {
        const p = c(r.person_id);
        if (!p) continue;
        const inviter = c(r.invited_by_person_id);
        if (inviter) put(inviter, p, 'invited_by', true, ref, at, EDGE_WEIGHTS.invited_by);
        const anchor = c(r.plus_one_of_person_id);
        if (anchor) put(anchor, p, 'plus_one', true, ref, at, EDGE_WEIGHTS.plus_one);
      }
    }
    return { events, rows: written };
  });
}
