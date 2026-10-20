/**
 * Party invites (intelligence §5 "Event intel"): when the owner hosts a party or event 2–14 days out, whom to
 * invite. One party_invite candidate per hosted event, with up to 5 people who aren't on its guest list yet:
 *
 *   1. people in the Party invites circle (the owner asked by text: "prioritize inviting Sam to parties"), the
 *      strongest tie first;
 *   2. then close people (closeness ≥ 7 of 10; a priority person whatever their closeness) who often come to parties:
 *      ≥ 2 social happenings with the owner in the last year, or one he hosted — ranked 0.6·T/100 + 0.4·min(1,
 *      parties/4) + 0.1 if they came to one he hosted.
 *
 * Hosted = a Partiful event where he is host / co-host (my_role), or an active social calendar occasion he
 * organizes: a calendar copy he is the organizer of, not someone else's ("Sam's birthday", "drinks at Sam's"), whose
 * title says he's hosting ("hosting", "at mine", "my birthday", "housewarming"), or that he sent calendar invitations
 * for — at least one to a party-like title ("game night", "BBQ"), or three or more to anything social. A Partiful
 * event linked to the occasion decides on its own (a guest there never hosts here).
 *
 * Never anyone already invited (the owner: "always cross check … to ensure I'm not told to invite duplicates"):
 *   - a Partiful event's list must have been read in full within the last hour (job partiful-hosted-guests refreshes
 *     hosted lists every 30 min); a list that is older or failed to read means no item for that event, and the brief
 *     drops an item whose list went stale or that now names someone on it (partyInviteStale, before every send);
 *   - left out: anyone with a guest-list row in any status (going, maybe, invited, declined, waitlist, rejected …),
 *     people the calendar names or invited by email, anyone sharing an identity with a guest in another form (phone
 *     inside a WhatsApp id, a Gmail address with other dots, an @handle, the Partiful user) or an open "maybe the same
 *     person" match with one, and anyone whose first + last name matches a name on the list (nicknames included:
 *     "Sam" = "Samuel"), including SMS invitees with no Partiful account — when in doubt, they stay out;
 *   - also left out: people muted for this kind or resting after ignored suggestions (one of five is dropped rather
 *     than the whole list), and the owner, hidden, merged, roster-only and service people.
 * Pure reader; payload is numbers and short codes only (the composer reads the title at render time).
 */
import { emailMatchKey, firstNameScore, normalizeNamePart } from '@yb/shared';
import type { DB } from '../db/connection';
import { selfPeople } from '../identity/self';
import { preferredPeople } from '../pipeline/circles/preferences';
import { occasionChain } from '../pipeline/occasions/build';
import { personState } from '../pipeline/suggestions/learner';
import { closenessScore, meetsCloseness } from '../pipeline/ties/closeness';
import type { Candidate } from '../pipeline/suggestions/types';
import { DAY, addDays, attendedEvents, dayStart, daysBetween, knownAttendees, localDate, statsOf, type SocialEvent } from './common';

export const INVITE = {
  /** Hosted events this many local days out (inclusive). */
  minDaysOut: 2,
  maxDaysOut: 14,
  maxPeople: 5,
  /** Closeness (1–10, pipeline/ties/closeness.ts) for the second group; priority people are exempt. */
  minCloseness: 7,
  /** "Often comes to parties": counted at this many of the owner's social happenings in the lookback (or one he hosted). */
  minParties: 2,
  lookbackDays: 365,
  /** Calendar invitations that make any social occasion he organizes a gathering he hosts. */
  minCalendarInvitees: 3,
  /** A Partiful guest list counts only when read in full this recently (job partiful-hosted-guests: every 30 min). */
  freshGuestsMs: 60 * 60_000,
} as const;

/** The title says the owner is hosting. */
const HOSTING_TITLE =
  /\b(?:hosting|housewarming|my (?:birthday|bday|place|house|apartment|apt|flat|party)|at (?:mine|ours|home|my (?:place|house|apartment|apt|flat)|our (?:place|house|apartment|apt|flat))|our (?:party|housewarming))\b/i;
/** A party-like title. */
const PARTY_TITLE =
  /\b(?:party|parties|birthday|bday|housewarming|bbq|barbecue|cookout|potluck|game night|kickback|get[- ]together|celebration|soir[ée]e|happy hour|brunch|drinks)\b/i;
