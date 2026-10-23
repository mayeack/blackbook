import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PartifulClient, RateGate } from '../../../src/adapters/partiful/client';
import { PartifulContractError, SIGN_IN_MESSAGE } from '../../../src/adapters/partiful/errors';
import { refreshHostedGuests, syncPartiful, syncPartifulContacts, type SyncOptions } from '../../../src/adapters/partiful/ingest';
import { partifulJobs } from '../../../src/adapters/partiful/jobs';
import { PartifulAuth, storeSession } from '../../../src/adapters/partiful/session';
import { canonicalId } from '../../../src/db/canon';
import { undoRun } from '../../../src/journal/undo';
import { createLogger, memorySink } from '../../../src/ops/logger';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { memDb, seedIdentity, seedMessage, seedPerson } from '../../helpers';
import { ticketEvent, ticketOccasion } from '../../intel/eventInviteWorld';
import {
  CASEY,
  DAY,
  DREW,
  FakeBrowser,
  fakeConnect,
  fakeIndexedDB,
  FakePage,
  FakePartiful,
  HOST,
  iso,
  JORDAN,
  LEE,
  ME,
  REFRESH,
  API_KEY,
  ROBIN,
  SAM,
  seedWorld,
  SESSION,
  signedInStores,
  T0,
} from './fakePartiful';

type DB = ReturnType<typeof memDb>;
const fakes: FakePartiful[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(o: { me?: boolean } = {}) {
  const f = new FakePartiful();
  fakes.push(f);
  seedWorld(f);
  const db = memDb();
  const k = crypto.randomBytes(32);
  storeSession(db, k, SESSION, T0);
  const meId = o.me === false ? null : seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
  // People the address book / Beeper already know, by Instagram handle.
  const robin = seedPerson(db, { display_name: 'Robin Example', first_name: 'Robin', last_name: 'Example', origin: 'addressbook' });
  seedIdentity(db, robin, 'instagram_username', 'robin.example', { source: 'beeper' });
  const taylor = seedPerson(db, { display_name: 'Taylor Other', first_name: 'Taylor', last_name: 'Other', origin: 'addressbook' });
  seedIdentity(db, taylor, 'instagram_username', 'taken.handle', { source: 'beeper' });
  const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: null, dispatcher: f.agent });
  const client = (maxCalls?: number) => new PartifulClient({ auth, dispatcher: f.agent, gate: new RateGate(0), maxCalls });
  const sync = (now: number, opts: SyncOptions = {}, maxCalls?: number) => syncPartiful(db, client(maxCalls), { now, ...opts });
  return { f, db, k, meId, robin, taylor, auth, client, sync };
}

