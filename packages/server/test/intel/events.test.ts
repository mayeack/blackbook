import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, EventBrief } from '@yb/shared';
import { itemLines } from '../../src/delivery/compose';
import { selectedItemById } from '../../src/delivery/selection';
import { itemDetails, templateCopy } from '../../src/delivery/template';
import { eventBrief } from '../../src/intel/brief';
import { followupCandidates, preEventCandidates, preEventPushTick } from '../../src/intel/events';
import { eventFollowupGenerator, preEventBriefGenerator } from '../../src/intel/generators';
import { nullLogger } from '../../src/ops/logger';
import type { GeneratorContext } from '../../src/pipeline/suggestions/types';
import { settingsSnapshot } from '../../src/settings/registry';
import { FakePushSender } from '../fakes/delivery';
import { seedSuggestion } from '../delivery/world';
import { seedCommitment, seedPerson } from '../helpers';
import { at, DAY, HOUR, intelWorld, NOW, occasion, setSetting, TZ, type IntelWorld } from './world';

let w: IntelWorld;
let ana: string, bo: string, cy: string, dee: string, gus: string, hana: string, hal: string, zed: string;
let dinner: string, lunch: string, rooftop: string, party: string;

const ctx = (now = NOW): GeneratorContext => ({ db: w.db, now, timeZone: TZ, settings: settingsSnapshot(w.db), runId: null, log: nullLogger });

beforeEach(() => {
  w = intelWorld();
  ana = w.person('Ana', 'Arbor', { tie: 70, historical: 80, state: 'strong' });
  bo = w.person('Bo', 'Birch', { tie: 50, historical: 60, state: 'steady' });
  cy = w.person('Cy', 'Cedar', { tie: 30, historical: 30, state: 'steady' });
  dee = w.person('Dee', 'Dune', { tie: 45, historical: 60, state: 'fading', expectedGap: 7 });
  gus = w.person('Gus', 'Gale', { extra: { status: 'provisional' } });
  hana = w.person('Hana', 'Host', { tie: 40, historical: 40, state: 'steady' });
  hal = w.person('Hal', 'Hidden', { tie: 90, historical: 90, extra: { is_hidden: 1 } });
  zed = w.person('Zed', 'Zephyr', { tie: 40, historical: 40 });
  w.interaction(ana, 'dm_session', NOW - 3 * DAY);
  w.interaction(dee, 'dm_session', NOW - 40 * DAY);
  w.interaction(hana, 'dm_session', NOW - 10 * DAY);
  w.fact(ana, 'interest', 'climbing');
  w.fact(ana, 'interest', 'a private matter', { sensitive: true, recordedAt: NOW });

  // Today: dinner with Ana + Bo (+ Cy possible, Hal hidden), lunch with only Ana, a Partiful rooftop party.
  dinner = occasion(w.db, { title: 'Dinner w/ Ana & Bo', start: at(0, 19), venue: 'Moss & Fern' });
  w.attendee(dinner, ana, { confidence: 0.9 });
  w.attendee(dinner, bo, { confidence: 0.85 });
  w.attendee(dinner, cy, { status: 'possible', confidence: 0.6 });
  w.attendee(dinner, hal, { confidence: 0.9 });
  w.db.prepare(`INSERT INTO occasion_candidates (occasion_id, cand_key, kind, surface, role, score, updated_at) VALUES (?, 'n:kit', 'name', 'Kit', 'companion', 0, ?)`).run(dinner, NOW);
  lunch = occasion(w.db, { title: 'Lunch w/ Ana', start: at(0, 13) });
  w.attendee(lunch, ana);
  rooftop = w.partiful({ title: 'Rooftop party', start: at(0, 20), location: 'Birch Loft' });
  w.guest(rooftop, ana);
  w.guest(rooftop, dee);
  const stranger = seedPerson(w.db, { display_name: 'Guest Example', first_name: 'Guest', last_name: 'Example', status: 'roster_only' });
  w.guest(rooftop, stranger);
  occasion(w.db, { title: 'Doctor visit', start: at(0, 15), sensitive: true, kind: 'appointment' });
  const tomorrow = occasion(w.db, { title: 'Brunch w/ Ana & Bo', start: at(1, 11) });
  w.attendee(tomorrow, ana);
  w.attendee(tomorrow, bo);

  // Yesterday's party: Gus is new, Dee had gone quiet, Hana hosted, Ana is a regular, Bo came to an earlier event.
  party = occasion(w.db, { title: 'Housewarming', start: at(-1, 20), end: at(-1, 23) });
  for (const p of [ana, bo, dee, gus]) w.attendee(party, p, { status: 'attended' });
  w.attendee(party, hana, { status: 'attended', role: 'host' });
  const earlier = occasion(w.db, { title: 'Game night', start: at(-30, 19) });
  w.attendee(earlier, bo, { status: 'attended' });

  w.edge(zed, ana, 0.5);
  w.edge(zed, bo, 0.45);
  w.edge(cy, ana, 0.2);
  w.db
    .prepare(`INSERT INTO commitments (id, person_id, owner, kind, what, confidence, status, created_at, updated_at) VALUES (?, ?, 'me', 'send', 'send the playlist', 0.9, 'open', ?, ?)`)
    .run(uuidv7(), bo, NOW - DAY, NOW - DAY);
});

