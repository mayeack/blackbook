import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { afterWhen } from '../../../src/pipeline/occasions/messages';
import { runOccasions } from '../../../src/pipeline/occasions/run';
import { attendeesOf, buildWorld, calEvent, chat, DAY, evening, HOUR, NOW, occasionOf, TZ, type Person, type World } from './world';
import { seedIdentity, seedPerson } from '../../helpers';
import { rebuildPersonCanon } from '../../../src/db/canon';

// An owned calendar of things to do around town (like a "Recurring Events" calendar): its weekly entries are listings.
const LISTINGS = ['listings0001', 'group.calendar.google.com'].join('@');

let w: World;
let nico: Person;
let wren: Person;

const run = (now = NOW) => runOccasions(w.db, { now, timeZone: TZ });
const occ = (calEventId: string) => occasionOf(w.db, calEventId)!;
const candidateFor = (calEventId: string, personId: string) =>
  w.db.prepare('SELECT score, signals FROM occasion_candidates WHERE occasion_id = ? AND person_id = ?').get(occ(calEventId), personId) as
    | { score: number; signals: string }
    | undefined;
const signalTypes = (calEventId: string, personId: string) => (JSON.parse(candidateFor(calEventId, personId)?.signals ?? '[]') as { t: string; w: number }[]).map((s) => [s.t, s.w]);
const rowOf = (calEventId: string, personId: string) => attendeesOf(w.db, occ(calEventId)).find((a) => a.person_id === personId);

/** One week of a recurring listing on the listings calendar (the owner created it, so it is "attending"). */
function listing(summary: string, start: number, series = 'series-wine'): string {
  const id = calEvent(w.db, { calendar: LISTINGS, summary, start, end: start + 3 * HOUR, creator: 'owner@example.com' });
  w.db.prepare('UPDATE calendar_events SET recurring_event_id = ? WHERE id = ?').run(series, id);
  return id;
}

function person(first: string, last: string, phone: string): Person {
  const id = seedPerson(w.db, { first_name: first, last_name: last, display_name: `${first} ${last}` });
  const p = { id, phone: seedIdentity(w.db, id, 'phone', phone) };
  rebuildPersonCanon(w.db);
  return { ...p, dm: chat(w.db, 'direct', [p.phone]) };
}

beforeEach(() => {
  w = buildWorld();
  nico = person('Nico', 'Varga', '+15555550131');
  wren = person('Wren', 'Ostby', '+15555550132');
});

