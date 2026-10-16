/**
 * A synthetic calendar world modeled on the PLAN's "observed shape" of the owner's calendar: self-created events
 * with people in the title or notes, Gmail "Reservation at <venue>" duplicates, a Partiful link + feed copy, a
 * shared community calendar, logistics and medical appointments. Every name, number, address, venue and id is
 * invented (555-01xx phones, example.com emails).
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../../src/db/canon';
import type { DB } from '../../../src/db/connection';
import { memDb, seedIdentity, seedPerson } from '../../helpers';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** "Now" for the occasion tests: 2026-10-14 12:00 UTC (tests run with timeZone 'UTC'). */
export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
export const TZ = 'UTC';
/** 19:00 UTC, `days` from NOW's date. */
export const evening = (days: number, h = 19, m = 0) => Date.UTC(2026, 9, 14 + days, h, m, 0);

// Google calendar ids have the shape of addresses; built here so the PII lint doesn't read them as emails.
const at = (local: string, domain: string) => [local, domain].join('@');
export const CAL = {
  personal: 'owner@example.com',
  feed: at('feedcal0001', 'import.calendar.google.com'),
  community: at('communitycal0001', 'group.calendar.google.com'),
  holidays: at('en.usa#holiday', 'group.v.calendar.google.com'),
};
/** The Partiful feed's iCal UID shape: <event id>@partiful.com */
export const partifulUid = (id: string) => at(id, 'partiful.com');

export interface CalInput {
  calendar?: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  start: number;
  end?: number;
  allDay?: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  icalUid?: string | null;
  creator?: string | null;
  attendees?: unknown[];
  eventType?: string;
  partifulEventId?: string | null;
}

export function calEvent(db: DB, e: CalInput): string {
  const id = uuidv7();
  const calendar = e.calendar ?? CAL.personal;
  db.prepare(
    `INSERT INTO calendar_events (id, calendar_id, google_event_id, ical_uid, status, summary, description, location, starts_at, ends_at,
       all_day, creator_email, organizer_email, attendees, partiful_event_id, raw, ingested_at, updated_at)
     VALUES (@id, @calendar, @gid, @uid, @status, @summary, @description, @location, @start, @end, @allDay, @creator, @creator,
       @attendees, @partiful, @raw, @now, @now)`,
  ).run({
    id,
    calendar,
    gid: `g${id.replace(/-/g, '').slice(-12)}`,
    uid: e.icalUid ?? null,
    status: e.status ?? 'confirmed',
    summary: e.summary,
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start,
    end: e.end ?? e.start + 2 * HOUR,
    allDay: e.allDay ? 1 : 0,
    creator: e.creator === undefined ? (calendar === CAL.personal ? CAL.personal : null) : e.creator,
    attendees: JSON.stringify(e.attendees ?? []),
    partiful: e.partifulEventId ?? null,
    raw: JSON.stringify(e.eventType ? { eventType: e.eventType } : {}),
    now: NOW - 30 * DAY,
  });
  return id;
}

export function updateCalEvent(db: DB, id: string, patch: Partial<{ starts_at: number; ends_at: number; status: string; summary: string; location: string | null; calendar_id: string }>) {
  const cols = Object.keys(patch);
  db.prepare(`UPDATE calendar_events SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
}

export interface Conv {
  id: string;
  identity: string;
}

export class Chat {
  constructor(
    private readonly db: DB,
    readonly id: string,
  ) {}
  /** A message from `from` (an identity id) or from me (null). Returns messages.id. */
  say(at: number, from: string | null, text: string, kind: 'text' | 'attachment' = 'text'): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
           VALUES ('imessage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uuidv7(), this.id, from, from ? 0 : 1, at, kind, kind === 'attachment' ? null : text, NOW, NOW).lastInsertRowid,
    );
  }
}

export function chat(db: DB, kind: 'direct' | 'group', members: string[], title: string | null = null): Chat {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at) VALUES (?, 'imessage', ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, kind, title, members.length + 1, NOW - 400 * DAY, NOW);
  const ins = db.prepare(
    `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
  );
  for (const m of members) ins.run(id, m, NOW - 400 * DAY, NOW);
  return new Chat(db, id);
}

export interface Person {
  id: string;
  phone: string;
  dm: Chat;
}

export interface World {
  db: DB;
  me: string;
  quillA: Person;
  quillB: Person;
  romy: Person;
  tavi: Person;
  ines: { id: string };
  sol: { id: string };
  pim: { id: string };
  hallie: Person;
  crew: Chat;
  partifulEvent: string;
  partifulOnly: string;
  ev: Record<string, string>;
}