describe('pre_event_brief', () => {
  it('the morning of: today’s events with ≥ 2 known attendees, top attendees by tie strength, time-critical', async () => {
    const c = await preEventBriefGenerator.generate(ctx(at(0, 7, 16)));
    expect(c.map((x) => x.subjectKey)).toEqual([`occ:${dinner}`, `event:${rooftop}`]);
    expect(c[0]).toMatchObject({
      kind: 'pre_event_brief',
      personIds: [ana, bo],
      base: 0.8,
      timeCritical: true,
      expiresAt: at(0, 19),
      links: { occasionId: dinner },
      payload: { attendeeCount: 2, possibleCount: 1 },
    });
    expect(c[0]!.personIds).not.toContain(hal);
    expect(c[1]).toMatchObject({ personIds: [ana, dee], links: { eventId: rooftop }, payload: { unknownGuests: 1 } });
    // already started / tomorrow's / sensitive ones never
    expect(preEventCandidates(w.db, at(0, 19, 30), TZ).map((x) => x.subjectKey)).toEqual([`event:${rooftop}`]);
  });
});

describe('Party invites (set by text) lead the lists', () => {
  it('in the pre-event brief (ahead of tie strength); a member the owner removed no longer does', async () => {
    w.db.prepare(`INSERT INTO circles (id, name, kind, signature, status, created_at, updated_at) VALUES ('pi', 'Party invites', 'user', 'pref:party_invites', 'active', ?, ?)`).run(NOW, NOW);
    w.db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, excluded, created_at, updated_at) VALUES ('pi', ?, 'user', 0, ?, ?)`).run(bo, NOW, NOW);
    const c = await preEventBriefGenerator.generate(ctx(at(0, 7, 16)));
    expect(c[0]!.personIds).toEqual([bo, ana]); // Bo first despite the lower tie
    expect(c[1]!.personIds).toEqual([ana, dee]); // not at that party: unchanged
    w.db.prepare(`UPDATE circle_members SET excluded = 1 WHERE person_id = ?`).run(bo);
    expect((await preEventBriefGenerator.generate(ctx(at(0, 7, 16))))[0]!.personIds).toEqual([ana, bo]);
  });
});

describe('the brief', () => {
  it('attendees by tie strength with last contact, open loops and one recent non-sensitive fact; unknown guests; connectors', () => {
    const b = eventBrief(w.db, dinner, { now: NOW, timeZone: TZ })!;
    expect(EventBrief.parse(b)).toEqual(b);
    expect(b.attendees.map((a) => a.person.id)).toEqual([ana, bo, cy]);
    expect(b.attendees[0]).toMatchObject({ tieStrength: 70, status: 'going', recentFact: { type: 'interest', value: 'climbing' } });
    expect(b.attendees[0]!.lastContactAt).toBe(NOW - 5 * DAY);
    expect(b.attendees[1]!.openLoops.length).toBeGreaterThan(0);
    expect(b.attendees[2]).toMatchObject({ status: 'possible', confidence: 0.6 });
    expect(b.unknownGuests).toEqual(['Kit']);
    expect(b.connectors.map((c) => [c.person.id, c.knows.map((k) => k.id).sort()])).toEqual([[zed, [ana, bo].sort()]]);
    expect(b.followUp).toEqual({ status: 'pending', suggestionId: null });
    expect(b.composer).toBe('template');
    expect(JSON.stringify(b)).not.toContain('Hidden');
    expect(JSON.stringify(b)).not.toContain('private matter');
  });

  it('the morning text carries it: a line per person with when you last talked, what’s open and one fact', () => {
    const id = seedSuggestion(w.db, { kind: 'pre_event_brief', personId: ana, occasionId: dinner });
    w.db.prepare('UPDATE suggestions SET person_ids = ? WHERE id = ?').run(JSON.stringify([ana, bo]), id);
    const item = selectedItemById(w.db, id, 1)!;
    const tctx = { db: w.db, now: at(0, 8), timeZone: TZ };
    const copy = templateCopy(item, tctx);
    const details = itemDetails(item, tctx);
    expect(copy.body).toBe('Ana A. and Bo B. are going.');
    expect(details).toEqual(['Ana A.: You talked 5 days ago. Into climbing.', "Bo B.: You talked 5 days ago. You said you'd send the playlist."]);
    const lines = itemLines({ line: `1. ${copy.headline}`, copy: 'template', body: copy.body, openers: [], sensitive: false, details });
    expect(lines.join('\n')).not.toMatch(/in the app|private matter|Hidden/);
  });

  it('a Partiful event lists its roster-only guests by name; sensitive and non-social occasions have no brief', () => {
    const b = eventBrief(w.db, rooftop, { now: NOW, timeZone: TZ })!;
    expect(b.type).toBe('event');
    expect(b.unknownGuests).toEqual(['Guest Example']);
    const doctor = w.db.prepare(`SELECT id FROM occasions WHERE title = 'Doctor visit'`).pluck().get() as string;
    expect(eventBrief(w.db, doctor, { now: NOW })).toBeNull();
    const chores = occasion(w.db, { title: 'Maid service', start: at(0, 10), kind: 'logistics' });
    expect(eventBrief(w.db, chores, { now: NOW })).toBeNull();
    expect(eventBrief(w.db, uuidv7(), { now: NOW })).toBeNull();
  });

  it('a past event says whether its follow-up was suggested', () => {
    expect(eventBrief(w.db, party, { now: NOW })!.followUp).toEqual({ status: 'none', suggestionId: null });
    const sid = uuidv7();
    w.db
      .prepare(`INSERT INTO suggestions (id, kind, occasion_id, dedupe_key, score, signals, status, created_at, updated_at) VALUES (?, 'event_followup', ?, ?, 0.7, '{}', 'delivered', ?, ?)`)
      .run(sid, party, `event_followup:occ:${party}`, NOW, NOW);
    expect(eventBrief(w.db, party, { now: NOW })!.followUp).toEqual({ status: 'suggested', suggestionId: sid });
  });
});

describe('event_followup', () => {
  it('nothing the morning after without a documented intent to follow up', async () => {
    expect(await eventFollowupGenerator.generate(ctx(at(0, 7, 16)))).toEqual([]);
    // A plan to meet isn't a follow-up; neither is a promise made long before, or one already kept.
    seedCommitment(w.db, gus, { kind: 'meet', what: 'grab a drink', created_at: at(-1, 22) });
    seedCommitment(w.db, dee, { kind: 'call', what: 'call about the trip', created_at: at(-12, 10) });
    seedCommitment(w.db, hana, { kind: 'send', what: 'send the photos', status: 'done', created_at: at(-1, 23) });
    expect(followupCandidates(w.db, at(0, 7, 16), TZ)).toEqual([]);
  });

  it('the morning after: people with a promise or reminder about them, new first, then quiet, then the host', async () => {
    seedCommitment(w.db, gus, { kind: 'send', what: 'send the photos', created_at: at(-1, 22) });
    seedCommitment(w.db, dee, { kind: 'call', what: 'call about the trip', created_at: at(-1, 21) });
    seedCommitment(w.db, hana, { kind: 'other', what: 'thank the host', origin: 'command', created_at: at(0, 1) });
    seedCommitment(w.db, ana, { kind: 'send', what: 'send the recipe', created_at: at(-1, 22) });
    const c = await eventFollowupGenerator.generate(ctx(at(0, 7, 16)));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      kind: 'event_followup',
      personIds: [gus, dee, hana],
      subjectKey: `occ:${party}`,
      base: 0.7,
      links: { occasionId: party },
      payload: { newPeople: 1, fadingPeople: 1, host: true, roles: ['new', 'fading', 'host'], attendeeCount: 5 },
    });
    // Ana (a regular, even with a promise) and Bo (came to an earlier event, no promise) aren't follow-ups
    expect(c[0]!.personIds).not.toContain(ana);
    expect(c[0]!.personIds).not.toContain(bo);
    // a day later the party is no longer "the morning after" (tonight's rooftop party is: Dee had gone quiet)
    expect(followupCandidates(w.db, at(1, 7, 16), TZ).map((x) => [x.subjectKey, x.personIds])).toEqual([[`event:${rooftop}`, [dee]]]);
  });
});

describe('pre-event push', () => {
  const sub = () =>
    w.db
      .prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://web.push.apple.com/synthetic-device', 'pk', 'au', ?)`)
      .run(uuidv7(), NOW);

  it('ships off; once on, one generic push per event ~3 h before, never twice, never in quiet hours', async () => {
    sub();
    const push = new FakePushSender();
    expect(await preEventPushTick(w.db, push, { now: at(0, 16, 30) })).toMatchObject({ status: 'skipped', reason: 'disabled' });
    setSetting(w.db, 'push.enabled', true);
    const first = await preEventPushTick(w.db, push, { now: at(0, 16, 30) });
    expect(first).toMatchObject({ status: 'ok', pushed: 1 });
    expect(push.sent).toHaveLength(1);
    const p = push.sent[0]!.payload;
    expect(p).toEqual({ kind: 'pre_event', title: 'Yeackbot', body: 'Something on your calendar in about 3 hours · your brief is ready', url: `/e/${dinner}/brief`, tag: `pre_event:${dinner}` });
    for (const name of ['Ana', 'Bo', 'Dinner', 'Moss']) expect(JSON.stringify(p)).not.toContain(name);
    expect((await preEventPushTick(w.db, push, { now: at(0, 16, 45) })).pushed).toBe(0);
    expect((await preEventPushTick(w.db, push, { now: at(0, 17, 15) })).pushed).toBe(1);
    expect(push.sent.map((s) => s.payload.url)).toEqual([`/e/${dinner}/brief`, `/e/${rooftop}/brief`]);
    // the lunch has one known attendee: never pushed
    expect(push.sent.some((s) => s.payload.url.includes(lunch))).toBe(false);
  });

  it('respects push.pre_event, quiet hours and an unconfigured sender', async () => {
    sub();
    setSetting(w.db, 'push.enabled', true);
    const early = occasion(w.db, { title: 'Breakfast w/ Ana & Bo', start: at(1, 8) });
    w.attendee(early, ana);
    w.attendee(early, bo);
    const push = new FakePushSender();
    expect(await preEventPushTick(w.db, push, { now: at(1, 6) })).toMatchObject({ status: 'skipped', reason: 'quiet_hours' });
    expect(await preEventPushTick(w.db, new FakePushSender({ configured: false }), { now: at(0, 16, 30) })).toMatchObject({ reason: 'not_configured' });
    setSetting(w.db, 'push.pre_event', false);
    expect(await preEventPushTick(w.db, push, { now: at(0, 16, 30) })).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(push.sent).toHaveLength(0);
    expect(HOUR).toBe(3_600_000);
  });
});
