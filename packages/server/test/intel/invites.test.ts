import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { generators, partyInviteGenerator, wildcardSources } from '../../src/intel/generators';
import { readDigestSelection } from '../../src/delivery/selection';
import { alreadyInvited, guestCheck, guestList, hostedEvents, INVITE, organizesAsHost, partyInviteCandidates, partyInviteStale } from '../../src/intel/invites';
import { nullLogger } from '../../src/ops/logger';
import { allGenerators } from '../../src/pipeline/suggestions/registry';
import { attributeRewards, guestListAction, recordImpressions } from '../../src/pipeline/suggestions/rewards';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import { templateHeadline, templateOpeners, whySignals, whySummary, type TextInput } from '../../src/pipeline/suggestions/text';
import type { GeneratorContext } from '../../src/pipeline/suggestions/types';
import { settingsSnapshot } from '../../src/settings/registry';
import { seedIdentity, seedPerson } from '../helpers';
import { at, DAY, HOUR, intelWorld, NOW, occasion, TZ, type IntelWorld } from './world';

let w: IntelWorld;
let ana: string, bo: string, cy: string, dee: string, eve: string, fay: string, gil: string, mo: string;
let pia: string, quinn: string, dan: string, hal: string, rex: string;
let halloween: string, gameNight: string;

const ctx = (now = NOW): GeneratorContext => ({ db: w.db, now, timeZone: TZ, settings: settingsSnapshot(w.db), runId: null, log: nullLogger });

/** A calendar copy of an occasion (occasion_sources → calendar_events), organized by the owner or not. */
function calendarCopy(occasionId: string, o: { selfOrganizer?: boolean; invitees?: string[]; title?: string; start?: number } = {}): string {
  const id = uuidv7();
  const attendees = [
    { email: 'owner@example.com', name: null, status: 'accepted', self: true, organizer: !!o.selfOrganizer, optional: false, guests: 0 },
    ...(o.invitees ?? []).map((email) => ({ email, name: null, status: 'needsAction', self: false, organizer: false, optional: false, guests: 0 })),
  ];
  w.db.prepare(
    `INSERT INTO calendar_events (id, calendar_id, google_event_id, summary, starts_at, ends_at, self_organizer, attendees, ingested_at, updated_at)
     VALUES (?, 'personal@example.com', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `g${id.slice(-12)}`, o.title ?? null, o.start ?? NOW, (o.start ?? NOW) + 3 * 3_600_000, o.selfOrganizer === false ? 0 : 1, JSON.stringify(attendees), NOW, NOW);
  w.db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, 'calendar', ?, 'primary', ?)`).run(occasionId, id, NOW);
  return id;
}

/** An occasion the owner organizes on his own calendar. */
function calendarOccasion(title: string, start: number, o: { selfOrganizer?: boolean; invitees?: string[] } = {}): string {
  const id = occasion(w.db, { title, start, end: start + 3 * 3_600_000 });
  calendarCopy(id, { ...o, title, start });
  return id;
}

/** The Partiful event's guest list as the refresh job leaves it (read 'ok' at `at`). */
function listRead(eventId: string, at = NOW, status = 'ok'): void {
  w.db.prepare(
    `INSERT INTO partiful_event_sync (event_id, guests_fetched_at, guests_status, updated_at)
     SELECT source_event_id, ?, ?, ? FROM events WHERE id = ?
     ON CONFLICT (event_id) DO UPDATE SET guests_fetched_at = excluded.guests_fetched_at, guests_status = excluded.guests_status`,
  ).run(at, status, at, eventId);
}