export function buildWorld(): World {
  const db = memDb();
  const person = (first: string, last: string, phone: string | null, extra: Record<string, unknown> = {}) => {
    const id = seedPerson(db, { first_name: first, last_name: last, display_name: `${first} ${last}`, ...extra });
    return { id, phone: phone ? seedIdentity(db, id, 'phone', phone) : '' };
  };
  const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null });
  seedIdentity(db, me, 'email', 'owner@example.com');

  const withDm = (p: { id: string; phone: string }): Person => ({ ...p, dm: chat(db, 'direct', [p.phone]) });
  const quillA = withDm(person('Quill', 'Ashby', '+15555550111'));
  const quillB = withDm(person('Quill', 'Brandt', '+15555550112'));
  const romy = withDm(person('Romy', 'Castell', '+15555550113'));
  const tavi = withDm(person('Tavi', 'Dunmore', '+15555550114'));
  const hallie = withDm(person('Hallie', 'Grove', '+15555550119', { is_hidden: 1 }));
  const ines = person('Ines', 'Farrow', null);
  seedIdentity(db, ines.id, 'email', 'ines.farrow@example.com');
  const sol = person('Sol', 'Hart', null);
  const pim = person('Pim', 'Iver', null);
  rebuildPersonCanon(db);

  const crew = chat(db, 'group', [romy.phone, tavi.phone, quillA.phone], 'Climbing Crew 🧗');

  // Recent 1:1 history (both Quills have some; Quill Ashby's is around the drinks).
  romy.dm.say(evening(-40), romy.phone, 'hey how was the trip');
  tavi.dm.say(evening(-35), null, 'sending you the photos soon');
  quillB.dm.say(evening(-200), quillB.phone, 'long time no talk');
  quillA.dm.say(evening(-60), quillA.phone, 'we should catch up soon');

  // Partiful event (ingested by the Partiful adapter) + guest list (episodes on the event).
  const partifulEvent = uuidv7();
  db.prepare(
    `INSERT INTO events (id, source, source_event_id, title, starts_at, ends_at, location_text, url, my_rsvp, created_at, updated_at)
     VALUES (?, 'partiful', 'PtyEvt0001', 'Housewarming at the loft', ?, ?, 'Birch Loft', 'https://partiful.com/e/PtyEvt0001', 'GOING', ?, ?)`,
  ).run(partifulEvent, evening(-3, 20), evening(-3, 23), NOW, NOW);
  const guest = db.prepare(
    `INSERT INTO event_attendees (id, event_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'partiful', 1, ?, ?)`,
  );
  guest.run(uuidv7(), partifulEvent, sol.id, 'going', 'host', NOW, NOW);
  guest.run(uuidv7(), partifulEvent, pim.id, 'maybe', 'guest', NOW, NOW);
  guest.run(uuidv7(), partifulEvent, hallie.id, 'going', 'guest', NOW, NOW);
  // A Partiful event with no calendar copy.
  const partifulOnly = uuidv7();
  db.prepare(
    `INSERT INTO events (id, source, source_event_id, title, starts_at, ends_at, location_text, my_rsvp, created_at, updated_at)
     VALUES (?, 'partiful', 'PtyEvt0002', 'Picnic in the park', ?, ?, 'Juniper Park', 'going', ?, ?)`,
  ).run(partifulOnly, evening(5, 13), evening(5, 16), NOW, NOW);
  guest.run(uuidv7(), partifulOnly, romy.id, 'going', 'guest', NOW, NOW);

  const ev: Record<string, string> = {};
  // 1. "Drinks w/ Quill": two Quills; messages settle it on Quill Ashby.
  ev.drinks = calEvent(db, { summary: 'Drinks w/ Quill', location: 'Moss & Fern, 1 Example St, Springfield', start: evening(-10) });
  quillA.dm.say(evening(-11, 15), null, 'drinks tmrw at moss & fern?');
  quillA.dm.say(evening(-11, 15, 5), quillA.phone, 'yes!! 7?');
  quillA.dm.say(evening(-10, 18, 55), quillA.phone, 'omw, 5 min away');
  quillA.dm.say(evening(-9, 10), quillA.phone, 'so good catching up last night');

  // 2. Gmail reservation + own dinner event without a venue → one occasion.
  ev.dinner = calEvent(db, { summary: 'Dinner w/ Romy & Tavi', start: evening(-5) });
  ev.reservation = calEvent(db, {
    summary: 'Reservation at Lupine Room',
    location: 'Lupine Room, 2 Example Ave, Springfield',
    start: evening(-5, 19, 30),
    eventType: 'fromGmail',
    creator: null,
  });
  tavi.dm.say(evening(-5, 19, 10), tavi.phone, 'here, grabbed a table in the back');

  // 3. Own event with a Partiful link + the Partiful feed copy.
  ev.party = calEvent(db, { summary: "Sol's housewarming", description: 'RSVP https://partiful.com/e/PtyEvt0001', start: evening(-3, 20), end: evening(-3, 23) });
  ev.partyFeed = calEvent(db, {
    calendar: CAL.feed,
    summary: 'Housewarming at the loft',
    location: 'Birch Loft',
    start: evening(-3, 20),
    end: evening(-3, 23),
    icalUid: partifulUid('PtyEvt0001'),
    creator: null,
  });

  // 4. Shared community calendar: one uncorroborated, one corroborated by my own message.
  ev.potluck = calEvent(db, { calendar: CAL.community, summary: 'Community potluck', location: 'Elm Hall', start: evening(-7, 18), creator: 'organizer@example.com' });
  ev.trivia = calEvent(db, {
    calendar: CAL.community,
    summary: 'Trivia night',
    location: 'The Copper Kettle, 9 Example Rd',
    start: evening(-2, 20),
    creator: 'organizer@example.com',
  });
  crew.say(evening(-2, 12), null, 'trivia at the copper kettle tonight? who is in');
  crew.say(evening(-2, 12, 10), romy.phone, 'in! copper kettle at 8');

  // 5. Logistics and appointments.
  ev.maid = calEvent(db, { summary: 'Maid service', start: evening(-4, 10) });
  ev.dentist = calEvent(db, { summary: 'Dentist cleaning', location: 'Example Dental', start: evening(-6, 9) });
  ev.hoa = calEvent(db, { summary: 'HOA meeting', start: evening(-1, 18) });

  // 6. Concert with a ticket holder and a ticket count; Romy texts about it (unnamed companion, over the cap).
  ev.concert = calEvent(db, {
    summary: 'Fernhollow concert',
    location: 'Copperline Hall',
    description: 'Tavi has my ticket<br>2 tickets',
    start: evening(-8, 20),
    end: evening(-8, 23),
  });
  romy.dm.say(evening(-9, 12), romy.phone, 'are you going to fernhollow at copperline hall tmrw?');
  romy.dm.say(evening(-8, 20, 30), romy.phone, 'where are you? near the stage');
  romy.dm.say(evening(-7, 11), romy.phone, 'fun night! the encore was wild');

  // 7. Explicit invitee (email → identity), and a hidden person in a title.
  ev.games = calEvent(db, {
    summary: 'Board games',
    start: evening(-12),
    attendees: [
      { email: 'owner@example.com', self: true, responseStatus: 'accepted' },
      { email: 'ines.farrow@example.com', displayName: 'Ines Farrow', responseStatus: 'accepted' },
      { email: 'someone.new@example.com', displayName: 'Unknown Guest', responseStatus: 'needsAction' },
    ],
  });
  ev.lunchHidden = calEvent(db, { summary: 'Lunch w/ Hallie', start: evening(-15, 12) });
  hallie.dm.say(evening(-15, 11, 50), hallie.phone, 'omw to lunch');

  // 8. Upcoming plans and an excluded calendar.
  ev.brunch = calEvent(db, { summary: 'Brunch w/ Romy', start: evening(3, 11) });
  ev.holiday = calEvent(db, { calendar: CAL.holidays, summary: 'Columbus Day', start: Date.UTC(2026, 9, 12), end: Date.UTC(2026, 9, 13), allDay: true, creator: null });
  ev.crewDinner = calEvent(db, { summary: 'Dinner w/ the Climbing Crew', start: evening(-20) });
  ev.hotel = calEvent(db, { summary: 'Stay at Example Inn', location: 'Example Inn, Lakeside', start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 27), allDay: true });

  return { db, me, quillA, quillB, romy, tavi, ines, sol, pim, hallie, crew, partifulEvent, partifulOnly, ev };
}

/** The occasion an event belongs to. */
export function occasionOf(db: DB, calEventId: string): string | undefined {
  return db.prepare(`SELECT occasion_id FROM occasion_sources WHERE source = 'calendar' AND source_ref = ?`).pluck().get(calEventId) as string | undefined;
}

export interface AttRow {
  person_id: string;
  status: string;
  source: string;
  confidence: number;
  role: string | null;
  evidence: string;
  id: string;
}

export function attendeesOf(db: DB, occasionId: string): AttRow[] {
  return db.prepare('SELECT id, person_id, status, source, confidence, role, evidence FROM event_attendees WHERE occasion_id = ? ORDER BY person_id').all(occasionId) as AttRow[];
}