const one = <T>(db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const all = <T>(db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const count = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

const personOfUser = (db: DB, uid: string) =>
  db.prepare(`SELECT person_id FROM identities WHERE kind = 'partiful_user' AND key = ?`).pluck().get(uid) as string | undefined;
const eventRow = (db: DB, sid: string) => one<{ id: string }>(db, `SELECT id FROM events WHERE source = 'partiful' AND source_event_id = ?`, sid).id;
const attendees = (db: DB, sid: string) =>
  all<{ person_id: string; status: string; role: string; invited_by_person_id: string | null; plus_one_of_person_id: string | null; source: string }>(
    db,
    `SELECT a.person_id, a.status, a.role, a.invited_by_person_id, a.plus_one_of_person_id, a.source FROM event_attendees a
     JOIN events e ON e.id = a.event_id WHERE e.source_event_id = ?`,
    sid,
  );
const edge = (db: DB, a: string, b: string, type: string, sid: string) => {
  const ca = canonicalId(db, a);
  const cb = canonicalId(db, b);
  const directed = type === 'invited_by' || type === 'plus_one';
  const [x, y] = directed || ca < cb ? [ca, cb] : [cb, ca];
  return db.prepare('SELECT w_raw FROM edge_evidence WHERE a_id = ? AND b_id = ? AND type = ? AND ref = ?').pluck().get(x, y, type, `event:${eventRow(db, sid)}`) as
    | number
    | undefined;
};

describe('syncPartiful: a synthetic world', () => {
  it('events, guest lists, identities, the Instagram link, edges and health', async () => {
    const { f, db, meId, robin, taylor, sync } = setup();
    const r = await sync(T0);
    expect(r.health).toBe('ok');
    expect(r.partial).toBe(false);

    // Events: every list, deduped; my role and RSVP; visibility flags; times parsed.
    const events = all<Record<string, unknown>>(
      db,
      `SELECT source_event_id, my_role, my_rsvp, status, url, visibility, starts_at, location_text, tz FROM events WHERE source = 'partiful' ORDER BY source_event_id`,
    );
    expect(events.map((e) => e.source_event_id)).toEqual(['evtCancel001', 'evtHidden001', 'evtHosted001', 'evtPast0001']);
    const byId = Object.fromEntries(events.map((e) => [e.source_event_id, e]));
    expect(byId.evtHosted001).toMatchObject({ my_role: 'host', my_rsvp: 'going' });
    expect(byId.evtPast0001).toMatchObject({
      my_role: 'guest',
      my_rsvp: 'going',
      status: 'published',
      url: 'https://partiful.com/e/evtPast0001',
      starts_at: T0 - 30 * DAY,
      location_text: 'Example Rooftop',
      tz: 'America/New_York',
    });
    expect(byId.evtCancel001!.status).toBe('canceled');
    expect(JSON.parse(String(byId.evtHidden001!.visibility))).toMatchObject({ showGuestList: false });

    // Guest lists: only the visible, live events; hidden / canceled ones are never requested.
    expect(f.fnCalls('getGuests').map((c) => c.params.eventId).sort()).toEqual(['evtHosted001', 'evtPast0001']);
    expect(f.fnCalls('getGuests').every((c) => c.params.includeInvitedGuests === true && c.paging?.maxResults === 500)).toBe(true);
    const state = Object.fromEntries(all<{ event_id: string; guests_status: string }>(db, 'SELECT event_id, guests_status FROM partiful_event_sync').map((s) => [s.event_id, s.guests_status]));
    expect(state).toEqual({ evtPast0001: 'ok', evtHosted001: 'ok', evtHidden001: 'hidden', evtCancel001: 'skipped' });

    // Attendees: statuses mapped, roles, who invited whom, plus-ones; the SMS-only invitee and I aren't rows.
    const avery = personOfUser(db, HOST)!;
    const robinP = personOfUser(db, ROBIN)!;
    const past = attendees(db, 'evtPast0001');
    const byPerson = Object.fromEntries(past.map((a) => [a.person_id, a]));
    expect(past).toHaveLength(5);
    expect(byPerson[avery]).toMatchObject({ status: 'going', role: 'host', source: 'partiful' });
    expect(byPerson[robinP]).toMatchObject({ status: 'going', role: 'guest', invited_by_person_id: avery });
    expect(byPerson[personOfUser(db, SAM)!]).toMatchObject({ status: 'maybe', invited_by_person_id: robinP });
    expect(byPerson[personOfUser(db, JORDAN)!]).toMatchObject({ status: 'declined' });
    expect(byPerson[personOfUser(db, CASEY)!]).toMatchObject({ status: 'going', role: 'plus_one', plus_one_of_person_id: robinP });
    expect(past.some((a) => a.person_id === meId)).toBe(false);
    const hosted = Object.fromEntries(attendees(db, 'evtHosted001').map((a) => [a.person_id, a.status]));
    expect(hosted).toEqual({ [robinP]: 'going', [personOfUser(db, DREW)!]: 'invited', [personOfUser(db, LEE)!]: 'maybe' });

    // §1.4: guests of my party and the host who invited me are people; other guests stay roster-only.
    const status = (uid: string) => one<{ status: string }>(db, 'SELECT status FROM people WHERE id = ?', personOfUser(db, uid)).status;
    expect(status(HOST)).toBe('provisional');
    expect(status(DREW)).toBe('provisional');
    expect(status(LEE)).toBe('provisional');
    expect(status(SAM)).toBe('roster_only');
    expect(status(CASEY)).toBe('roster_only');
    expect(one<{ display_name: string }>(db, 'SELECT display_name FROM people WHERE id = ?', avery).display_name).toBe('Avery Example');

    // My Partiful account is mine.
    expect(personOfUser(db, ME)).toBe(meId);

    // Profiles: socials.instagram linked Robin to the known person (compatible first name), attached Sam's new
    // handle, and left Jordan alone (the handle belongs to someone with another first name).
    expect(f.fnCalls('getUsers')).toHaveLength(1);
    expect((f.fnCalls('getUsers')[0]!.params.ids as string[]).sort()).toEqual([CASEY, DREW, HOST, JORDAN, LEE, ROBIN, SAM].sort());
    expect(canonicalId(db, robinP)).toBe(robin);
    expect(count(db, `SELECT count(*) FROM merges WHERE survivor_id = ? AND merged_id = ? AND method = 'deterministic'`, robin, robinP)).toBe(1);
    const samIg = one<{ person_id: string; source: string }>(db, `SELECT person_id, source FROM identities WHERE kind = 'instagram_username' AND key = 'sam.sample.ig'`);
    expect(samIg).toEqual({ person_id: personOfUser(db, SAM), source: 'partiful' });
    expect(canonicalId(db, personOfUser(db, JORDAN)!)).not.toBe(taylor);
    const links = Object.fromEntries(all<{ user_id: string; ig_link: string | null }>(db, 'SELECT user_id, ig_link FROM partiful_users').map((u) => [u.user_id, u.ig_link]));
    expect(links).toMatchObject({ [ROBIN]: 'linked', [SAM]: 'attached', [JORDAN]: 'incompatible', [HOST]: null });
    expect(r.stats).toMatchObject({ ig_handles: 3, ig_linked: 1, ig_attached: 1, ig_incompatible: 1 });

    // Edges (canonical ids; me excluded): co_attend s_a·s_b/log2(1+going), invited_by 1.5, plus_one 3.0.
    const lg5 = Math.log2(5);
    expect(edge(db, avery, robin, 'co_attend', 'evtPast0001')).toBeCloseTo(1 / lg5, 5);
    expect(edge(db, robin, personOfUser(db, SAM)!, 'co_attend', 'evtPast0001')).toBeCloseTo(0.5 / lg5, 5);
    expect(edge(db, robin, personOfUser(db, JORDAN)!, 'co_attend', 'evtPast0001')).toBeUndefined(); // declined
    expect(edge(db, avery, robin, 'invited_by', 'evtPast0001')).toBe(1.5);
    expect(edge(db, robin, personOfUser(db, SAM)!, 'invited_by', 'evtPast0001')).toBe(1.5);
    expect(edge(db, robin, personOfUser(db, CASEY)!, 'plus_one', 'evtPast0001')).toBe(3);
    expect(edge(db, robin, personOfUser(db, DREW)!, 'co_attend', 'evtHosted001')).toBeCloseTo(0.2 / Math.log2(3), 5);
    expect(count(db, 'SELECT count(*) FROM edge_evidence WHERE a_id = ? OR b_id = ?', meId, meId)).toBe(0);

    // Interactions (1.5 units) for people who went to a past event I went to, if they're people (not roster-only
    // strangers): Avery and Robin at the rooftop party. My upcoming party adds none yet.
    const ix = all<{ person_id: string; event_id: string; units: number; channel: string; started_at: number }>(
      db,
      `SELECT person_id, event_id, units, channel, started_at FROM interactions WHERE kind = 'event' ORDER BY person_id`,
    );
    expect(ix.map((i) => canonicalId(db, i.person_id)).sort()).toEqual([avery, robin].sort());
    expect(ix.every((i) => i.units === 1.5 && i.channel === 'partiful' && i.event_id === eventRow(db, 'evtPast0001') && i.started_at === T0 - 30 * DAY)).toBe(true);

    // Health + journal: one run, every write undoable.
    const h = one<{ status: string; last_error: string | null; details: string }>(db, `SELECT status, last_error, details FROM source_health WHERE source = 'partiful'`);
    expect(h.status).toBe('ok');
    expect(JSON.parse(h.details)).toMatchObject({ events: 4, upcoming: 1, past: 3, hosted: 1, guest_lists_pending: 0, users_pending: 0, text_events_missing: 0 });
    expect(all(db, 'SELECT kind, status FROM runs')).toEqual([{ kind: 'ingest', status: 'ok' }]);
    expect(count(db, `SELECT count(*) FROM change_batches WHERE kind = 'attendee'`)).toBe(2);
    expect(count(db, 'SELECT count(*) FROM change_batches WHERE undoable = 0')).toBe(0);
  });

  it('a re-run changes nothing; the ±14-day window is re-read the next day and picks up RSVP changes', async () => {
    const { f, db, sync } = setup();
    await sync(T0);
    const batches = count(db, 'SELECT count(*) FROM change_batches');
    const rows = count(db, 'SELECT count(*) FROM event_attendees');
    const r2 = await sync(T0 + 60 * 60_000);
    expect(r2.stats.guest_lists ?? 0).toBe(0);
    expect(count(db, 'SELECT count(*) FROM change_batches')).toBe(batches);
    expect(count(db, 'SELECT count(*) FROM event_attendees')).toBe(rows);
    expect(f.fnCalls('getUsers')).toHaveLength(1);

    f.events.find((e) => e.id === 'evtHosted001')!.guests.find((g) => g.userId === LEE)!.status = 'GOING';
    const callsBefore = f.fnCalls('getGuests').length;
    const r3 = await sync(T0 + DAY);
    expect(f.fnCalls('getGuests').slice(callsBefore).map((c) => c.params.eventId)).toEqual(['evtHosted001']);
    expect(r3.stats.attendees_updated).toBe(1);
    expect(one<{ status: string }>(db, `SELECT status FROM event_attendees WHERE person_id = ?`, personOfUser(db, LEE)).status).toBe('going');
  });

  it('a changed event outside the window is re-read once', async () => {
    const { f, db, sync } = setup();
    await sync(T0);
    const past = f.events.find((e) => e.id === 'evtPast0001')!;
    past.guests.push({ id: 'g-new', userId: 'uid-late-0001', name: 'Late Arrival', status: 'GOING' });
    const before = f.fnCalls('getGuests').length;
    await sync(T0 + 2 * 60 * 60_000);
    expect(f.fnCalls('getGuests').slice(before).map((c) => c.params.eventId)).toEqual(['evtPast0001']);
    expect(personOfUser(db, 'uid-late-0001')).toBeDefined();
    await sync(T0 + 3 * 60 * 60_000);
    expect(f.fnCalls('getGuests').length).toBe(before + 1);
  });

  it('the first backfill trickles over several runs (≤40 never-read past lists per run)', async () => {
    const { f, db, sync } = setup();
    for (let i = 0; i < 50; i++) {
      f.events.push({
        id: `evtBack${String(i).padStart(4, '0')}`,
        title: `Synthetic Backfill ${i}`,
        startDate: iso(T0 - (100 + i) * DAY),
        list: 'past',
        ownerIds: [HOST],
        guest: { status: 'GOING' },
        guests: [{ id: `b-${i}`, userId: `uid-back-${String(i).padStart(4, '0')}`, name: `Guest ${i}`, status: 'GOING' }],
      });
    }
    const r1 = await sync(T0);
    // 1 upcoming (my party) + 40 of the 51 never-read past lists, newest first.
    expect(r1.stats.guest_lists).toBe(41);
    expect(r1.stats.guest_lists_pending).toBe(11);
    expect(JSON.parse(one<{ details: string }>(db, `SELECT details FROM source_health WHERE source = 'partiful'`).details).guest_lists_pending).toBe(11);
    expect(f.fnCalls('getGuests').map((c) => c.params.eventId)).toContain('evtPast0001');
    expect(f.fnCalls('getGuests').map((c) => c.params.eventId)).not.toContain('evtBack0049');
    const r2 = await sync(T0 + DAY);
    expect(r2.stats.guest_lists).toBe(12); // the 11 left + the window event
    expect(r2.stats.guest_lists_pending ?? 0).toBe(0);
  });

  it('a spent call budget ends the run as partial and the next run continues', async () => {
    const { db, sync } = setup();
    const r = await sync(T0, {}, 5); // 4 lists + 1 guest list
    expect(r.partial).toBe(true);
    expect(r.stats.guest_lists).toBe(1);
    const h = one<{ status: string; details: string }>(db, `SELECT status, details FROM source_health WHERE source = 'partiful'`);
    expect(h.status).toBe('ok');
    expect(JSON.parse(h.details)).toMatchObject({ stopped: 'budget', guest_lists_pending: 1, calls: 5 });
    expect(all(db, 'SELECT status FROM runs')).toEqual([{ status: 'partial' }]);
    const r2 = await sync(T0 + 60_000);
    expect(r2.partial).toBe(false);
    expect(r2.stats.guest_lists).toBe(1);
    expect(r2.stats.users).toBe(7);
  });

  it('undoing a run rejects its attendee rows, and re-ingest never brings them back', async () => {
    const { db, sync } = setup();
    await sync(T0);
    const runId = one<{ id: string }>(db, 'SELECT id FROM runs').id;
    undoRun(db, runId, { now: T0 + 1 });
    expect(count(db, `SELECT count(*) FROM event_attendees WHERE status <> 'rejected'`)).toBe(0);
    const n = count(db, 'SELECT count(*) FROM event_attendees');
    await sync(T0 + DAY); // re-reads the window event
    expect(count(db, `SELECT count(*) FROM event_attendees WHERE status <> 'rejected'`)).toBe(0);
    expect(count(db, 'SELECT count(*) FROM event_attendees')).toBe(n);
    expect(count(db, `SELECT count(*) FROM people WHERE origin = 'partiful' AND status NOT IN ('suppressed')`)).toBe(0);
    // Derived effects follow: no edges or interactions from rejected rows.
    expect(count(db, `SELECT count(*) FROM interactions WHERE kind = 'event'`)).toBe(0);
    expect(count(db, `SELECT count(*) FROM edge_evidence`)).toBe(0);
  });

  it('getUsers answering one profile per call: the batch shrinks and no unread profile is marked read', async () => {
    const { f, db, sync } = setup();
    f.usersPerCall = 1;
    const r = await sync(T0);
    const asked = f.fnCalls('getUsers').map((c) => (c.params.ids as string[]).length);
    expect(asked[0]).toBe(7);
    expect(asked.slice(1)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(r.stats.users).toBe(7);
    expect(r.stats.users_pending ?? 0).toBe(0);
    expect(r.stats.ig_linked).toBe(1);
    expect(f.fnCalls('getUsers').every((c) => c.params.includePartyStats === true && c.params.excludePartyStats === false)).toBe(true);

    // With a cap on calls, what's left stays pending for the next run.
    const s2 = setup();
    s2.f.usersPerCall = 1;
    const r2 = await s2.sync(T0, { limits: { userCallsPerRun: 3 } });
    expect(r2.stats.users).toBe(3);
    expect(r2.stats.users_pending).toBe(4);
    // People in my network are read first (the host and my party's guests are provisional).
    const read = s2.db.prepare('SELECT user_id FROM partiful_users WHERE profile_fetched_at IS NOT NULL').pluck().all() as string[];
    for (const u of read) {
      expect(['provisional', 'active']).toContain(one<{ status: string }>(s2.db, 'SELECT p.status FROM people p JOIN person_canon c ON c.canonical_id = p.id WHERE c.person_id = ?', personOfUser(s2.db, u)).status);
    }
  });

  it('a guest record that embeds the user profile links Instagram without a getUsers call', async () => {
    const { f, db, robin, sync } = setup();
    const g = f.events.find((e) => e.id === 'evtPast0001')!.guests.find((x) => x.userId === ROBIN)!;
    g.user = { id: ROBIN, name: 'Robin Example', socials: { instagram: { value: 'robin.example', visibility: 'PUBLIC' } } };
    f.users.delete(ROBIN);
    const r = await sync(T0);
    expect(canonicalId(db, personOfUser(db, ROBIN)!)).toBe(robin);
    expect(r.stats.embedded_profiles).toBeGreaterThanOrEqual(1);
    expect(f.fnCalls('getUsers').flatMap((c) => c.params.ids as string[])).not.toContain(ROBIN);
  });

  it('a large list that is not mine adds only people already known (and qualifying ones), never strangers', async () => {
    const { f, db, sync } = setup();
    const guests = Array.from({ length: 130 }, (_, i) => ({
      id: `big-${i}`,
      userId: `uid-crowd-${String(i).padStart(4, '0')}`,
      name: `Crowd ${i}`,
      status: 'APPROVED',
    }));
    guests.push({ id: 'big-robin', userId: ROBIN, name: 'Robin Example', status: 'APPROVED' }, { id: 'big-me', userId: ME, name: 'Synthetic Owner', status: 'APPROVED' });
    f.events.push({
      id: 'evtFestival1',
      title: 'Synthetic Public Festival',
      startDate: iso(T0 - 20 * DAY),
      list: 'past',
      ownerIds: ['uid-org-0001'],
      guest: { status: 'APPROVED' },
      guests,
    });
    const r = await sync(T0);
    const rows = attendees(db, 'evtFestival1');
    // Robin (known from my own party, read first) and the organiser (the host of an event I went to).
    expect(rows.map((a) => a.person_id).sort()).toEqual([personOfUser(db, ROBIN), personOfUser(db, 'uid-org-0001')].sort());
    expect(r.stats.guests_skipped_large).toBe(130);
    expect(personOfUser(db, 'uid-crowd-0000')).toBeUndefined();
  });

  it('co-hosts get a co_host edge; canceled events add no edges; edges follow merges on the next pass', async () => {
    const { f, db, sync } = setup();
    f.events.push(
      {
        id: 'evtCohost001',
        title: 'Synthetic Cohosted Brunch',
        startDate: iso(T0 - 10 * DAY),
        list: 'past',
        ownerIds: [HOST, 'uid-cohost-0001'],
        guest: { status: 'GOING' },
        guests: [{ id: 'k-1', userId: SAM, name: 'Sam Sample', status: 'GOING' }],
      },
    );
    f.events.find((e) => e.id === 'evtCancel001')!.showGuestList = true;
    await sync(T0);
    const avery = personOfUser(db, HOST)!;
    const cohost = personOfUser(db, 'uid-cohost-0001')!;
    expect(edge(db, avery, cohost, 'co_host', 'evtCohost001')).toBe(2);
    expect(edge(db, avery, cohost, 'co_attend', 'evtCohost001')).toBeCloseTo(1 / Math.log2(1 + 4), 5); // 2 hosts + Sam + me going
    const canceled = eventRow(db, 'evtCancel001');
    expect(count(db, 'SELECT count(*) FROM edge_evidence WHERE ref = ?', `event:${canceled}`)).toBe(0);
    // Every edge endpoint is a canonical person.
    expect(count(db, 'SELECT count(*) FROM edge_evidence e WHERE e.a_id NOT IN (SELECT id FROM people WHERE merged_into_id IS NULL) OR e.b_id NOT IN (SELECT id FROM people WHERE merged_into_id IS NULL)')).toBe(0);
  });

  it('works before self handles exist (no me person): my own guest row is still skipped', async () => {
    const { db, sync } = setup({ me: false });
    await sync(T0);
    expect(personOfUser(db, ME)).toBeUndefined();
    expect(attendees(db, 'evtPast0001')).toHaveLength(5);
  });
});

describe('contract checks', () => {
  function textSignal(db: DB, eventId: string, sentAt: number) {
    const identity = seedIdentity(db, seedPerson(db, { display_name: 'Partiful', kind: 'business', status: 'service' }), 'business_chat', `urn:biz:synthetic-${eventId}`);
    const msg = seedMessage(db, identity, 'synthetic partiful text');
    const conv = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').pluck().get(msg) as string;
    db.prepare(
      `INSERT INTO partiful_text_signals (message_id, kind, event_id, conversation_id, sent_at, parser_version, created_at, updated_at)
       VALUES (?, 'invite', ?, ?, ?, 1, ?, ?)`,
    ).run(msg, eventId, conv, sentAt, sentAt, sentAt);
  }

  it('event ids from texts the API never returned: probed with getEventInfo, the rest is a stale warning', async () => {
    const { f, db, sync } = setup();
    f.eventInfo.set('evtTextOnly1', { id: 'evtTextOnly1', title: 'Synthetic Text-Only Party', startDate: iso(T0 - 5 * DAY), ownerIds: [HOST], guest: { status: 'GOING' } });
    textSignal(db, 'evtPast0001', T0 - 40 * DAY); // returned by the lists: fine
    textSignal(db, 'evtTextOnly1', T0 - 6 * DAY); // only getEventInfo knows it
    textSignal(db, 'evtGone00001', T0 - 7 * DAY); // deleted: NOT_FOUND explains it
    textSignal(db, 'evtUnprobed1', T0 - 20 * DAY); // over this run's probe limit
    textSignal(db, 'evtRecent001', T0 - 60 * 60_000); // inside the 24 h grace period
    const r = await sync(T0, { limits: { probesPerRun: 2 } });
    expect(f.fnCalls('getEventInfo').map((c) => c.params.eventId)).toEqual(['evtTextOnly1', 'evtGone00001']);
    expect(count(db, `SELECT count(*) FROM events WHERE source_event_id = 'evtTextOnly1'`)).toBe(1);
    expect(r.health).toBe('stale');
    expect(r.stats.text_events_missing).toBe(1);
    const h = one<{ status: string; last_error: string }>(db, `SELECT status, last_error FROM source_health WHERE source = 'partiful'`);
    expect(h).toEqual({ status: 'stale', last_error: '1 event from Partiful texts not returned by the API within 24 h' });

    // Next run probes the last one; a NOT_FOUND explains it and the warning clears.
    const r2 = await sync(T0 + 60_000, { limits: { probesPerRun: 2 } });
    expect(f.fnCalls('getEventInfo').map((c) => c.params.eventId).slice(2)).toEqual(['evtUnprobed1']);
    expect(r2.health).toBe('ok');
  });

  it('an unreadable list is contract_broken (the other lists still sync); all lists unreadable throws', async () => {
    const { f, db, sync } = setup();
    f.override.set('getMyPastEventsForHomePage', () => ({ statusCode: 200, data: { result: { data: { pastEvents: [{ title: 'no id' }, { title: 'none' }] } } } }));
    const r = await sync(T0);
    expect(r.partial).toBe(true);
    expect(r.health).toBe('contract_broken');
    expect(count(db, `SELECT count(*) FROM events WHERE source = 'partiful'`)).toBe(4); // getMyRsvps still had them
    const h = one<{ status: string; last_error: string; details: string }>(db, `SELECT status, last_error, details FROM source_health WHERE source = 'partiful'`);
    expect(h.last_error).toBe('Partiful API changed: getMyPastEventsForHomePage could not be read');
    expect(JSON.parse(h.details).failed).toEqual(['getMyPastEventsForHomePage']);

    for (const fn of ['getMyUpcomingEventsForHomePage', 'getMyRsvps', 'getPublishedEvents']) {
      f.override.set(fn, () => ({ statusCode: 404, data: '<html>Not Found</html>' }));
    }
    await expect(sync(T0 + 1)).rejects.toBeInstanceOf(PartifulContractError);
  });

  it('a 5xx on one guest list skips that list; repeated 5xx stop the pass with an error verdict', async () => {
    const { f, db, sync } = setup();
    f.override.set('getGuests', (p) => (p.eventId === 'evtHosted001' ? { statusCode: 503, data: '' } : undefined));
    const r = await sync(T0);
    expect(r.stats.guest_lists).toBe(1);
    expect(r.stats.guest_lists_failed).toBe(1);
    expect(r.health).toBe('ok');
    expect(one<{ guests_status: string }>(db, `SELECT guests_status FROM partiful_event_sync WHERE event_id = 'evtHosted001'`).guests_status).toBe('error');
    expect(r.stats.users).toBeGreaterThan(0); // later phases still ran

    const s2 = setup();
    for (let i = 0; i < 4; i++) {
      s2.f.events.push({ id: `evtFlaky000${i}`, title: `Flaky ${i}`, startDate: iso(T0 - (40 + i) * DAY), list: 'past', ownerIds: [HOST], guest: { status: 'GOING' }, guests: [] });
    }
    s2.f.override.set('getGuests', () => ({ statusCode: 500, data: '' }));
    const r2 = await s2.sync(T0);
    expect(s2.f.fnCalls('getGuests')).toHaveLength(3);
    expect(r2.partial).toBe(true);
    expect(r2.health).toBe('error');
    expect(s2.f.fnCalls('getUsers')).toHaveLength(0);
  });

  it('getGuests refusing its params for several lists in a row is a contract break', async () => {
    const { f, sync } = setup();
    for (let i = 0; i < 4; i++) {
      f.events.push({ id: `evtOdd00000${i}`, title: `Odd ${i}`, startDate: iso(T0 - (40 + i) * DAY), list: 'past', ownerIds: [HOST], guest: { status: 'GOING' }, guests: [] });
    }
    f.override.set('getGuests', () => ({ statusCode: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'bad params' } } }));
    const r = await sync(T0);
    expect(f.fnCalls('getGuests')).toHaveLength(3);
    expect(r.health).toBe('contract_broken');
  });

  it('a renamed getGuests stops the guest phase and reports it', async () => {
    const { f, sync } = setup();
    f.override.set('getGuests', () => ({ statusCode: 404, data: '' }));
    const r = await sync(T0);
    expect(r.health).toBe('contract_broken');
    expect(f.fnCalls('getGuests')).toHaveLength(1);
    expect(r.stats.guest_lists_pending).toBe(2);
  });
});

describe('partiful-hosted-guests (every 30 min)', () => {
  const HOUR = 3_600_000;
  const syncRow = (db: DB) => one<{ guests_status: string; guests_fetched_at: number }>(db, `SELECT guests_status, guests_fetched_at FROM partiful_event_sync WHERE event_id = 'evtHosted001'`);
  const smsNames = (db: DB, eventId: string) => db.prepare('SELECT name FROM partiful_guest_names WHERE event_id = ? ORDER BY name').pluck().all(eventId);

  it('re-reads only the lists of events I host in the next 15 days, and keeps SMS invitees (no Partiful account) by name', async () => {
    const s = setup();
    await s.sync(T0);
    const hosted = eventRow(s.db, 'evtHosted001');
    const e = s.f.events.find((x) => x.id === 'evtHosted001')!;
    // Invited after the nightly pass: a Partiful user, and someone by SMS.
    e.guests.push({ id: 'h-jordan', userId: JORDAN, name: 'Jordan Demo', status: 'SENT' }, { id: 'h-sms', name: 'Morgan Textinvite', status: 'SENT' });
    const before = s.f.fnCalls('getGuests').length;
    const r = await refreshHostedGuests(s.db, s.client(), { now: T0 + HOUR });
    expect(r.partial).toBe(false);
    expect(s.f.fnCalls('getGuests').slice(before).map((c) => c.params.eventId)).toEqual(['evtHosted001']);
    expect(attendees(s.db, 'evtHosted001').map((a) => a.person_id)).toContain(personOfUser(s.db, JORDAN));
    expect(smsNames(s.db, hosted)).toEqual(['Morgan Textinvite']);
    expect(syncRow(s.db)).toEqual({ guests_status: 'ok', guests_fetched_at: T0 + HOUR });
    // Off the list again: a complete read forgets the name. Someone else's event never keeps names.
    e.guests.splice(e.guests.findIndex((g) => g.id === 'h-sms'), 1);
    await refreshHostedGuests(s.db, s.client(), { now: T0 + 2 * HOUR });
    expect(smsNames(s.db, hosted)).toEqual([]);
    expect(smsNames(s.db, eventRow(s.db, 'evtPast0001'))).toEqual([]);
  });

  it('also re-reads the lists behind a show he holds tickets to in the next 3 weeks (event_invite needs them fresh)', async () => {
    const s = setup();
    // An event he's a guest at, the night of the show (not hosted: the hosted refresh alone never re-reads it).
    s.f.events.push({
      id: 'evtGuest0001',
      title: 'Synthetic Pregame',
      startDate: iso(T0 + 6 * DAY),
      list: 'upcoming',
      ownerIds: [HOST],
      guest: { id: 'p-me', status: 'GOING' },
      guests: [{ id: 'p-robin', userId: ROBIN, name: 'Robin Example', status: 'GOING' }],
    });
    await s.sync(T0);
    const pregame = eventRow(s.db, 'evtGuest0001');
    const listRow = () => one<{ guests_status: string; guests_fetched_at: number }>(s.db, `SELECT guests_status, guests_fetched_at FROM partiful_event_sync WHERE event_id = 'evtGuest0001'`);
    const refreshed = async (now: number) => {
      const before = s.f.fnCalls('getGuests').length;
      await refreshHostedGuests(s.db, s.client(), { now });
      return s.f.fnCalls('getGuests').slice(before).map((c) => c.params.eventId as string).sort();
    };
    expect(await refreshed(T0 + HOUR)).toEqual(['evtHosted001']);
    // A show 6 days out with a holding ticket, its occasion linked to the pregame.
    const ticket = ticketEvent(s.db, { title: 'Velvet Static', start: T0 + 6 * DAY + 2 * HOUR });
    const occ = ticketOccasion(s.db, ticket, { title: 'Velvet Static', start: T0 + 6 * DAY + 2 * HOUR, eventId: pregame });
    expect(await refreshed(T0 + 2 * HOUR)).toEqual(['evtGuest0001', 'evtHosted001']);
    expect(listRow()).toEqual({ guests_status: 'ok', guests_fetched_at: T0 + 2 * HOUR });
    // Named only in the ticket mail (partiful_ids) counts the same.
    s.db.prepare('UPDATE occasions SET event_id = NULL WHERE id = ?').run(occ);
    expect(await refreshed(T0 + 3 * HOUR)).toEqual(['evtHosted001']);
    s.db.prepare('UPDATE ticket_events SET partiful_ids = ? WHERE id = ?').run(JSON.stringify(['evtGuest0001']), ticket);
    expect(await refreshed(T0 + 4 * HOUR)).toEqual(['evtGuest0001', 'evtHosted001']);
    // Tickets no longer held: no call for it. Past the hosted dinner too: no calls at all.
    s.db.prepare(`UPDATE ticket_events SET status = 'sold' WHERE id = ?`).run(ticket);
    expect(await refreshed(T0 + 5 * HOUR)).toEqual(['evtHosted001']);
    s.db.prepare(`UPDATE ticket_events SET status = 'holding' WHERE id = ?`).run(ticket);
    expect(await refreshed(T0 + 4 * DAY)).toEqual(['evtGuest0001']);
    s.db.prepare(`UPDATE ticket_events SET status = 'sold' WHERE id = ?`).run(ticket);
    const calls = s.f.calls.length;
    expect(await refreshHostedGuests(s.db, s.client(), { now: T0 + 4 * DAY + HOUR })).toEqual({ stats: {}, partial: false, health: 'ok' });
    expect(s.f.calls.length).toBe(calls);
  });

  it('a list that fails to read is marked error (no invite suggestion trusts it); nothing hosted ahead → no calls', async () => {
    const s = setup();
    await s.sync(T0);
    s.f.override.set('getGuests', () => ({ statusCode: 500, data: { error: { status: 'INTERNAL', message: 'synthetic outage' } } }));
    const r = await refreshHostedGuests(s.db, s.client(), { now: T0 + HOUR });
    expect(r.partial).toBe(true);
    expect(syncRow(s.db)).toEqual({ guests_status: 'error', guests_fetched_at: T0 + HOUR });
    s.f.override.clear();
    const calls = s.f.calls.length;
    expect(await refreshHostedGuests(s.db, s.client(), { now: T0 + 20 * DAY })).toEqual({ stats: {}, partial: false, health: 'ok' });
    expect(s.f.calls.length).toBe(calls);
  });
});

describe('partiful-contacts (weekly)', () => {
  it('stores sharedEventCount (max of contacts and mutuals) and promotes frequent co-attendees', async () => {
    const { f, db, client } = setup();
    f.contacts.push(
      { userId: 'uid-friend-0001', name: 'Frequent Friend', sharedEventCount: 5, sharedEvent: { id: 'evtPast0001', title: 'x', startDate: iso(T0 - 30 * DAY) } },
      { userId: 'uid-once-0001', name: 'Met Once', sharedEventCount: 1 },
      { userId: ME, name: 'Synthetic Owner', sharedEventCount: 99 },
    );
    f.mutuals.push({ userId: 'uid-friend-0001', name: 'Frequent Friend', sharedEventCount: 6, isPastGuest: true });
    const r = await syncPartifulContacts(db, client(), { now: T0 });
    // "Met Once" (one shared event, unknown so far) is a mutual from a big party: counted, never created.
    expect(r.stats).toMatchObject({ contacts: 1, mutuals: 1, skipped: 1 });
    expect(personOfUser(db, 'uid-once-0001')).toBeUndefined();
    const u = one<Record<string, unknown>>(db, `SELECT shared_event_count, is_contact, is_mutual, is_past_guest, last_shared_event_id FROM partiful_users WHERE user_id = 'uid-friend-0001'`);
    expect(u).toEqual({ shared_event_count: 6, is_contact: 1, is_mutual: 1, is_past_guest: 1, last_shared_event_id: 'evtPast0001' });
    const friend = personOfUser(db, 'uid-friend-0001')!;
    expect(one<{ status: string }>(db, 'SELECT status FROM people WHERE id = ?', friend).status).toBe('provisional');
    expect(one<{ shared_event_count: number }>(db, 'SELECT shared_event_count FROM partiful_person_shared_events WHERE person_id = ?', friend).shared_event_count).toBe(6);
    expect(count(db, `SELECT count(*) FROM partiful_users WHERE user_id = ?`, ME)).toBe(0);
    expect(all(db, `SELECT kind, status FROM runs`)).toEqual([{ kind: 'weekly', status: 'ok' }]);
  });

  it('a broken contacts call is reported and carried into the next daily verdict', async () => {
    const { f, db, client, sync } = setup();
    f.override.set('getMutuals', () => ({ statusCode: 404, data: 'gone' }));
    const r = await syncPartifulContacts(db, client(), { now: T0 });
    expect(r.health).toBe('contract_broken');
    const d = await sync(T0 + 60_000);
    expect(d.health).toBe('contract_broken');
    expect(JSON.parse(one<{ details: string }>(db, `SELECT details FROM source_health WHERE source = 'partiful'`).details).failed).toEqual(['getMutuals']);
  });
});

describe('jobs', () => {
  const CDP = 'http://127.0.0.1:9'; // a placeholder: `connect` is always injected

  it('registers partiful (daily 02:00), partiful-contacts (weekly) and partiful-hosted-guests (every 30 min)', () => {
    const jobs = partifulJobs({ browserCdpUrl: CDP, secretsKey: null });
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([
      ['partiful', { kind: 'daily', at: '02:00' }],
      ['partiful-contacts', { kind: 'weekly', dow: 0, at: '03:30' }],
      ['partiful-hosted-guests', { kind: 'interval', everyMs: 30 * 60_000 }],
    ]);
  });

  it('first run: session from the sandbox browser, stored encrypted; tokens never reach logs, health, journal or job rows', async () => {
    const f = new FakePartiful();
    fakes.push(f);
    seedWorld(f);
    const db = memDb();
    const k = crypto.randomBytes(32);
    const browser = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores()))], null);
    const sink = memorySink();
    const log = createLogger([sink], 'debug');
    const jobs = partifulJobs({ browserCdpUrl: CDP, secretsKey: k, dispatcher: f.agent, connect: fakeConnect(browser), minIntervalMs: 0 });
    const s = new Scheduler({ db, jobs, log, clock: { now: () => T0 }, timeZone: 'UTC' });
    const res = await s.runNow('partiful');
    expect(res.status).toBe('ok');
    expect(browser.disconnected).toBe(1);
    expect(count(db, `SELECT count(*) FROM secrets WHERE name = 'partiful.session'`)).toBe(1);
    // A failing pass too (Partiful rejects every token), so error paths are covered.
    f.unauthorized = 1_000;
    const bad = await s.runNow('partiful-contacts');
    expect(bad.status).toBe('error');
    expect(one<{ status: string; last_error: string }>(db, `SELECT status, last_error FROM source_health WHERE source = 'partiful'`)).toEqual({
      status: 'auth_required',
      last_error: SIGN_IN_MESSAGE,
    });

    const secrets = [REFRESH, API_KEY, 'synthetic-access-token-0001', ...f.issuedTokens()];
    expect(f.issuedTokens().length).toBeGreaterThan(0);
    const haystacks = [
      JSON.stringify(sink.records),
      JSON.stringify(all(db, 'SELECT * FROM job_runs')),
      JSON.stringify(all(db, 'SELECT * FROM source_health')),
      JSON.stringify(all(db, 'SELECT * FROM source_cursors')),
      JSON.stringify(all(db, 'SELECT id, kind, title FROM change_batches')),
      JSON.stringify(all(db, 'SELECT * FROM change_log')),
      JSON.stringify(all(db, 'SELECT * FROM runs')),
      JSON.stringify(all(db, 'SELECT raw FROM events')),
      JSON.stringify(all(db, 'SELECT * FROM partiful_event_sync')),
      JSON.stringify(all(db, 'SELECT * FROM partiful_users')),
      (db.prepare('SELECT ciphertext FROM secrets').pluck().all() as Buffer[]).map((b) => b.toString('latin1')).join(''),
    ];
    for (const h of haystacks) for (const secret of secrets) expect(h.includes(secret), secret.slice(0, 12)).toBe(false);
    expect(sink.records.some((r) => r.event === 'partiful.sync')).toBe(true);
  });

  it('no session and no browser: auth_required with the sign-in hint, and the job fails (retried with backoff)', async () => {
    const f = new FakePartiful();
    fakes.push(f);
    const db = memDb();
    const jobs = partifulJobs({ browserCdpUrl: CDP, secretsKey: crypto.randomBytes(32), dispatcher: f.agent, connect: fakeConnect(null), minIntervalMs: 0 });
    const s = new Scheduler({ db, jobs, clock: { now: () => T0 }, timeZone: 'UTC' });
    const res = await s.runNow('partiful');
    expect(res.status).toBe('error');
    expect(res.errorClass).toBe('PartifulAuthRequiredError');
    const h = one<{ status: string; last_error: string; details: string }>(db, `SELECT status, last_error, details FROM source_health WHERE source = 'partiful'`);
    expect(h.status).toBe('auth_required');
    expect(h.last_error).toBe('Sign in to Partiful in the sandbox browser (https://127.0.0.1:4330)');
    expect(JSON.parse(h.details)).toEqual({ reason: 'browser_unreachable' });
    expect(f.calls).toEqual([]);
    expect(count(db, 'SELECT count(*) FROM runs')).toBe(0);
  });
});
