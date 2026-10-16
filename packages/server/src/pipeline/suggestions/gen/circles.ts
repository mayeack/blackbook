/**
 * Circle-level generators (intelligence §5 table: circle_neglect base 0.4, 30-day cooldown) and the 🎲 random
 * circle check-in. A circle (3–60 visible members) is neglected when the last time I was with ≥2 of its members —
 * a social occasion or Partiful event we attended, or my last post in a group chat with ≥2 of them — is 45+ days
 * ago (and within two years: older ones have simply moved on). Circle items name no person (personIds []).
 */
import type { DB } from '../../../db/connection';
import { circlesWithMembers } from '../people';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../types';
import { ATTENDING, DAY, round } from './common';

export const NEGLECT_DAYS = 45;
const NEGLECT_MAX_DAYS = 730;
const CHECKIN_MIN_DAYS = 14;

export interface Together {
  at: number;
  ref: string;
}

/** The latest time I was together with ≥2 of `members` (null = never). */
export function lastTogether(db: DB, members: readonly string[], now: number): Together | null {
  const json = JSON.stringify(members);
  const occ = db
    .prepare(
      `SELECT o.id, o.starts_at AS at FROM occasions o
       JOIN event_attendees a ON a.occasion_id = o.id
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.sensitive = 0 AND coalesce(o.is_social, o.kind = 'social') = 1
         AND o.starts_at <= ? AND a.status IN ${ATTENDING} AND a.confidence >= 0.75
         AND pc.canonical_id IN (SELECT value FROM json_each(?))
       GROUP BY o.id HAVING count(DISTINCT pc.canonical_id) >= 2
       ORDER BY o.starts_at DESC LIMIT 1`,
    )
    .get(now, json) as { id: string; at: number } | undefined;
  const ev = db
    .prepare(
      `SELECT e.id, e.starts_at AS at FROM events e
       JOIN event_attendees a ON a.event_id = e.id
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE e.starts_at IS NOT NULL AND e.starts_at <= ? AND (e.my_role = 'host' OR e.my_rsvp IN ('going','approved','checked_in','attended'))
         AND a.status IN ${ATTENDING} AND pc.canonical_id IN (SELECT value FROM json_each(?))
       GROUP BY e.id HAVING count(DISTINCT pc.canonical_id) >= 2
       ORDER BY e.starts_at DESC LIMIT 1`,
    )
    .get(now, json) as { id: string; at: number } | undefined;
  const conv = db
    .prepare(
      `SELECT m.conversation_id AS id, max(m.sent_at) AS at FROM messages m
       WHERE m.is_from_me = 1 AND m.sent_at <= ? AND m.kind IN ('text','attachment','link','poll','sticker')
         AND m.conversation_id IN (
           SELECT cm.conversation_id FROM conversation_members cm
           JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'group'
           JOIN identities i ON i.id = cm.identity_id
           JOIN person_canon pc ON pc.person_id = i.person_id
           WHERE pc.canonical_id IN (SELECT value FROM json_each(?))
           GROUP BY cm.conversation_id HAVING count(DISTINCT pc.canonical_id) >= 2)
       GROUP BY m.conversation_id ORDER BY at DESC LIMIT 1`,
    )
    .get(now, json) as { id: string | null; at: number | null } | undefined;
  const options: Together[] = [];
  if (occ) options.push({ at: occ.at, ref: `occ:${occ.id}` });
  if (ev) options.push({ at: ev.at, ref: `event:${ev.id}` });
  if (conv?.id && conv.at !== null) options.push({ at: conv.at, ref: `conv:${conv.id}` });
  return options.sort((a, b) => b.at - a.at)[0] ?? null;
}

export const circleNeglectGenerator: CandidateGenerator = {
  kind: 'circle_neglect',
  generate(ctx: GeneratorContext): Candidate[] {
    const out: Candidate[] = [];
    for (const c of circlesWithMembers(ctx.db)) {
      const t = lastTogether(ctx.db, c.members, ctx.now);
      if (!t) continue;
      const sinceD = (ctx.now - t.at) / DAY;
      if (sinceD < NEGLECT_DAYS || sinceD > NEGLECT_MAX_DAYS) continue;
      out.push({
        kind: 'circle_neglect',
        personIds: [],
        subjectKey: c.id,
        base: 0.4,
        evidenceIds: [t.ref],
        expiresAt: null,
        links: { circleId: c.id },
        payload: { sinceD: round(sinceD, 0), lastTogetherAt: t.at, memberCount: c.members.length },
      });
    }
    return out;
  },
};

/** 🎲 Any circle not seen together in the last two weeks. */
export const circleCheckinWildcard: WildcardSource = {
  generator: 'circle_checkin',
  generate(ctx: GeneratorContext): Candidate[] {
    const out: Candidate[] = [];
    for (const c of circlesWithMembers(ctx.db)) {
      const t = lastTogether(ctx.db, c.members, ctx.now);
      if (t && ctx.now - t.at < CHECKIN_MIN_DAYS * DAY) continue;
      out.push({
        kind: 'circle_neglect',
        personIds: [],
        subjectKey: c.id,
        base: 0.4,
        evidenceIds: t ? [t.ref] : [],
        expiresAt: null,
        links: { circleId: c.id },
        payload: { checkin: true, sinceD: t ? round((ctx.now - t.at) / DAY, 0) : null, lastTogetherAt: t?.at ?? null, memberCount: c.members.length },
      });
    }
    return out;
  },
};