describe('a clue belongs to the plan it is about', () => {
  it('a thank-you after his own show is not evidence for the wine-tasting listing two nights before (and the old verdict is withdrawn)', () => {
    const tasting = listing('Lakeside Wine Tasting', evening(-6, 17));
    calEvent(w.db, { summary: 'Spotlight for Nico', start: evening(-5, 22), end: evening(-4, 0) });
    nico.dm.say(evening(-4, 0, 8), nico.phone, 'Thank you for coming bro');
    run();
    expect(candidateFor(tasting, nico.id)).toBeUndefined();

    // an adjudicator verdict from before (it had read the thank-you as being about the tasting)
    w.db
      .prepare(
        `INSERT INTO event_attendees (id, occasion_id, person_id, status, role, source, confidence, evidence, created_at, updated_at)
         VALUES (?, ?, ?, 'attended', 'companion', 'llm', 0.9, '[{"t":"llm","w":0.9}]', ?, ?)`,
      )
      .run(uuidv7(), occ(tasting), nico.id, NOW, NOW);
    run(NOW + HOUR);
    expect(rowOf(tasting, nico.id)).toMatchObject({ status: 'withdrawn', source: 'llm' });
  });

  it('a listing needs a message about it; one about it lands on the week it is nearest to, not every week', () => {
    const lastWeek = listing('Lakeside Wine Tasting', evening(-13, 17));
    const thisWeek = listing('Lakeside Wine Tasting', evening(-6, 17));
    // a generic same-day text: no tie to the listing
    wren.dm.say(evening(-13, 12), wren.phone, 'free tonight?');
    nico.dm.say(evening(-8, 10), null, 'lakeside wine tasting thursday? I heard the pours are great');
    nico.dm.say(evening(-6, 17, 20), nico.phone, 'omw!');
    run();
    expect(candidateFor(lastWeek, wren.id)).toBeUndefined();
    expect(candidateFor(lastWeek, nico.id)).toBeUndefined();
    expect(signalTypes(thisWeek, nico.id).map(([t]) => t)).toEqual(['logistics_dm', 'mention_dm']);
  });

  it('two plans the same evening share a vague "great seeing you"; one that names the person takes it whole', () => {
    const dinner = calEvent(w.db, { summary: 'Dinner at Sorrel', start: evening(-6, 18), end: evening(-6, 20) });
    const party = calEvent(w.db, { summary: 'Rooftop party', start: evening(-6, 21), end: evening(-6, 23) });
    wren.dm.say(evening(-5, 11), wren.phone, 'so great seeing you!');
    run();
    expect(signalTypes(dinner, wren.id)).toEqual([]); // 0.45 / 2 is below what the pass keeps
    expect(signalTypes(party, wren.id)).toEqual([['after_dm', 0.45]]); // nothing ended closer to the message
    const birthday = calEvent(w.db, { summary: "Wren's birthday drinks", start: evening(-6, 21, 30), end: evening(-6, 23, 30) });
    run(NOW + HOUR);
    expect(candidateFor(party, wren.id)).toBeUndefined();
    expect(signalTypes(birthday, wren.id)).toContainEqual(['after_dm', 0.45]);
  });

  it('"thank you for last night" points at that night; "thanks for having us for brunch" at the brunch', () => {
    const friday = calEvent(w.db, { summary: 'Gallery opening', start: evening(-6, 20), end: evening(-6, 23) });
    const run_ = calEvent(w.db, { summary: 'Run club', start: evening(-5, 8), end: evening(-5, 9) });
    nico.dm.say(evening(-5, 10), nico.phone, 'thank you for last night, that was fun');
    const brunch = calEvent(w.db, { summary: 'Brunch at home', start: evening(-2, 11), end: evening(-2, 13) });
    const picnic = calEvent(w.db, { summary: 'Picnic party', start: evening(-2, 14), end: evening(-2, 16) });
    wren.dm.say(evening(-2, 17), wren.phone, 'thanks for having us for brunch, so lovely to see you');
    run();
    // the run ended closer to the message, but it wasn't last night
    expect(signalTypes(friday, nico.id)).toEqual([['after_dm', 0.45]]);
    expect(candidateFor(run_, nico.id)).toBeUndefined();
    expect(signalTypes(brunch, wren.id)).toEqual([['after_dm', 0.45]]);
    expect(candidateFor(picnic, wren.id)).toBeUndefined();
  });

  it('without other plans around it a clue counts as before', () => {
    const dinner = calEvent(w.db, { summary: 'Dinner at Sorrel', start: evening(-30, 19), end: evening(-30, 21) });
    nico.dm.say(evening(-29, 10), nico.phone, 'so good catching up');
    run();
    expect(signalTypes(dinner, nico.id)).toEqual([['after_dm', 0.45]]);
  });
});

describe('afterWhen', () => {
  const t = (d: number, h: number) => Date.UTC(2026, 9, 14 + d, h, 0);
  it('last night / yesterday is the night before (a night runs to 05:00), tonight this night, today the day', () => {
    expect(afterWhen('thank you for last night', t(0, 12), TZ)).toEqual({ night: '2026-10-13' });
    expect(afterWhen('thank you for last night', t(0, 2), TZ)).toEqual({ night: '2026-10-12' });
    expect(afterWhen('so fun tonight', t(0, 1), TZ)).toEqual({ night: '2026-10-13' });
    expect(afterWhen('great seeing you today', t(0, 15), TZ)).toEqual({ day: '2026-10-14' });
    expect(afterWhen('great seeing you', t(0, 15), TZ)).toBeNull();
  });
});

describe('everyday words', () => {
  it('a venue named like a plain word ("Sunset") is no mention when that word is everyday chatter', () => {
    const show = calEvent(w.db, { summary: 'Sunset show', location: 'Sunset', start: evening(-6, 19), end: evening(-6, 22) });
    const filler = chat(w.db, 'direct', [seedIdentity(w.db, seedPerson(w.db), 'phone', '+15555550133')]);
    for (let i = 0; i < 60; i++) filler.say(NOW - 200 * DAY + i * HOUR, null, `what a sunset ${i}`);
    nico.dm.say(evening(-7, 12), nico.phone, 'gotta see this sunset tomorrow');
    run();
    expect(signalTypes(show, nico.id).map(([type]) => type)).not.toContain('mention_dm');
  });
});