/** Someone else's happening: "Sam's birthday", "Drinks at Sam's". */
const SOMEONE_ELSES = /(?:^|\bat\s+|@\s*)\p{Lu}[\p{L}-]*['’]s\b/u;

const HOST_ROLES = ['host', 'co_host', 'cohost'];
const HOST_ROLES_SQL = `(${HOST_ROLES.map((r) => `'${r}'`).join(',')})`;

interface OccasionRow {
  id: string;
  title: string | null;
  startsAt: number;
  endsAt: number;
  venue: string | null;
  eventId: string | null;
  eventSource: string | null;
  myRole: string;
  selfOrganized: number | null;
  invitees: number | null;
}

/** Whether a calendar-only occasion is one the owner organizes as a host (see the header). */
export function organizesAsHost(title: string | null, selfOrganized: boolean, invitees: number): boolean {
  if (!selfOrganized) return false;
  const t = title?.trim() ?? '';
  if (SOMEONE_ELSES.test(t)) return false;
  if (HOSTING_TITLE.test(t)) return true;
  return invitees >= INVITE.minCalendarInvitees || (invitees >= 1 && PARTY_TITLE.test(t));
}

/**
 * Social happenings the owner hosts that start in [from, to): unmerged, non-sensitive occasions (active and social,
 * or linked to a Partiful event he hosts — then a candidate occasion counts too) and Partiful events he hosts that no
 * live occasion covers.
 */
export function hostedEvents(db: DB, o: { startFrom: number; startTo: number }): SocialEvent[] {
  const occ = db
    .prepare(
      `SELECT o.id, o.title, o.starts_at AS startsAt, coalesce(o.ends_at, o.starts_at) AS endsAt, o.venue_text AS venue, o.event_id AS eventId,
              e.source AS eventSource, lower(coalesce(e.my_role, '')) AS myRole,
              (SELECT max(ce.self_organizer) FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref
                WHERE s.occasion_id = o.id AND s.source = 'calendar' AND ce.status <> 'cancelled') AS selfOrganized,
              (SELECT max((SELECT count(*) FROM json_each(ce.attendees) a WHERE coalesce(json_extract(a.value, '$.self'), 0) = 0))
                 FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref
                WHERE s.occasion_id = o.id AND s.source = 'calendar' AND ce.status <> 'cancelled' AND ce.self_organizer = 1) AS invitees
       FROM occasions o LEFT JOIN events e ON e.id = o.event_id
       WHERE o.merged_into_id IS NULL AND o.sensitive = 0 AND o.starts_at >= @sf AND o.starts_at < @st
         AND ((o.status = 'active' AND o.is_social = 1) OR (e.source = 'partiful' AND o.status IN ('active','candidate')))
         AND lower(coalesce(e.status, '')) NOT LIKE '%cancel%'
       ORDER BY o.starts_at, o.id`,
    )
    .all({ sf: o.startFrom, st: o.startTo }) as OccasionRow[];
  const out: SocialEvent[] = [];
  for (const r of occ) {
    // A linked Partiful event knows who hosts; otherwise the owner's own calendar copy decides.
    const hosted = r.eventSource === 'partiful' ? HOST_ROLES.includes(r.myRole) : organizesAsHost(r.title, r.selfOrganized === 1, r.invitees ?? 0);
    if (hosted) out.push({ type: 'occasion', id: r.id, title: r.title, startsAt: r.startsAt, endsAt: r.endsAt, venue: r.venue, eventId: r.eventId });
  }
  const ev = db
    .prepare(
      `SELECT 'event' AS type, e.id, e.title, e.starts_at AS startsAt, coalesce(e.ends_at, e.starts_at + 3 * 3600000) AS endsAt,
              e.location_text AS venue, NULL AS eventId
       FROM events e
       WHERE e.source = 'partiful' AND e.starts_at IS NOT NULL AND lower(coalesce(e.my_role, '')) IN ${HOST_ROLES_SQL}
         AND lower(coalesce(e.status, '')) NOT LIKE '%cancel%' AND e.starts_at >= @sf AND e.starts_at < @st
         AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active','candidate'))
       ORDER BY e.starts_at, e.id`,
    )
    .all({ sf: o.startFrom, st: o.startTo }) as SocialEvent[];
  return [...out, ...ev].sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1));
}