function partyInvites(...members: string[]): void {
  w.db.prepare(`INSERT OR IGNORE INTO circles (id, name, kind, signature, status, created_at, updated_at) VALUES ('pi', 'Party invites', 'user', 'pref:party_invites', 'active', ?, ?)`).run(NOW, NOW);
  for (const m of members) w.db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, excluded, created_at, updated_at) VALUES ('pi', ?, 'user', 0, ?, ?)`).run(m, NOW, NOW);
}

beforeEach(() => {
  w = intelWorld();
  ana = w.person('Ana', 'Arbor', { tie: 70, historical: 80, state: 'strong' });
  bo = w.person('Bo', 'Birch', { tie: 50, historical: 60, state: 'steady' });
  cy = w.person('Cy', 'Cedar', { tie: 30, historical: 30, state: 'steady' });
  dee = w.person('Dee', 'Dune', { tie: 45, historical: 50, state: 'steady' });
  eve = w.person('Eve', 'Elm', { tie: 80, historical: 80, state: 'strong' });
  fay = w.person('Fay', 'Fern', { tie: 55, historical: 50, state: 'steady' });
  gil = w.person('Gil', 'Grove', { tie: 10 });
  mo = w.person('Mo', 'Moss', { tie: 60, historical: 60, state: 'steady' });
  pia = w.person('Pia', 'Pine', { tie: 20 });
  quinn = w.person('Quinn', 'Quill', { tie: 60, historical: 40, state: 'steady' });
  dan = w.person('Dan', 'Dell', { tie: 65 });
  hal = w.person('Hal', 'Hidden', { tie: 90, extra: { is_hidden: 1 } });
  rex = seedPerson(w.db, { display_name: 'Rex Roster', first_name: 'Rex', last_name: 'Roster', status: 'roster_only' });
  seedIdentity(w.db, fay, 'email', 'fay@example.com');
  partyInvites(pia, quinn, dan, hal, rex);
  // Mo asked never to be suggested for invites.
  w.db.prepare(`INSERT INTO learner_person_state (person_id, muted_kinds, updated_at) VALUES (?, '["party_invite"]', ?)`).run(mo, NOW);

  // The last year of parties: Ana, Bo, Cy, Mo, Fay are regulars; Dee came once, to one the owner hosted; Eve only
  // before the lookback.
  const p1 = occasion(w.db, { title: 'Game night', start: at(-30, 19) });
  for (const p of [ana, bo, cy, mo, fay]) w.attendee(p1, p, { status: 'attended' });
  const p2 = w.partiful({ title: 'Rooftop party', start: at(-60, 20) });
  for (const p of [ana, bo, cy, mo, fay]) w.guest(p2, p);
  const p3 = calendarOccasion('Housewarming at mine', at(-90, 19));
  for (const p of [ana, cy, dee]) w.attendee(p3, p, { status: 'attended' });
  for (const d of [400, 420]) w.attendee(occasion(w.db, { title: 'Picnic', start: at(-d, 13) }), eve, { status: 'attended' });

  // Hosted: a Partiful party in 5 days (Bo invited, Dan declined, Gil going) and a game night at his place in 9 days
  // (Fay has the calendar invitation).
  halloween = w.partiful({ title: 'Halloween party', start: at(5, 20), myRole: 'host' });
  listRead(halloween, NOW - 20 * 60_000);
  w.guest(halloween, bo, 'invited');
  w.guest(halloween, dan, 'declined');
  w.guest(halloween, gil, 'going');
  gameNight = calendarOccasion('Game night at mine', at(9, 19), { invitees: ['fay@example.com'] });
});

describe('hosted events', () => {
  it('Partiful events he hosts and occasions he organizes as a host, 2–14 days out', () => {
    // not his: a Partiful guest, someone else's birthday, a one-on-one dinner he sent the invite for, a copy he didn't organize
    w.partiful({ title: 'Costume party', start: at(4, 20), myRole: 'guest' });
    calendarOccasion("Kit's birthday party", at(6, 20), { invitees: ['kit@example.com'] });
    calendarOccasion('Dinner w/ Ana', at(7, 19), { invitees: ['ana@example.com'] });
    calendarOccasion('Hosting brunch', at(8, 11), { selfOrganizer: false });
    // out of the window: tomorrow, and in 20 days
    w.partiful({ title: 'Tomorrow party', start: at(1, 20), myRole: 'host' });
    w.partiful({ title: 'Far party', start: at(20, 20), myRole: 'host' });
    const ids = partyInviteCandidates(w.db, NOW, TZ).map((c) => c.subjectKey);
    expect(ids).toEqual([`event:${halloween}`, `occ:${gameNight}`]);
  });

  it('a linked Partiful event decides who hosts; a cancelled one never counts', () => {
    const guestOnly = w.partiful({ title: 'Big party', start: at(6, 20), myRole: 'guest' });
    const covered = occasion(w.db, { title: 'Big party at mine', start: at(6, 20), eventId: guestOnly });
    calendarCopy(covered, { title: 'Big party at mine' });
    const hosting = w.partiful({ title: 'Dinner party', start: at(7, 19), myRole: 'co_host' });
    const linked = occasion(w.db, { title: 'Dinner', start: at(7, 19), eventId: hosting });
    const cancelled = w.partiful({ title: 'Cancelled party', start: at(8, 20), myRole: 'host' });
    w.db.prepare(`UPDATE events SET status = 'CANCELED' WHERE id = ?`).run(cancelled);
    const ev = hostedEvents(w.db, { startFrom: at(2, 0), startTo: at(15, 0) });
    expect(ev.map((e) => [e.type, e.id])).toEqual([
      ['event', halloween],
      ['occasion', linked],
      ['occasion', gameNight],
    ]);
    expect(ev[1]!.eventId).toBe(hosting);
  });

  it('organizesAsHost: hosting words, or invitations to a party (or to 3+ people), never someone else’s', () => {
    expect(organizesAsHost('Drinks at mine', true, 0)).toBe(true);
    expect(organizesAsHost('My birthday', true, 0)).toBe(true);
    expect(organizesAsHost('Housewarming', true, 0)).toBe(true);
    expect(organizesAsHost('Game night', true, 0)).toBe(false);
    expect(organizesAsHost('Game night', true, 1)).toBe(true);
    expect(organizesAsHost('Dinner', true, 1)).toBe(false);
    expect(organizesAsHost('Dinner', true, INVITE.minCalendarInvitees)).toBe(true);
    expect(organizesAsHost("Kit's birthday", true, 5)).toBe(false);
    expect(organizesAsHost("Drinks at Kit's", true, 2)).toBe(false);
    expect(organizesAsHost('Hosting game night', false, 5)).toBe(false);
  });
});

describe('who to invite', () => {
  it('Party invites first (strongest tie first), then party-going strong ties; nobody on the guest list', () => {
    const [h, g] = partyInviteCandidates(w.db, NOW, TZ);
    // Halloween: Bo is invited, Dan declined, Gil is going; Cy's tie is too weak; Eve hasn't been to a party in a
    // year; Mo is muted for invites; Hal is hidden and Rex roster-only.
    expect(h!.personIds).toEqual([quinn, pia, ana, fay, dee]);
    expect(h).toMatchObject({
      kind: 'party_invite',
      subjectKey: `event:${halloween}`,
      base: 0.8,
      expiresAt: at(5, 20),
      evidenceIds: [`event:${halloween}`],
      links: { eventId: halloween },
      payload: { startsAt: at(5, 20), daysOut: 5, guestCount: 1, partyInvites: 2, reasons: ['party_invites', 'party_invites', 'party_regular', 'party_regular', 'party_regular'] },
    });
    // Game night at his place: Fay holds the calendar invitation; Dan (declined Halloween only) leads on tie; Bo isn't
    // on this list; Dee is sixth.
    expect(g!.personIds).toEqual([dan, quinn, pia, ana, bo]);
    expect(g).toMatchObject({ base: 0.7, links: { occasionId: gameNight, eventId: null }, payload: { daysOut: 9, guestCount: 0 } });
  });

  it('any guest-list status keeps a person off: invited, declined, maybe, rejected, inferred candidates, calendar emails', () => {
    expect(guestList(w.db, { type: 'event', id: halloween, eventId: null })).toEqual(new Set([bo, dan, gil]));
    w.attendee(gameNight, ana, { status: 'rejected', source: 'user' });
    w.db.prepare(`INSERT INTO occasion_candidates (occasion_id, cand_key, kind, person_id, surface, role, score, updated_at) VALUES (?, ?, 'person', ?, 'Dee', 'guest', 0.2, ?)`).run(
      gameNight,
      `p:${dee}`,
      dee,
      NOW,
    );
    expect(guestList(w.db, { type: 'occasion', id: gameNight, eventId: null })).toEqual(new Set([fay, ana, dee]));
    expect(partyInviteCandidates(w.db, NOW, TZ)[1]!.personIds).toEqual([dan, quinn, pia, bo]);
  });

  it('regulars need closeness 7 of 10; a priority person is exempt (the owner asked for them)', () => {
    // Cy (T 30, H 30 → closeness 6) comes to everything but isn't close enough …
    expect(partyInviteCandidates(w.db, NOW, TZ)[0]!.personIds).not.toContain(cy);
    // … until the owner marks Cy priority.
    w.db.prepare('UPDATE people SET is_priority = 1 WHERE id = ?').run(cy);
    expect(partyInviteCandidates(w.db, NOW, TZ)[0]!.personIds).toEqual([quinn, pia, ana, cy, fay]);
  });

  it('a person resting after ignored suggestions is left off the list, not the whole list', () => {
    w.db.prepare(`INSERT INTO learner_person_state (person_id, consecutive_ignores, cooldown_until, updated_at) VALUES (?, 2, ?, ?)`).run(quinn, NOW + 10 * DAY, NOW);
    expect(partyInviteCandidates(w.db, NOW, TZ)[0]!.personIds).toEqual([pia, ana, fay, dee]);
  });

  it('a member the owner removed from Party invites only counts as a regular; no one left → no candidate', () => {
    w.db.prepare(`UPDATE circle_members SET excluded = 1 WHERE person_id = ?`).run(quinn);
    expect(partyInviteCandidates(w.db, NOW, TZ)[0]!.personIds).toEqual([pia, ana, fay, dee]);
    for (const p of [pia, ana, fay, dee]) w.guest(halloween, p, 'going');
    expect(partyInviteCandidates(w.db, NOW, TZ).map((c) => c.subjectKey)).toEqual([`occ:${gameNight}`]);
  });

  it('is registered as the party_invite generator', async () => {
    expect(allGenerators().find((g) => g.kind === 'party_invite')).toBe(partyInviteGenerator);
    expect((await partyInviteGenerator.generate(ctx())).length).toBe(2);
  });
});

describe('the suggestions stage', () => {
  it('stores party_invite items, boosted for Party invites people, linked to the event', async () => {
    const r = await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators, wildcardSources });
    expect(r.status).toBe('ok');
    const rows = w.db
      .prepare(`SELECT kind, status, event_id, occasion_id, person_ids, rank_details FROM suggestions WHERE kind = 'party_invite' ORDER BY event_id IS NULL`)
      .all() as { kind: string; status: string; event_id: string | null; occasion_id: string | null; person_ids: string; rank_details: string | null }[];
    expect(rows.map((x) => [x.event_id, x.occasion_id])).toEqual([
      [halloween, null],
      [null, gameNight],
    ]);
    expect(JSON.parse(rows[0]!.person_ids)).toEqual([quinn, pia, ana, fay, dee]);
    const picked = rows.filter((x) => x.status === 'selected');
    expect(picked.length).toBeGreaterThan(0);
    for (const x of picked) expect(JSON.parse(x.rank_details!)).toMatchObject({ party: true });
  });

  it('acting on it: one of its people joining the guest list counts (a Partiful invite is no message)', async () => {
    const r = await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: [partyInviteGenerator], wildcardSources: [] });
    const id = r.selectedIds.find((x) => w.db.prepare('SELECT event_id FROM suggestions WHERE id = ?').pluck().get(x) === halloween)!;
    expect(id).toBeTruthy();
    recordImpressions(w.db, [id], { now: NOW, channel: 'web' });
    const row = { occasion_id: null, event_id: halloween };
    // a row from before the showing, a rejected one, and someone else's don't count
    w.db.prepare(`UPDATE event_attendees SET created_at = ? WHERE event_id = ?`).run(NOW - HOUR, halloween);
    const add = (personId: string, status: string, at: number) =>
      w.db
        .prepare(`INSERT INTO event_attendees (id, event_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'guest', 'partiful', 1, ?, ?)`)
        .run(uuidv7(), halloween, personId, status, at, at);
    add(eve, 'invited', NOW + HOUR);
    add(ana, 'rejected', NOW + HOUR);
    expect(guestListAction(w.db, row, [quinn, pia, ana, fay, dee], NOW, NOW + DAY)).toBeNull();
    add(fay, 'invited', NOW + 2 * HOUR);
    expect(guestListAction(w.db, row, [quinn, pia, ana, fay, dee], NOW, NOW + DAY)).toEqual({ at: NOW + 2 * HOUR, via: 'guest_list' });
    const out = await attributeRewards(w.db, { now: NOW + 3 * HOUR });
    expect(out.stats).toMatchObject({ acted: 1 });
    expect(w.db.prepare('SELECT status, acted_at, rank_details FROM suggestions WHERE id = ?').get(id)).toMatchObject({
      status: 'done',
      acted_at: NOW + 2 * HOUR,
      rank_details: expect.stringContaining('"actedVia":"guest_list"'),
    });
  });
});

describe('copy', () => {
  it('history headline, "Why this?" and template openers', () => {
    const t = (names: string[], payload: Record<string, unknown>): TextInput => ({
      kind: 'party_invite',
      isWildcard: false,
      wildcardGenerator: null,
      names,
      firstNames: names.map((n) => n.split(' ')[0]!),
      circleName: null,
      payload,
    });
    const two = t(['Quinn Q.', 'Ana A.'], { daysOut: 5, guestCount: 1, partyInvites: 1 });
    expect(templateHeadline(two)).toBe('Who to invite · Quinn Q. and Ana A.');
    expect(whySummary(two)).toBe("You're hosting in 5 days and Quinn Q. and Ana A. aren't on the guest list yet. One of them is on your Party invites list.");
    expect(whySummary(t(['Pia P.'], { daysOut: 1, partyInvites: 1 }))).toBe("You're hosting in 1 day and Pia P. isn't on the guest list yet. They're on your Party invites list.");
    expect(whySummary(t(['Ana A.', 'Fay F.'], {}))).toBe("You're hosting soon and Ana A. and Fay F. aren't on the guest list yet.");
    expect(whySignals(two.payload)).toEqual([
      { label: 'Starts in', value: '5 days' },
      { label: 'Going so far', value: '1' },
      { label: 'From Party invites', value: '1' },
    ]);
    for (const o of templateOpeners(two)) {
      expect(o).toMatch(/^(Hey )?Quinn/);
      expect(o.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('never a duplicate invite (cross-checked against who is invited on Partiful)', () => {
  const ids = () => partyInviteCandidates(w.db, NOW, TZ).map((c) => c.subjectKey);
  const halloweenPicks = () => partyInviteCandidates(w.db, NOW, TZ).find((c) => c.subjectKey === `event:${halloween}`)?.personIds ?? null;
  const ref = { type: 'event' as const, id: '', eventId: null };
  const check = () => guestCheck(w.db, { ...ref, id: halloween });
  /** Someone on the Halloween list as a separate record (a Partiful guest the matcher hasn't linked). */
  const separateGuest = (name: string, status = 'invited') => {
    const [first, last] = name.split(' ');
    const id = seedPerson(w.db, { display_name: name, first_name: first, last_name: last, status: 'roster_only' });
    w.guest(halloween, id, status);
    return id;
  };

  it('freshness: a Partiful list not read in full within the hour means no item for it (calendar-only events are unaffected)', () => {
    expect(ids()).toEqual([`event:${halloween}`, `occ:${gameNight}`]);
    listRead(halloween, NOW - 2 * HOUR);
    expect(ids()).toEqual([`occ:${gameNight}`]);
    listRead(halloween, NOW, 'error');
    expect(ids()).toEqual([`occ:${gameNight}`]);
    listRead(halloween, NOW, 'partial');
    expect(ids()).toEqual([`occ:${gameNight}`]);
    w.db.prepare('DELETE FROM partiful_event_sync').run();
    expect(ids()).toEqual([`occ:${gameNight}`]);
  });

  it('identity gaps: a guest on another record sharing a phone, a Gmail address, an @handle, or a maybe-match', () => {
    const phone = w.db.prepare('SELECT key FROM identities WHERE id = ?').pluck().get(w.phone(ana)) as string;
    seedIdentity(w.db, separateGuest('Guest One'), 'whatsapp_jid', `${phone.slice(1)}@s.whatsapp.net`);
    // Gmail folds dots and +tags only on its own domain, so the synthetic addresses are assembled (lint:pii allows
    // only reserved domains as literals).
    const gmail = (local: string) => `${local}@${['gmail', 'com'].join('.')}`;
    seedIdentity(w.db, fay, 'email', gmail('fay.fern'));
    seedIdentity(w.db, separateGuest('Guest Two'), 'email', gmail('fayfern+parties'));
    seedIdentity(w.db, dee, 'instagram_username', 'dee.dune');
    seedIdentity(w.db, separateGuest('Guest Three'), 'beeper_user', 'opaque-3', { raw: '@Dee.Dune' });
    const four = separateGuest('Guest Four');
    const [a, b] = four < quinn ? [four, quinn] : [quinn, four];
    w.db.prepare(`INSERT INTO match_candidates (a_id, b_id, score_bits, p, status, created_at, updated_at) VALUES (?, ?, 9, 0.8, 'pending', ?, ?)`).run(a, b, NOW, NOW);
    const g = check();
    expect([ana, fay, dee, quinn].map((p) => alreadyInvited(w.db, g, p))).toEqual([true, true, true, true]);
    expect(alreadyInvited(w.db, g, pia)).toBe(false);
    expect(halloweenPicks()).toEqual([pia]);
    // The matcher (or the owner) said they're different people: no longer a reason.
    w.db.prepare(`UPDATE match_candidates SET status = 'separate'`).run();
    expect(alreadyInvited(w.db, check(), quinn)).toBe(false);
  });

  it('names: a guest with the same first + last name (nicknames too), SMS invitees, calendar invitee names', () => {
    const smsInvite = (name: string) => w.db.prepare(`INSERT INTO partiful_guest_names (event_id, name, status, updated_at) VALUES (?, ?, 'invited', ?)`).run(halloween, name, NOW);
    smsInvite('Ana Arbor'); // invited by text, no Partiful account
    smsInvite('Pia'); // a first name alone is never enough
    smsInvite('Fay Birch'); // same first name, another family
    separateGuest('Quinn Quill'); // on Partiful under another record
    const will = w.person('William', 'Wren', { tie: 60 });
    smsInvite('Will Wren'); // a nickname of William
    const g = check();
    expect([ana, quinn, will].map((p) => alreadyInvited(w.db, g, p))).toEqual([true, true, true]);
    expect([pia, fay, dee].map((p) => alreadyInvited(w.db, g, p))).toEqual([false, false, false]);
    expect(halloweenPicks()).toEqual([pia, fay, dee]);
    // A name the owner put on the calendar invite keeps Bo off the game night list.
    const cal = w.db.prepare(`SELECT ce.id, ce.attendees FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref WHERE s.occasion_id = ?`).get(gameNight) as { id: string; attendees: string };
    const attendees = [...(JSON.parse(cal.attendees) as object[]), { email: 'bo.elsewhere@example.com', name: 'Bo Birch', self: false, organizer: false }];
    w.db.prepare('UPDATE calendar_events SET attendees = ? WHERE id = ?').run(JSON.stringify(attendees), cal.id);
    expect(partyInviteCandidates(w.db, NOW, TZ).find((c) => c.subjectKey === `occ:${gameNight}`)!.personIds).not.toContain(bo);
  });

  it('before the brief goes out: an item whose list went stale, or that names someone invited since, is dropped', async () => {
    const r = await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: [partyInviteGenerator], wildcardSources: [] });
    const item = (now: number) => readDigestSelection(w.db, { localDate: '2026-10-14', now })!;
    const halloweenItem = (now: number) => item(now).items.find((i) => i.links.eventId === halloween && !i.links.occasionId);
    expect(r.selectedIds.length).toBeGreaterThan(0);
    expect(halloweenItem(NOW + 10 * 60_000)).toBeTruthy();
    // 70 minutes after the last read (the refresh job didn't run, or failed): out.
    expect(halloweenItem(NOW + 50 * 60_000)).toBeUndefined();
    expect(item(NOW + 50 * 60_000).droppedStale).toBe(1);
    // Read again, but Pia got invited between the ranking and the send: out.
    listRead(halloween, NOW + 55 * 60_000);
    expect(halloweenItem(NOW + 56 * 60_000)).toBeTruthy();
    w.guest(halloween, pia, 'invited');
    expect(halloweenItem(NOW + 56 * 60_000)).toBeUndefined();
    expect(partyInviteStale(w.db, { occasionId: null, eventId: halloween, personIds: [quinn, ana] }, NOW + 56 * 60_000)).toBe(false);
  });
});
