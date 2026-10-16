/**
 * "On this day" memories (PLAN wildcards: an occasion or conversation from a year ago, with the people involved).
 * Sources, for the same local calendar day one year back:
 *   - a social, non-sensitive occasion (or Partiful event I went to) with ≥1 visible attendee (counted rows only:
 *     confidence ≥ 0.75) → up to 3 people, strongest ties first;
 *   - a real conversation that day: a DM/group session with a visible person, ≥10 messages, both directions.
 * kind 'memory' (base 0.3, 365-day cooldown, shown once). Regular memories rarely clear the floor; the 🎲 memory
 * wildcard is where they usually surface.
 */
import { localDate } from '@yb/shared';
import type { DB } from '../../../db/connection';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../types';
import { ATTENDING, localDayRange, sameDayYearsAgo } from './common';

const MIN_MESSAGES = 10;
const MAX_PEOPLE = 3;
const MAX_CONVERSATIONS = 2;

function attendees(db: DB, column: 'occasion_id' | 'event_id', id: string): string[] {
  return db
    .prepare(
      `SELECT pv.id FROM event_attendees a
       JOIN person_canon pc ON pc.person_id = a.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pv.id
       WHERE a.${column} = ? AND a.status IN ${ATTENDING} AND a.confidence >= 0.75
       GROUP BY pv.id ORDER BY max(coalesce(ps.tie_strength, 0)) DESC, pv.id LIMIT ${MAX_PEOPLE}`,
    )
    .pluck()
    .all(id) as string[];
}

export function memoryCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const today = localDate(now, timeZone);
  const day = sameDayYearsAgo(today, 1);
  const [start, end] = localDayRange(day, timeZone);
  // A memory is about today only: it expires at the end of today.
  const expiresAt = localDayRange(today, timeZone)[1];
  const out: Candidate[] = [];
  const seenEvents = new Set<string>();

  const occasions = db
    .prepare(
      `SELECT id, event_id FROM occasions
       WHERE merged_into_id IS NULL AND status = 'active' AND sensitive = 0 AND coalesce(is_social, kind = 'social') = 1
         AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, id`,
    )
    .all(start, end) as { id: string; event_id: string | null }[];
  for (const o of occasions) {
    const people = attendees(db, 'occasion_id', o.id);
    if (o.event_id) seenEvents.add(o.event_id);
    if (!people.length) continue;
    out.push({
      kind: 'memory',
      personIds: people,
      subjectKey: `occ:${o.id}`,
      base: 0.3,
      evidenceIds: [`occ:${o.id}`],
      expiresAt,
      links: { occasionId: o.id, eventId: o.event_id },
      payload: { yearsAgo: 1, day, attendeeCount: people.length, source: 'occasion' },
    });
  }

  const events = db
    .prepare(
      `SELECT id FROM events WHERE starts_at >= ? AND starts_at < ? AND kind = 'social'
         AND (my_role = 'host' OR my_rsvp IN ('going','approved','checked_in','attended')) ORDER BY starts_at, id`,
    )
    .pluck()
    .all(start, end) as string[];
  for (const e of events) {
    if (seenEvents.has(e)) continue;
    const people = attendees(db, 'event_id', e);
    if (!people.length) continue;
    out.push({
      kind: 'memory',
      personIds: people,
      subjectKey: `event:${e}`,
      base: 0.3,
      evidenceIds: [`event:${e}`],
      expiresAt,
      links: { eventId: e },
      payload: { yearsAgo: 1, day, attendeeCount: people.length, source: 'event' },
    });
  }

  const convs = db
    .prepare(
      `SELECT pv.id AS person_id, i.conversation_id, i.session_id, s.first_msg, (i.msgs_from_me + i.msgs_from_them) AS n
       FROM interactions i
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       JOIN conversations c ON c.id = i.conversation_id AND c.agent_excluded = 0
       LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.kind IN ('dm_session','group_session') AND i.retracted_at IS NULL AND i.started_at >= ? AND i.started_at < ?
         AND i.msgs_from_me > 0 AND i.msgs_from_them > 0 AND (i.msgs_from_me + i.msgs_from_them) >= ?
       ORDER BY n DESC, pv.id`,
    )
    .all(start, end, MIN_MESSAGES) as { person_id: string; conversation_id: string; session_id: string | null; first_msg: number | null; n: number }[];
  const seenPeople = new Set(out.flatMap((c) => c.personIds));
  let added = 0;
  for (const c of convs) {
    if (added >= MAX_CONVERSATIONS) break;
    if (seenPeople.has(c.person_id)) continue;
    seenPeople.add(c.person_id);
    added++;
    out.push({
      kind: 'memory',
      personIds: [c.person_id],
      subjectKey: `conv:${c.conversation_id}:${day}`,
      base: 0.3,
      evidenceIds: [...(c.first_msg ? [`m:${c.first_msg}`] : []), `conv:${c.conversation_id}`],
      expiresAt,
      payload: { yearsAgo: 1, day, messages: c.n, source: 'conversation', conversationId: c.conversation_id },
    });
  }
  return out;
}

export const memoryGenerator: CandidateGenerator = {
  kind: 'memory',
  generate: (ctx: GeneratorContext) => memoryCandidates(ctx.db, ctx.now, ctx.timeZone),
};

export const memoryWildcard: WildcardSource = {
  generator: 'memory',
  generate: (ctx: GeneratorContext) => memoryCandidates(ctx.db, ctx.now, ctx.timeZone),
};