/**
 * Canonical ids already tied to the event: every attendee row (any status) of the occasion's merge chain and the
 * linked Partiful event, people the occasion pipeline matched to it (occasion_candidates), and calendar invitees by
 * email.
 */
export function guestList(db: DB, e: Pick<SocialEvent, 'type' | 'id' | 'eventId'>): Set<string> {
  const chain = JSON.stringify(e.type === 'occasion' ? occasionChain(db, e.id) : []);
  const eventId = e.type === 'event' ? e.id : (e.eventId ?? null);
  const ids = db
    .prepare(
      `SELECT pc.canonical_id FROM event_attendees a JOIN person_canon pc ON pc.person_id = a.person_id
        WHERE a.occasion_id IN (SELECT value FROM json_each(@chain)) OR (@event IS NOT NULL AND a.event_id = @event)
       UNION
       SELECT pc.canonical_id FROM occasion_candidates c JOIN person_canon pc ON pc.person_id = c.person_id
        WHERE c.occasion_id IN (SELECT value FROM json_each(@chain)) AND c.person_id IS NOT NULL
       UNION
       SELECT pc.canonical_id FROM occasion_sources s
         JOIN calendar_events ce ON ce.id = s.source_ref
         JOIN json_each(ce.attendees) a
         JOIN identities i ON i.kind = 'email' AND i.key = json_extract(a.value, '$.email')
         JOIN person_canon pc ON pc.person_id = i.person_id
        WHERE s.occasion_id IN (SELECT value FROM json_each(@chain)) AND s.source = 'calendar' AND coalesce(json_extract(a.value, '$.self'), 0) = 0`,
    )
    .pluck()
    .all({ chain, event: eventId }) as string[];
  return new Set(ids);
}

// ---------------------------------------------------------------------------------------------- the guest list

/** The Partiful event behind a hosted happening (null for a calendar-only occasion). */
export function partifulEventOf(db: DB, e: Pick<SocialEvent, 'type' | 'id' | 'eventId'>): string | null {
  const id = e.type === 'event' ? e.id : e.eventId;
  if (!id) return null;
  return (db.prepare(`SELECT id FROM events WHERE id = ? AND source = 'partiful'`).pluck().get(id) as string | undefined) ?? null;
}

/** Whether a Partiful event's guest list was read in full ('ok') within INVITE.freshGuestsMs of `now`. */
export function guestListFresh(db: DB, eventRowId: string, now: number): boolean {
  const r = db
    .prepare(`SELECT s.guests_status AS status, s.guests_fetched_at AS at FROM events e JOIN partiful_event_sync s ON s.event_id = e.source_event_id WHERE e.id = ?`)
    .get(eventRowId) as { status: string | null; at: number | null } | undefined;
  return r?.status === 'ok' && r.at !== null && r.at >= now - INVITE.freshGuestsMs;
}

/** Match keys of one identity, in every form another record of the same human may use. */
function identityKeys(kind: string, key: string, raw: string | null): string[] {
  const out: string[] = [];
  const handle = (h: string | null | undefined) => {
    const v = h?.trim().replace(/^@/, '').toLowerCase();
    if (v && /^[a-z0-9._]{1,30}$/.test(v)) out.push(`ig:${v}`);
  };
  switch (kind) {
    case 'phone':
      out.push(`tel:${key}`);
      break;
    case 'whatsapp_jid': {
      const digits = /^(\d{8,15})@/.exec(key)?.[1];
      if (digits) out.push(`tel:+${digits}`);
      break;
    }
    case 'email': {
      const m = emailMatchKey(key);
      if (m) out.push(`mail:${m}`);
      break;
    }
    case 'partiful_user':
      out.push(`pty:${key}`);
      break;
    case 'instagram_username':
      handle(key);
      break;
    case 'instagram_id':
    case 'instagram_name':
    case 'beeper_user':
      if (raw?.trim().startsWith('@')) handle(raw);
      break;
  }
  return out;
}

