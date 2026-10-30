/**
 * Event intel (intelligence §5 "Event intel"; the critic's resolution: the brief arrives the MORNING OF the event,
 * with a generic push 3 h before same-day events):
 *
 *   pre_event_brief  in the morning digest for a social occasion / Partiful event later today with ≥ 2 known
 *                    (counted) attendees: the top 5 attendees, Party invites people first, then by tie strength.
 *                    Time-critical (within 36 h).
 *   pre-event push   (job 'pre-event-push', every 15 min) one push per event, 30 min – 3 h before a same-day event
 *                    with ≥ 2 known attendees: "Something on your calendar in about 3 hours · your brief is ready",
 *                    no names, no title, opening /e/<id>/brief. Only with push.enabled + push.pre_event, never in
 *                    quiet hours, once per event (push_log 'pre_event:<id>').
 *   event_followup   the morning after a social occasion / Partiful event the owner went to: up to 3 people
 *                    (Party invites people first within each group) —
 *                      1. new people (first time together, no 1:1 history) → "say hi / save details",
 *                      2. known people who had gone quiet (silence before the event ≥ 2× their usual gap, or a
 *                         fading / cooling / dormant state) → "great seeing you",
 *                      3. the host (not the owner) with 20 ≤ T ≤ 70 → a thank-you.
 *                    Only people with a documented intent to follow up (a promise or reminder about them made from
 *                    2 days before the event on: obligations followUpPeople); the owner doesn't want reminders
 *                    about events that are over otherwise.
 * Generators are pure readers; the push tick writes only push_log / push_subscriptions (through pushToDevices).
 */
import { localParts, PushPayload } from '@yb/shared';
import type { DB } from '../db/connection';
import { pushToDevices } from '../delivery/push';
import type { PushSender } from '../delivery/types';
import { nullLogger, type Logger } from '../ops/logger';
import type { Candidate } from '../pipeline/suggestions/types';
import { inLocalWindow, settingsSnapshot, type SettingsSnapshot } from '../settings/registry';
import { DAY, HOUR, addDays, attendedEvents, dayStart, knownAttendees, localDate, statsOf, unknownGuestNames, type KnownAttendee, type SocialEvent } from './common';
import { preferredPeople } from '../pipeline/circles/preferences';
import { followUpPeople } from '../pipeline/obligations/commitments';
import { occasionChain } from '../pipeline/occasions/build';

/** Known (counted) attendees an event needs for a brief or a push. */
export const MIN_KNOWN_ATTENDEES = 2;
export const BRIEF_PEOPLE = 5;
export const FOLLOWUP_PEOPLE = 3;
export const PRE_EVENT_PUSH = { leadMs: 3 * HOUR, minLeadMs: 30 * 60_000 } as const;

const refOf = (e: SocialEvent) => ({ type: e.type, id: e.id, eventId: e.eventId });
export const subjectOf = (e: Pick<SocialEvent, 'type' | 'id'>): string => `${e.type === 'occasion' ? 'occ' : 'event'}:${e.id}`;
const linksOf = (e: SocialEvent) => (e.type === 'occasion' ? { occasionId: e.id, eventId: e.eventId } : { eventId: e.id });

/**
 * Counted attendees ordered for briefs and follow-ups: people in the Party invites circle (the owner asked to put
 * them first for parties and events) lead, then tie strength (T desc), then confidence.
 */