/** "first last" (first and last word) of a name, normalized; null for a single word. */
function nameParts(full: string | null | undefined): { first: string; last: string } | null {
  const words = (full ?? '')
    .split(/\s+/)
    .map((w) => normalizeNamePart(w.replace(/[^\p{L}\p{N}'’-]+/gu, '')))
    .filter(Boolean);
  return words.length >= 2 ? { first: words[0]!, last: words[words.length - 1]! } : null;
}

/** Everyone already tied to a hosted event, in every form a duplicate could hide behind. */
export interface GuestCheck {
  /** Canonical people: guest-list rows in any status, occasion candidates, calendar invitees by email. */
  ids: Set<string>;
  /** Identity match keys of those people and of calendar invitees ('tel:', 'mail:', 'pty:', 'ig:'). */
  keys: Set<string>;
  /** Names on the list, matched or not: guests, their accounts, SMS invitees, calendar names. */
  names: { first: string; last: string }[];
  /** People the matcher thinks may be one of the guests (an open match candidate). */
  maybe: Set<string>;
}

export function guestCheck(db: DB, e: Pick<SocialEvent, 'type' | 'id' | 'eventId'>): GuestCheck {
  const ids = guestList(db, e);
  const idsJson = JSON.stringify([...ids]);
  const chain = JSON.stringify(e.type === 'occasion' ? occasionChain(db, e.id) : []);
  const eventId = e.type === 'event' ? e.id : (e.eventId ?? null);
  const keys = new Set<string>();
  const names: { first: string; last: string }[] = [];
  const addName = (n: string | null | undefined) => {
    const p = nameParts(n);
    if (p) names.push(p);
  };
  const idents = db
    .prepare(
      `SELECT i.kind, i.key, i.raw, i.display_name FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) AND i.status <> 'detached'`,
    )
    .all(idsJson) as { kind: string; key: string; raw: string | null; display_name: string | null }[];
  for (const i of idents) {
    for (const k of identityKeys(i.kind, i.key, i.raw)) keys.add(k);
    addName(i.display_name);
  }
  const people = db
    .prepare(
      `SELECT p.display_name, p.first_name, p.last_name FROM people p JOIN person_canon pc ON pc.person_id = p.id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?))`,
    )
    .all(idsJson) as { display_name: string; first_name: string | null; last_name: string | null }[];
  for (const p of people) {
    addName(p.display_name);
    addName(`${p.first_name ?? ''} ${p.last_name ?? ''}`);
  }
  if (eventId) for (const n of db.prepare('SELECT name FROM partiful_guest_names WHERE event_id = ?').pluck().all(eventId) as string[]) addName(n);
  for (const n of db.prepare(`SELECT surface FROM occasion_candidates WHERE occasion_id IN (SELECT value FROM json_each(?)) AND surface IS NOT NULL`).pluck().all(chain) as string[]) {
    addName(n);
  }
  const invitees = db
    .prepare(
      `SELECT json_extract(a.value, '$.name') AS name, json_extract(a.value, '$.email') AS email FROM occasion_sources s
         JOIN calendar_events ce ON ce.id = s.source_ref JOIN json_each(ce.attendees) a
       WHERE s.occasion_id IN (SELECT value FROM json_each(?)) AND s.source = 'calendar' AND coalesce(json_extract(a.value, '$.self'), 0) = 0`,
    )
    .all(chain) as { name: string | null; email: string | null }[];
  for (const a of invitees) {
    addName(a.name);
    const m = a.email ? emailMatchKey(a.email) : null;
    if (m) keys.add(`mail:${m}`);
  }
  const maybe = new Set(
    db
      .prepare(
        `SELECT cb.canonical_id FROM match_candidates m
           JOIN person_canon ca ON ca.person_id = m.a_id JOIN person_canon cb ON cb.person_id = m.b_id
         WHERE m.status IN ('pending','possible_duplicate','held') AND ca.canonical_id IN (SELECT value FROM json_each(@ids))
         UNION
         SELECT ca.canonical_id FROM match_candidates m
           JOIN person_canon ca ON ca.person_id = m.a_id JOIN person_canon cb ON cb.person_id = m.b_id
         WHERE m.status IN ('pending','possible_duplicate','held') AND cb.canonical_id IN (SELECT value FROM json_each(@ids))`,
      )
      .pluck()
      .all({ ids: idsJson }) as string[],
  );
  return { ids, keys, names, maybe };
}

/** Whether `personId` (canonical) may already be on the list: same person, a shared identity, a name, a maybe-match. */
export function alreadyInvited(db: DB, g: GuestCheck, personId: string): boolean {
  if (g.ids.has(personId) || g.maybe.has(personId)) return true;
  if (g.keys.size) {
    const idents = db
      .prepare(`SELECT i.kind, i.key, i.raw FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id WHERE pc.canonical_id = ? AND i.status <> 'detached'`)
      .all(personId) as { kind: string; key: string; raw: string | null }[];
    if (idents.some((i) => identityKeys(i.kind, i.key, i.raw).some((k) => g.keys.has(k)))) return true;
  }
  if (!g.names.length) return false;
  const p = db.prepare('SELECT display_name, first_name, last_name FROM people WHERE id = ?').get(personId) as
    | { display_name: string; first_name: string | null; last_name: string | null }
    | undefined;
  if (!p) return false;
  const mine = [nameParts(`${p.first_name ?? ''} ${p.last_name ?? ''}`), nameParts(p.display_name)].filter((x): x is { first: string; last: string } => !!x);
  return mine.some((m) => g.names.some((n) => n.last === m.last && firstNameScore(n.first, m.first) >= 0.9));
}

/**
 * Before a party_invite item goes out (or shows on Today): true when it shouldn't — its Partiful guest list isn't
 * freshly read, or one of its people is on the list by now.
 */
export function partyInviteStale(db: DB, s: { occasionId: string | null; eventId: string | null; personIds: readonly string[] }, now: number): boolean {
  const e: Pick<SocialEvent, 'type' | 'id' | 'eventId'> = s.occasionId ? { type: 'occasion', id: s.occasionId, eventId: s.eventId } : { type: 'event', id: s.eventId ?? '', eventId: null };
  if (!e.id) return true;
  const pe = partifulEventOf(db, e);
  if (pe && !guestListFresh(db, pe, now)) return true;
  const g = guestCheck(db, e);
  const canon = db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck();
  return s.personIds.some((id) => alreadyInvited(db, g, (canon.get(id) as string | undefined) ?? id));
}

/**
 * Visible canonical people among `ids` (never the owner, hidden, merged, roster-only or service people, nor a record
 * of mine still holding one of my handles: identity/self.ts).
 */
function visibleOf(db: DB, ids: Iterable<string>): Set<string> {
  const self = selfPeople(db);
  const list = [...ids].filter((id) => !self.has(id));
  if (!list.length) return new Set();
  return new Set(db.prepare(`SELECT id FROM person_visible WHERE id IN (SELECT value FROM json_each(?))`).pluck().all(JSON.stringify(list)) as string[]);
}

export interface PartyRecord {
  /** Distinct social happenings with the owner in the lookback window (counted attendance). */
  parties: number;
  /** Of those, ones he hosted. */
  hosted: number;
}

/** Who came to the owner's social happenings in [from, to), and how often (one pass over his events). */
export function partyRecords(db: DB, from: number, to: number): Map<string, PartyRecord> {
  const hostedIds = new Set(hostedEvents(db, { startFrom: from, startTo: to }).map((e) => `${e.type}:${e.id}`));
  const out = new Map<string, PartyRecord>();
  for (const e of attendedEvents(db, { startFrom: from, startTo: to })) {
    const hosted = hostedIds.has(`${e.type}:${e.id}`);
    for (const a of knownAttendees(db, { type: e.type, id: e.id, eventId: e.eventId })) {
      if (!a.counted) continue;
      const r = out.get(a.personId) ?? { parties: 0, hosted: 0 };
      r.parties++;
      if (hosted) r.hosted++;
      out.set(a.personId, r);
    }
  }
  return out;
}

export type InviteReason = 'party_invites' | 'party_regular';

export interface InvitePick {
  personId: string;
  reason: InviteReason;
  tie: number | null;
  parties: number;
}

/** Ranks invitees for one hosted event (Party invites first, then close party-goers), at most `limit`. */
export function invitePicks(
  db: DB,
  e: Pick<SocialEvent, 'type' | 'id' | 'eventId'>,
  o: { preferred: ReadonlySet<string>; records: ReadonlyMap<string, PartyRecord>; now: number; limit?: number },
): InvitePick[] {
  const onList = guestCheck(db, e);
  const ok = (id: string) => {
    if (alreadyInvited(db, onList, id)) return false;
    const s = personState(db, id);
    return !s.muted && !s.mutedKinds.includes('party_invite') && !(s.cooldownUntil !== null && s.cooldownUntil > o.now);
  };
  const tieOf = (id: string) => statsOf(db, id).tie;
  const visible = visibleOf(db, [...o.preferred, ...o.records.keys()]);
  const first: InvitePick[] = [...o.preferred]
    .filter((id) => visible.has(id) && ok(id))
    .map((id) => ({ personId: id, reason: 'party_invites' as const, tie: tieOf(id), parties: o.records.get(id)?.parties ?? 0 }))
    .sort((a, b) => (b.tie ?? -1) - (a.tie ?? -1) || b.parties - a.parties || (a.personId < b.personId ? -1 : 1));
  const score = (tie: number, r: PartyRecord) => 0.6 * (tie / 100) + 0.4 * Math.min(1, r.parties / 4) + (r.hosted > 0 ? 0.1 : 0);
  const priority = db.prepare('SELECT is_priority FROM people WHERE id = ?').pluck();
  const closeEnough = (id: string) => {
    const s = statsOf(db, id);
    return meetsCloseness(closenessScore({ tie: s.tie, historical: s.historical, shown: true }), INVITE.minCloseness, { priority: priority.get(id) === 1 });
  };
  const regulars = [...o.records.entries()]
    .filter(([id, r]) => !o.preferred.has(id) && visible.has(id) && (r.parties >= INVITE.minParties || r.hosted > 0))
    .map(([id, r]) => ({ id, r, tie: tieOf(id) ?? 0 }))
    .filter((x) => closeEnough(x.id) && ok(x.id))
    .sort((a, b) => score(b.tie, b.r) - score(a.tie, a.r) || (a.id < b.id ? -1 : 1))
    .map((x): InvitePick => ({ personId: x.id, reason: 'party_regular', tie: x.tie, parties: x.r.parties }));
  return [...first, ...regulars].slice(0, o.limit ?? INVITE.maxPeople);
}

const subjectOf = (e: Pick<SocialEvent, 'type' | 'id'>): string => `${e.type === 'occasion' ? 'occ' : 'event'}:${e.id}`;

export function partyInviteCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const today = localDate(now, timeZone);
  const events = hostedEvents(db, {
    startFrom: dayStart(addDays(today, INVITE.minDaysOut), timeZone),
    startTo: dayStart(addDays(today, INVITE.maxDaysOut + 1), timeZone),
  });
  if (!events.length) return [];
  const preferred = preferredPeople(db, 'party_invites');
  const records = partyRecords(db, now - INVITE.lookbackDays * DAY, now);
  const out: Candidate[] = [];
  for (const e of events) {
    // A Partiful list read more than an hour ago (or not read at all) could miss someone just invited: skip it.
    const pe = partifulEventOf(db, e);
    if (pe && !guestListFresh(db, pe, now)) continue;
    const picks = invitePicks(db, e, { preferred, records, now });
    if (!picks.length) continue;
    const daysOut = daysBetween(today, localDate(e.startsAt, timeZone));
    const guests = knownAttendees(db, { type: e.type, id: e.id, eventId: e.eventId }).filter((a) => a.counted).length;
    out.push({
      kind: 'party_invite',
      personIds: picks.map((p) => p.personId),
      subjectKey: subjectOf(e),
      // Invitations need lead time: the closer it is, the more it matters today.
      base: daysOut <= 5 ? 0.8 : 0.7,
      evidenceIds: [subjectOf(e)],
      expiresAt: e.startsAt,
      links: e.type === 'occasion' ? { occasionId: e.id, eventId: e.eventId } : { eventId: e.id },
      payload: {
        startsAt: e.startsAt,
        daysOut,
        guestCount: guests,
        partyInvites: picks.filter((p) => p.reason === 'party_invites').length,
        reasons: picks.map((p) => p.reason),
      },
    });
  }
  return out;
}