export function byTie(db: DB, attendees: readonly KnownAttendee[], first: ReadonlySet<string> = preferredPeople(db, 'party_invites')): KnownAttendee[] {
  const t = new Map(attendees.map((a) => [a.personId, statsOf(db, a.personId).tie ?? -1]));
  const lead = (a: KnownAttendee) => (first.has(a.personId) ? 1 : 0);
  return [...attendees].sort(
    (a, b) => lead(b) - lead(a) || t.get(b.personId)! - t.get(a.personId)! || b.confidence - a.confidence || (a.personId < b.personId ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------------------------- pre-event

/** Today's (local) upcoming social events with ≥ 2 known attendees. */
export function briefableToday(db: DB, now: number, timeZone: string): { event: SocialEvent; counted: KnownAttendee[]; all: KnownAttendee[] }[] {
  const today = localDate(now, timeZone);
  const end = dayStart(addDays(today, 1), timeZone);
  const out: { event: SocialEvent; counted: KnownAttendee[]; all: KnownAttendee[] }[] = [];
  for (const e of attendedEvents(db, { startFrom: now, startTo: end })) {
    const all = knownAttendees(db, refOf(e));
    const counted = all.filter((a) => a.counted);
    if (counted.length >= MIN_KNOWN_ATTENDEES) out.push({ event: e, counted: byTie(db, counted), all });
  }
  return out;
}

export function preEventCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  return briefableToday(db, now, timeZone).map(({ event, counted, all }) => ({
    kind: 'pre_event_brief',
    personIds: counted.slice(0, BRIEF_PEOPLE).map((a) => a.personId),
    subjectKey: subjectOf(event),
    base: 0.8,
    evidenceIds: [subjectOf(event)],
    expiresAt: event.startsAt,
    timeCritical: true,
    links: linksOf(event),
    payload: {
      startsAt: event.startsAt,
      attendeeCount: counted.length,
      possibleCount: all.length - counted.length,
      unknownGuests: unknownGuestNames(db, refOf(event)).length,
    },
  }));
}

// ---------------------------------------------------------------------------------------------- follow-up

const COUNTED_SQL = `('going','approved','checked_in','attended','host')`;

/** Counted at an earlier happening the owner went to (an active occasion, or a Partiful event he RSVP'd to). */
function togetherBefore(db: DB, personId: string, e: SocialEvent): boolean {
  const chain = e.type === 'occasion' ? occasionChain(db, e.id) : [];
  return !!db
    .prepare(
      `SELECT 1 FROM event_attendees a
       JOIN person_canon pc ON pc.person_id = a.person_id
       LEFT JOIN occasions o ON o.id = a.occasion_id
       LEFT JOIN events ev ON ev.id = a.event_id
       WHERE pc.canonical_id = @pid AND lower(a.status) IN ${COUNTED_SQL} AND a.confidence >= 0.75
         AND coalesce(o.starts_at, ev.starts_at) < @before
         AND (a.occasion_id IS NULL OR (o.status = 'active' AND a.occasion_id NOT IN (SELECT value FROM json_each(@chain))))
         AND (a.event_id IS NULL OR (a.event_id <> coalesce(@event, '') AND (lower(coalesce(ev.my_rsvp, '')) IN ('going','approved','checked_in','attended')
              OR lower(coalesce(ev.my_role, '')) IN ('host','co_host','cohost'))))
       LIMIT 1`,
    )
    .get({ pid: personId, before: e.startsAt, chain: JSON.stringify(chain), event: e.type === 'event' ? e.id : e.eventId });
}

/** Any 1:1 history: a DM session, call, log entry, or a message in a direct conversation. */
function hasOneToOne(db: DB, personId: string): boolean {
  if (
    db
      .prepare(
        `SELECT 1 FROM interactions i JOIN person_canon pc ON pc.person_id = i.person_id
         WHERE pc.canonical_id = ? AND i.kind IN ('dm_session','call','manual','text_log','legacy_text') AND i.retracted_at IS NULL LIMIT 1`,
      )
      .get(personId)
  ) {
    return true;
  }
  return !!db
    .prepare(
      `SELECT 1 FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN conversation_members cm ON cm.identity_id = i.id JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
       WHERE pc.canonical_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) LIMIT 1`,
    )
    .get(personId);
}

/** Silence (days) before `at` since the last 1:1 touch, or null without one. */
function silenceBefore(db: DB, personId: string, at: number): number | null {
  const last = db
    .prepare(
      `SELECT max(i.started_at) FROM interactions i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id = ? AND i.kind IN ('dm_session','call','manual','text_log','legacy_text') AND i.retracted_at IS NULL AND i.started_at < ?`,
    )
    .pluck()
    .get(personId, at) as number | null;
  return last ? (at - last) / DAY : null;
}

export type FollowupRole = 'new' | 'fading' | 'host';

export interface FollowupPick {
  personId: string;
  role: FollowupRole;
}

/** Up to 3 people to follow up with after `e` (new → quiet → host). */
export function followupPicks(db: DB, e: SocialEvent, counted: readonly KnownAttendee[]): FollowupPick[] {
  const ordered = byTie(db, counted);
  const roles = new Map<string, FollowupRole>();
  for (const a of ordered) {
    if (!togetherBefore(db, a.personId, e) && !hasOneToOne(db, a.personId)) roles.set(a.personId, 'new');
  }
  for (const a of ordered) {
    if (roles.has(a.personId)) continue;
    const s = statsOf(db, a.personId);
    const quietBefore = silenceBefore(db, a.personId, e.startsAt);
    const fadingState = s.state === 'fading' || s.state === 'cooling' || s.state === 'dormant';
    if (fadingState || (quietBefore !== null && s.expectedGapD !== null && s.expectedGapD > 0 && quietBefore >= 2 * s.expectedGapD)) roles.set(a.personId, 'fading');
  }
  for (const a of ordered) {
    if (roles.has(a.personId)) continue;
    const hostish = a.role === 'host' || a.role === 'co_host' || a.status === 'host';
    const t = statsOf(db, a.personId).tie ?? 0;
    if (hostish && t >= 20 && t <= 70) roles.set(a.personId, 'host');
  }
  const rank: Record<FollowupRole, number> = { new: 0, fading: 1, host: 2 };
  return ordered
    .filter((a) => roles.has(a.personId))
    .map((a) => ({ personId: a.personId, role: roles.get(a.personId)! }))
    .sort((x, y) => rank[x.role] - rank[y.role])
    .slice(0, FOLLOWUP_PEOPLE);
}

/** Happenings that ended "last night": since yesterday's local midnight, at least 3 h ago, at most 06:00 today. */
export function followupWindow(now: number, timeZone: string): { from: number; to: number; today: string } {
  const today = localDate(now, timeZone);
  const todayStart = dayStart(today, timeZone);
  return { from: dayStart(addDays(today, -1), timeZone), to: Math.min(now - 3 * HOUR, todayStart + 6 * HOUR) + 1, today };
}

export function followupCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const w = followupWindow(now, timeZone);
  if (w.to <= w.from) return [];
  const out: Candidate[] = [];
  for (const e of attendedEvents(db, { endFrom: w.from, endTo: w.to })) {
    const counted = knownAttendees(db, refOf(e)).filter((a) => a.counted);
    if (!counted.length) continue;
    const intent = followUpPeople(db, counted.map((a) => a.personId), e.startsAt - 2 * DAY, now);
    const picks = followupPicks(db, e, counted).filter((p) => intent.has(p.personId));
    if (!picks.length) continue;
    out.push({
      kind: 'event_followup',
      personIds: picks.map((p) => p.personId),
      subjectKey: subjectOf(e),
      base: 0.7,
      evidenceIds: [subjectOf(e)],
      expiresAt: dayStart(addDays(w.today, 3), timeZone),
      links: linksOf(e),
      payload: {
        endedAt: e.endsAt,
        attendeeCount: counted.length,
        newPeople: picks.filter((p) => p.role === 'new').length,
        fadingPeople: picks.filter((p) => p.role === 'fading').length,
        host: picks.some((p) => p.role === 'host'),
        roles: picks.map((p) => p.role),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- push

export interface PushTickResult {
  status: 'ok' | 'skipped';
  reason: 'disabled' | 'not_configured' | 'quiet_hours' | null;
  considered: number;
  pushed: number;
  devices: number;
}

const pushKey = (e: Pick<SocialEvent, 'id'>) => `pre_event:${e.id}`;

/** The generic lock-screen text (no names, no titles, whatever the names setting says). */
export function preEventPushBody(startsAt: number, now: number): string {
  const h = Math.max(1, Math.round((startsAt - now) / HOUR));
  return `Something on your calendar in about ${h === 1 ? 'an hour' : `${h} hours`} · your brief is ready`;
}

/** One pre-event push tick (job 'pre-event-push'). Never throws for delivery outcomes. */
export async function preEventPushTick(db: DB, push: PushSender, o: { now: number; log?: Logger; settings?: SettingsSnapshot }): Promise<PushTickResult> {
  const s = o.settings ?? settingsSnapshot(db);
  const log = o.log ?? nullLogger;
  const res = (r: Partial<PushTickResult> & Pick<PushTickResult, 'status'>): PushTickResult => ({ reason: null, considered: 0, pushed: 0, devices: 0, ...r });
  if (!s['push.enabled'] || !s['push.pre_event']) return res({ status: 'skipped', reason: 'disabled' });
  if (!push.configured) return res({ status: 'skipped', reason: 'not_configured' });
  const tz = s.tz;
  if (inLocalWindow(localParts(o.now, tz).hhmm, s.quiet_hours.start, s.quiet_hours.end)) return res({ status: 'skipped', reason: 'quiet_hours' });
  const today = localDate(o.now, tz);
  let considered = 0;
  let pushed = 0;
  let devices = 0;
  for (const e of attendedEvents(db, { startFrom: o.now + PRE_EVENT_PUSH.minLeadMs, startTo: o.now + PRE_EVENT_PUSH.leadMs + 1 })) {
    if (localDate(e.startsAt, tz) !== today) continue;
    const counted = knownAttendees(db, refOf(e)).filter((a) => a.counted);
    if (counted.length < MIN_KNOWN_ATTENDEES) continue;
    considered++;
    // Claim the event first: a crash after this never pushes twice.
    const claimed = db.prepare(`INSERT OR IGNORE INTO push_log (key, kind, sent, created_at) VALUES (?, 'pre_event', 0, ?)`).run(pushKey(e), o.now).changes > 0;
    if (!claimed) continue;
    const payload = PushPayload.parse({
      kind: 'pre_event',
      title: 'Yeackbot',
      body: preEventPushBody(e.startsAt, o.now),
      url: `/e/${e.id}/brief`,
      tag: pushKey(e).slice(0, 64),
    });
    const r = await pushToDevices(db, push, payload, { now: () => o.now, log, ttlSeconds: Math.max(60, Math.round((e.startsAt - o.now) / 1000)), urgency: 'normal' });
    db.prepare('UPDATE push_log SET sent = ? WHERE key = ?').run(r.sent, pushKey(e));
    if (r.sent) pushed++;
    devices += r.sent;
  }
  return res({ status: 'ok', considered, pushed, devices });
}


