/**
 * Weekly event picks (intel/eventPicks; design docs/design/event-picks.md): ticket-link checks, reading the model's
 * answers, free nights, the taste profile and what of it may be sent, scoring / learning / choosing, outcome
 * detection, the texts, a whole run with a scripted web search, and the routes (/event-picks, /go/:id).
 * Every performer, venue, title, URL and person is invented; the world runs in UTC on 2026-10-14 (a Wednesday).
 */
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPicksResponse } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { checkOutboundText } from '../../src/delivery/types';
import { picksTexts, pickText } from '../../src/intel/eventPicks/compose';
import { candidatesPrompt, eventKey, jsonArrayIn, parseFound, parseTicketPages } from '../../src/intel/eventPicks/discover';
import { checkLink, linkKind, normalizeUrl, resultIndex } from '../../src/intel/eventPicks/links';
import { nightsOf } from '../../src/intel/eventPicks/nights';
import { updatePickOutcomes } from '../../src/intel/eventPicks/outcomes';
import { promptSafe, tasteProfile } from '../../src/intel/eventPicks/profile';
import { choosePicks, learnFrom, scoreCandidate, seededRng, type Candidate } from '../../src/intel/eventPicks/rank';
import { picksDue, runEventPicks, type EventPicksDeps } from '../../src/intel/eventPicks/run';
import * as store from '../../src/intel/eventPicks/store';
import { FakeOutboundSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { CAL } from '../pipeline/occasions/world';
import { ticketEvent } from './eventInviteWorld';
import { at, DAY, HOUR, intelWorld, NOW, occasion, setSetting, type IntelWorld } from './world';

let w: IntelWorld;
beforeEach(() => {
  w = intelWorld();
  w.db.prepare(
    `INSERT INTO gcal_calendars (calendar_id, summary, is_primary, kind, default_treatment, first_seen_at, last_listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(CAL.personal, CAL.personal, 1, 'primary', 'attending', NOW, NOW, NOW);
  w.db.prepare(
    `INSERT INTO gcal_calendars (calendar_id, summary, is_primary, kind, default_treatment, first_seen_at, last_listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(CAL.community, 'Recurring things', 0, 'owned', 'classify', NOW, NOW, NOW);
});

const TODAY = '2026-10-14';
const calRow = (o: { summary: string; start: number; end?: number; calendar?: string; raw?: object; recurring?: string | null; attendees?: unknown[]; selfResponse?: string | null }) => {
  const id = w.cal({ summary: o.summary, start: o.start, end: o.end, calendar: o.calendar, attendees: o.attendees });
  w.db.prepare(`UPDATE calendar_events SET raw = ?, recurring_event_id = ?, self_response = ? WHERE id = ?`).run(JSON.stringify(o.raw ?? {}), o.recurring ?? null, o.selfResponse ?? null, id);
  return id;
};
const allDay = (summary: string, startDate: string, endDate: string) => {
  const id = w.cal({ summary, start: Date.parse(`${startDate}T00:00:00Z`), end: Date.parse(`${endDate}T00:00:00Z`), allDay: true });
  w.db.prepare(`UPDATE calendar_events SET start_date = ?, end_date = ? WHERE id = ?`).run(startDate, endDate, id);
  return id;
};

// ---------------------------------------------------------------------------------------------- links

describe('ticket links', () => {
  it('normalizes: https, no www, no tracking params, no fragment or trailing slash; refuses IPs, ports and odd schemes', () => {
    expect(normalizeUrl('http://www.Tix.example.com/event/123/?utm_source=x&id=9#top')).toBe('https://tix.example.com/event/123?id=9');
    expect(normalizeUrl('https://10.0.0.1/event/1')).toBeNull();
    expect(normalizeUrl('https://tix.example.com:8443/event/1')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it("classifies an event's own page, resale and listings", () => {
    const table: [string, string][] = [
      ['https://dice.fm/event/abc123-sample-band-29th-oct-example-hall-tickets', 'ticket'],
      ['https://ra.co/events/2505104', 'ticket'],
      ['https://www.eventbrite.com/e/sample-night-tickets-1995064286988', 'ticket'],
      ['https://www.livenation.com/event/rZ7HnEZ1AfGouV/sample-band', 'ticket'],
      ['https://shotgun.live/en/events/sample-warehouse-night-example-city', 'ticket'],
      ['https://examplehall.example.com/events/sample-band-2026-10-29', 'ticket'],
      ['https://www.stubhub.com/sample-band-tickets/event/155566778', 'resale'],
      ['https://ra.co/events/us/examplecity/techno', 'listing'],
      ['https://dice.fm/browse/examplecity-5982e13c/music/gig/house', 'listing'],
      ['https://www.eventbrite.com/d/ca--example-city/house-music/', 'listing'],
      ['https://promoter.example.com/events/example-city-ca/', 'listing'],
      ['https://en.wikipedia.org/wiki/Sample_Band', 'listing'],
      ['https://examplehall.example.com/', 'listing'],
      ['https://listings.example.com/events/2026/10/29', 'listing'],
      ['https://www.ticketmaster.com/sample-band-tickets/artist/1234567', 'listing'],
    ];
    for (const [url, kind] of table) expect([url, linkKind(normalizeUrl(url)!)]).toEqual([url, kind]);
  });

  it('keeps a URL only when the search returned that page — never one the model wrote', () => {
    const index = resultIndex(['https://dice.fm/event/abc123-sample-band-tickets?utm_medium=search', 'https://ra.co/events/us/examplecity/techno']);
    expect(checkLink('https://dice.fm/event/abc123-sample-band-tickets', index)).toEqual({ url: 'https://dice.fm/event/abc123-sample-band-tickets', host: 'dice.fm', kind: 'ticket' });
    expect(checkLink('https://dice.fm/event/zzz999-made-up-tickets', index)).toBeNull();
    expect(checkLink('https://ra.co/events/us/examplecity/techno', index)?.kind).toBe('listing');
    expect(checkLink(null, index)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- reading answers

describe('reading the model answer', () => {
  it('finds the JSON array in prose and code fences; drops bad items, not the answer', () => {
    const text = `I'll search first.Here they are:\n\`\`\`json\n[
      {"title":"Sample Band","performers":["Sample Band"],"venue":"Example Hall","city":"Example City","date":"2026-10-16","start":"9:30","category":"Concert","genres":["indie"],"ticket_url":"https://t.example.com/event/1","source_url":null,"why":"Indie like the shows you go to"},
      {"title":"No date","venue":"Example Hall","date":"soon"},
      {"title":"Late Set","performers":"oops","venue":"Annex","date":"2026-10-17","start":"25:00","category":"rave","genres":[],"ticket_url":null,"source_url":"https://l.example.com/x","why":null}
    ]\n\`\`\`\nNotes: …`;
    const found = parseFound(text)!;
    expect(found.map((f) => f.title)).toEqual(['Sample Band', 'Late Set']);
    expect(found[0]).toMatchObject({ category: 'concert', start: '09:30', performers: ['Sample Band'] });
    expect(found[1]).toMatchObject({ category: 'other', start: null, performers: [] });
    expect(parseFound('No events found, sorry.')).toBeNull();
    expect(jsonArrayIn('a [not json] then [1, 2]')).toEqual([1, 2]);
  });

  it('reads ticket pages by ref', () => {
    const m = parseTicketPages('[{"ref":"E1","ticket_url":"https://t.example.com/event/1","start":"22:00"},{"ref":"bogus"},{"ref":"E2","ticket_url":null,"start":null}]');
    expect([...m.keys()]).toEqual(['E1', 'E2']);
    expect(m.get('E1')).toEqual({ ticketUrl: 'https://t.example.com/event/1', start: '22:00' });
  });

  it('one key per real event: case, punctuation and filler words fold away', () => {
    expect(eventKey({ date: '2026-10-16', venue: 'Example Hall', title: 'Sample Band LIVE' })).toBe(eventKey({ date: '2026-10-16', venue: 'example hall!', title: 'The Sample Band' }));
    expect(eventKey({ date: '2026-10-16', venue: 'Example Hall', title: 'Sample Band' })).not.toBe(eventKey({ date: '2026-10-17', venue: 'Example Hall', title: 'Sample Band' }));
  });
});

// ---------------------------------------------------------------------------------------------- nights

describe('free nights', () => {
  it('evening plans, stays, flights, held tickets and Partiful RSVPs make a night busy; free-marked, declined and listings do not', () => {
    calRow({ summary: 'Dinner', start: at(0, 19) }); // Wed: busy
    calRow({ summary: 'Focus time', start: at(1, 18), raw: { transparency: 'transparent' } }); // Thu: marked free
    calRow({ summary: 'Declined thing', start: at(1, 20), selfResponse: 'declined' }); // Thu: declined
    calRow({ summary: 'Weekly tasting', start: at(1, 19), calendar: CAL.community, recurring: 'series1' }); // Thu: a listing
    calRow({ summary: 'Morning run', start: at(2, 7) }); // Fri morning: doesn't touch the evening
    calRow({ summary: 'Late set', start: at(3, 1) }); // 01:00 Sat counts for Friday night
    allDay('Visit to the coast', '2026-10-18', '2026-10-20'); // Sun + Mon away
    allDay('Some birthday', '2026-10-17', '2026-10-18'); // single all-day: not busy
    ticketEvent(w.db, { title: 'Held show', start: at(6, 20), localDate: '2026-10-20' }); // Tue: tickets
    const nights = nightsOf(w.db, TODAY, 8, 'UTC');
    expect(nights.map((n) => [n.date, n.reason])).toEqual([
      ['2026-10-14', 'calendar'],
      ['2026-10-15', null],
      ['2026-10-16', 'calendar'],
      ['2026-10-17', null],
      ['2026-10-18', 'away'],
      ['2026-10-19', 'away'],
      ['2026-10-20', 'tickets'],
      ['2026-10-21', null],
    ]);
    w.partiful({ title: 'Rooftop thing', start: at(7, 21) });
    expect(nightsOf(w.db, '2026-10-21', 1, 'UTC')[0]).toEqual({ date: '2026-10-21', free: false, reason: 'partiful' });
  });

  it('a recurring entry on a non-primary calendar WITH invitees is a plan', () => {
    calRow({ summary: 'Weekly dinner club', start: at(1, 19), calendar: CAL.community, recurring: 'series2', attendees: [{ email: 'friend@example.com' }, { email: 'owner@example.com', self: true }] });
    expect(nightsOf(w.db, '2026-10-15', 1, 'UTC')[0]!.reason).toBe('calendar');
  });
});

// ---------------------------------------------------------------------------------------------- profile

describe('taste profile', () => {
  it('tickets, public calendar events, Partiful (category only) and going picks; recent weighs more', () => {
    ticketEvent(w.db, { title: 'Sample Band', start: NOW - 20 * DAY, performers: ['Sample Band'], genres: ['Indie Rock'], category: 'concert', venue: 'Example Hall' });
    ticketEvent(w.db, { title: 'Old Act', start: NOW - 400 * DAY, performers: ['Old Act'], genres: ['jazz'], category: 'concert', venue: 'Old Room' });
    occasion(w.db, { title: 'Techno night at the Annex', start: NOW - 10 * DAY, venue: 'The Annex' });
    occasion(w.db, { title: 'Dinner', start: NOW - 5 * DAY });
    w.partiful({ title: 'Private birthday', start: NOW - 3 * DAY, location: 'Somewhere private' });
    const p = tasteProfile(w.db, NOW);
    expect(p.counts).toEqual({ ticket: 2, calendar: 1, partiful: 1, pick: 0 });
    expect(p.performers.map((x) => x.label)).toEqual(['Sample Band', 'Old Act']);
    expect(p.genres[0]!.label).toBe('indie rock');
    expect(p.venues.map((v) => v.label)).toEqual(expect.arrayContaining(['Example Hall', 'The Annex']));
    expect(p.titles).not.toContain('Private birthday');
    expect(p.titles).not.toContain('Dinner');
    expect([...p.categoryShare.keys()].sort()).toEqual(['club', 'concert', 'party']);
  });

  it("never sends a friend's name, a possessive or an address", () => {
    w.person('Kit', 'Quill');
    const names = new Set(['kit', 'quill']);
    expect(promptSafe('Comedy night with Kit', names)).toBeNull();
    expect(promptSafe("Jo's birthday", names)).toBeNull();
    expect(promptSafe('123 Example Street', names)).toBeNull();
    expect(promptSafe('Comedy night at the Laugh Cellar', names)).toBe('Comedy night at the Laugh Cellar');
    occasion(w.db, { title: 'Stand-up with Kit Quill', start: NOW - 2 * DAY, venue: 'Laugh Cellar' });
    const p = tasteProfile(w.db, NOW);
    expect(p.counts.calendar).toBe(1);
    const prompt = candidatesPrompt(p, { city: 'Example City', location: null, nights: ['2026-10-15'], want: 6 });
    expect(prompt).not.toMatch(/Kit|Quill/);
    expect(prompt).toContain('Laugh Cellar');
    expect(prompt).toContain('2026-10-15 Thu');
  });
});

// ---------------------------------------------------------------------------------------------- ranking

const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id,
  date: '2026-10-16',
  category: 'concert',
  performers: [],
  genres: [],
  venue: 'Somewhere',
  venueKey: 'somewhere',
  title: `Event ${id}`,
  linkKind: 'ticket',
  ...o,
});

describe('scoring and choosing', () => {
  it('a performer he has seen beats a stranger; a kind he never goes to scores lower', () => {
    ticketEvent(w.db, { title: 'Sample Band', start: NOW - 20 * DAY, performers: ['Sample Band'], genres: ['indie'], category: 'concert', venue: 'Example Hall' });
    const p = tasteProfile(w.db, NOW);
    const rng = seededRng(1);
    const seen = scoreCandidate(cand('a', { performers: ['Sample Band'], title: 'Sample Band' }), p, new Map(), rng);
    const stranger = scoreCandidate(cand('b', { performers: ['Unknown Act'], title: 'Unknown Act' }), p, new Map(), rng);
    const sports = scoreCandidate(cand('c', { category: 'sports', title: 'Orcas vs Herons' }), p, new Map(), rng);
    expect(seen.taste).toBeGreaterThan(stranger.taste);
    expect(seen.score).toBeGreaterThan(stranger.score);
    expect(sports.kind).toBe(0);
  });

  it('learns: going and taps pull a kind up, "not for me" pushes it down', () => {
    const learned = learnFrom([
      { category: 'comedy', genres: [], performers: [], venueKey: '', status: 'going', clicks: 1 },
      { category: 'comedy', genres: [], performers: [], venueKey: '', status: 'passed', clicks: 2 },
      { category: 'club', genres: ['techno'], performers: [], venueKey: '', status: 'not_for_me', clicks: 0 },
      { category: 'club', genres: [], performers: [], venueKey: '', status: 'passed', clicks: 0 },
    ]);
    expect(learned.get('c:comedy')).toEqual({ yes: 1.5, no: 0 });
    expect(learned.get('c:club')).toEqual({ yes: 0, no: 1.25 });
    expect(learned.get('g:techno')).toEqual({ yes: 0, no: 1 });
    const p = tasteProfile(w.db, NOW);
    const avg = (c: Candidate) => {
      const rng = seededRng(7);
      let s = 0;
      for (let i = 0; i < 200; i++) s += scoreCandidate(c, p, learned, rng).learned;
      return s / 200;
    };
    expect(avg(cand('x', { category: 'comedy', venue: '', venueKey: '' }))).toBeGreaterThan(0.6);
    expect(avg(cand('y', { category: 'club', genres: ['techno'], venue: '', venueKey: '' }))).toBeLessThan(0.4);
  });

  it('at most 2 a night, buyable links first, sent in date order; a wildcard is a kind he rarely goes to', () => {
    occasion(w.db, { title: 'Sample Band live', start: NOW - 5 * DAY });
    const p = tasteProfile(w.db, NOW);
    const scored = [
      { c: cand('a', { date: '2026-10-16' }), s: 0.9 },
      { c: cand('b', { date: '2026-10-16', category: 'club' }), s: 0.85 },
      { c: cand('c', { date: '2026-10-16', category: 'comedy' }), s: 0.8 },
      { c: cand('d', { date: '2026-10-15', linkKind: 'listing' }), s: 0.95 },
      { c: cand('e', { date: '2026-10-17', category: 'theater' }), s: 0.3 },
      { c: cand('f', { date: '2026-10-15', category: 'concert' }), s: 0.5 },
    ].map(({ c, s }) => ({ c, parts: { taste: 0, kind: 0, learned: 0, link: 0, score: s } }));
    const plain = choosePicks(scored, 3, p, () => 0.99);
    expect(plain.map((x) => x.c.id)).toEqual(['f', 'a', 'b']);
    expect(plain.every((x) => !x.wildcard)).toBe(true);
    const wild = choosePicks(scored, 3, p, () => 0.01);
    expect(wild.find((x) => x.wildcard)?.c.category).not.toBe('concert');
    expect(wild).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------- outcomes

let weekSeq = 0;
/** A pick sent in its own (synthetic, earlier) week. */
function sentPick(o: { title: string; date: string; venue?: string; performers?: string[]; status?: store.PickStatus; source?: string | null }): string {
  const runId = store.newRunId();
  const week = `2025-01-${String(++weekSeq).padStart(2, '0')}`;
  w.db.prepare(`INSERT INTO event_pick_runs (id, week_start, window_end, status, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, ?)`).run(runId, week, o.date, NOW, NOW);
  const id = store.newPickId();
  store.savePicks(
    w.db,
    runId,
    [
      {
        id,
        ordinal: 1,
        eventKey: eventKey({ date: o.date, venue: o.venue ?? 'Example Hall', title: o.title }),
        source: 'web',
        sourceRef: null,
        title: o.title,
        performers: o.performers ?? [],
        genres: [],
        category: 'concert',
        venue: o.venue ?? 'Example Hall',
        venueKey: (o.venue ?? 'Example Hall').toLowerCase(),
        city: null,
        localDate: o.date,
        startTime: '20:00',
        startsAt: Date.parse(`${o.date}T20:00:00Z`),
        ticketUrl: 'https://t.example.com/event/1',
        ticketHost: 't.example.com',
        linkKind: 'ticket',
        sourceUrl: null,
        why: null,
        parts: null,
        wildcard: false,
        dropReason: null,
      },
    ],
    NOW,
  );
  if (o.status) w.db.prepare(`UPDATE event_picks SET status = ?, outcome_source = ? WHERE id = ?`).run(o.status, o.source ?? null, id);
  return id;
}
const statusOf = (id: string) => w.db.prepare('SELECT status, outcome_source FROM event_picks WHERE id = ?').get(id) as { status: string; outcome_source: string | null };

describe('which picks he went to', () => {
  it('a ticket, a calendar entry or a Partiful RSVP that night means going; a past night with none is passed', () => {
    const t = sentPick({ title: 'Sample Band', date: '2026-10-16', performers: ['Sample Band'] });
    const c = sentPick({ title: 'Velvet Static album night', date: '2026-10-17', venue: 'The Annex' });
    const pf = sentPick({ title: 'Lantern Rooftop Social', date: '2026-10-18', venue: 'Lantern Roof' });
    const gone = sentPick({ title: 'Missed One', date: '2026-10-12' });
    const owner = sentPick({ title: 'Said No', date: '2026-10-12', status: 'not_for_me', source: 'owner' });
    ticketEvent(w.db, { title: 'SAMPLE BAND – North American tour', start: at(2, 20), performers: ['Sample Band'], localDate: '2026-10-16' });
    calRow({ summary: 'Velvet Static at the Annex', start: at(3, 21) });
    w.partiful({ title: 'Lantern Rooftop Social', start: at(4, 20), location: 'Lantern Roof' });
    const r = updatePickOutcomes(w.db, NOW, 'UTC');
    expect(r).toEqual({ checked: 4, going: 3, passed: 1 });
    expect(statusOf(t)).toEqual({ status: 'going', outcome_source: 'ticket' });
    expect(statusOf(c)).toEqual({ status: 'going', outcome_source: 'calendar' });
    expect(statusOf(pf)).toEqual({ status: 'going', outcome_source: 'partiful' });
    expect(statusOf(gone)).toEqual({ status: 'passed', outcome_source: 'date' });
    expect(statusOf(owner)).toEqual({ status: 'not_for_me', outcome_source: 'owner' });
  });

  it('an unrelated plan that night is not the pick; a late calendar entry still turns a passed night into going', () => {
    const p = sentPick({ title: 'Sample Band', date: '2026-10-13', venue: 'Example Hall' });
    calRow({ summary: 'Dinner', start: at(-1, 19) });
    updatePickOutcomes(w.db, NOW, 'UTC');
    expect(statusOf(p).status).toBe('passed');
    calRow({ summary: 'Sample Band at Example Hall', start: at(-1, 21) });
    updatePickOutcomes(w.db, NOW + DAY, 'UTC');
    expect(statusOf(p)).toEqual({ status: 'going', outcome_source: 'calendar' });
  });
});

// ---------------------------------------------------------------------------------------------- texts

describe('the texts', () => {
  const pick = (o: Partial<Parameters<typeof pickText>[0]> = {}) => ({
    id: 'Abc123xyz9',
    ordinal: 1,
    title: 'Sample Band',
    venue: 'Example Hall',
    localDate: '2026-10-16',
    startTime: '22:00',
    why: 'Indie like the shows you go to',
    wildcard: false,
    hasLink: true,
    ...o,
  });

  it('one text per pick, marker first, only yeackbot.com links, closing line on the last', () => {
    const texts = picksTexts([pick(), pick({ id: 'Def456uvw8', ordinal: 2, wildcard: true, title: 'Orcas vs Herons', startTime: null, why: null })], ['2026-10-15', '2026-10-16']);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe('🅨 Event picks for this week: 2 ideas for your free nights (Thu, Fri).');
    expect(texts[1]).toBe('🅨 1. Fri Oct 16 · Sample Band\nExample Hall, 10pm. Indie like the shows you go to.\nTickets: yeackbot.com/go/Abc123xyz9');
    expect(texts[2]).toContain('🎲 2. Something different: Fri Oct 16 · Orcas vs Herons');
    expect(texts[2]).toContain("Get tickets to any of these and I'll notice. Not your thing? yeackbot.com/picks");
    for (const t of texts) expect(checkOutboundText(t)).toEqual([]);
  });

  it('strips URLs, phones, emails and handles out of web text', () => {
    const t = pickText(pick({ title: 'Big Night https://evil.example.net/x call 213-555-0142', venue: 'Hall @promoter', why: 'mail info@example.com now' }), false);
    expect(t).not.toMatch(/evil|555|@|info/);
    expect(checkOutboundText(t)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- a whole run

const RESULTS = [
  { url: 'https://dice.fm/event/abc123-sample-band-16th-oct-example-hall-tickets', title: 'Sample Band · Example Hall' },
  { url: 'https://ra.co/events/us/examplecity/techno', title: 'Techno in Example City' },
  { url: 'https://ra.co/events/2505104', title: 'Annex All Night' },
  { url: 'https://laughcellar.example.com/shows/open-mic-night-oct-15-2026', title: 'Open mic' },
];
const CANDIDATES = JSON.stringify([
  { title: 'Sample Band', performers: ['Sample Band'], venue: 'Example Hall', city: 'Example City', date: '2026-10-16', start: '21:00', category: 'concert', genres: ['indie'], ticket_url: RESULTS[0]!.url, source_url: null, why: 'Indie' },
  { title: 'Annex All Night', performers: ['DJ Sample'], venue: 'The Annex', city: 'Example City', date: '2026-10-17', start: null, category: 'club', genres: ['techno'], ticket_url: null, source_url: RESULTS[1]!.url, why: 'Techno' },
  { title: 'Made Up Night', performers: [], venue: 'Fake Club', city: 'Example City', date: '2026-10-17', start: null, category: 'club', genres: [], ticket_url: 'https://fabricated.example.com/event/999', source_url: null, why: '' },
  { title: 'Busy Night Show', performers: [], venue: 'Example Hall', city: 'Example City', date: '2026-10-14', start: '20:00', category: 'concert', genres: [], ticket_url: RESULTS[0]!.url, source_url: null, why: '' },
  { title: 'Secret Rave', performers: [], venue: 'TBA', city: 'Example City', date: '2026-10-16', start: null, category: 'club', genres: [], ticket_url: null, source_url: null, why: '' },
  { title: 'Open Mic', performers: [], venue: 'Laugh Cellar', city: 'Example City', date: '2026-10-15', start: '20:00', category: 'comedy', genres: ['stand-up'], ticket_url: RESULTS[3]!.url, source_url: null, why: 'Stand-up' },
  { title: 'Next Month Show', performers: [], venue: 'Example Hall', city: 'Example City', date: '2026-11-20', start: null, category: 'concert', genres: [], ticket_url: RESULTS[0]!.url, source_url: null, why: '' },
  { title: 'The Sample Band', performers: ['Sample Band'], venue: 'example hall', city: 'Example City', date: '2026-10-16', start: null, category: 'concert', genres: [], ticket_url: RESULTS[0]!.url, source_url: null, why: '' },
]);

function deps(llm: FakeLlmClient, outbound = new FakeOutboundSender({ db: w.db, now: () => NOW })): EventPicksDeps & { outbound: FakeOutboundSender } {
  return { llm, egress: new FakeEgress(), outbound };
}

describe('a weekly run', () => {
  beforeEach(() => {
    setSetting(w.db, 'events.city', 'Example City, EX');
    setSetting(w.db, 'events.weekday', 3); // Wednesday, like NOW
    setSetting(w.db, 'events.time', '09:30');
    calRow({ summary: 'Dinner', start: at(0, 19) }); // tonight is busy
    occasion(w.db, { title: 'Sample Band live', start: NOW - 40 * DAY, venue: 'Example Hall' });
  });

  it('searches, checks links, drops what it must, finds a ticket page for the rest, picks and texts', async () => {
    // The candidates call is the first webSearch, the ticket pages the second (scripted in order).
    const d = deps(new FakeLlmClient().on('events', { search: { text: CANDIDATES, results: RESULTS, searches: 4 } }, { search: { text: `[{"ref":"E1","ticket_url":"${RESULTS[2]!.url}","start":"23:00"},{"ref":"E2","ticket_url":"https://fabricated.example.com/event/1","start":null}]`, results: [RESULTS[2]!], searches: 2 } }));
    const r = await runEventPicks(w.db, d, { now: NOW, send: true });
    expect(r.status).toBe('sent');
    if (r.status !== 'sent') return;
    const calls = (d.llm as FakeLlmClient).calls;
    expect(calls.map((c) => [c.method, c.route])).toEqual([
      ['webSearch', 'events_search'],
      ['webSearch', 'events_search'],
    ]);
    expect(calls[0]!.userText).toContain('Example City, EX');
    expect(calls[0]!.userText).not.toContain('2026-10-14'); // tonight is busy: not searched
    expect(calls[1]!.userText).toContain('Annex All Night');
    const picks = store.picksOfRun(w.db, r.runId);
    const byTitle = new Map(picks.map((p) => [p.title, p]));
    expect(byTitle.get('Busy Night Show')!.drop_reason).toBe('busy_night');
    expect(byTitle.get('Secret Rave')!.drop_reason).toBe('no_venue');
    expect(byTitle.get('Next Month Show')!.drop_reason).toBe('outside_window');
    expect(byTitle.get('The Sample Band')!.drop_reason).toBe('duplicate');
    expect(byTitle.get('Made Up Night')!.ticket_url).toBeNull(); // the model's own URL was never trusted
    expect(byTitle.get('Annex All Night')).toMatchObject({ ticket_url: RESULTS[2]!.url, link_kind: 'ticket', start_time: '23:00', ordinal: expect.any(Number) });
    const sent = picks.filter((p) => p.ordinal !== null);
    expect(sent.map((p) => p.title).sort()).toEqual(['Annex All Night', 'Open Mic', 'Sample Band']);
    expect(sent.map((p) => p.local_date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']); // ordinals in date order
    const texts = d.outbound.sent.map((s) => s.text);
    expect(texts).toHaveLength(4);
    expect(d.outbound.sent.every((s) => s.purpose === 'events')).toBe(true);
    expect(texts[1]).toContain(`yeackbot.com/go/${sent[0]!.id}`);
    const run = store.runForWeek(w.db, TODAY)!;
    expect(run).toMatchObject({ status: 'sent', searches: 6, found: 8 });
    expect(run.cost_usd).toBeGreaterThan(0.06); // 6 searches at $0.01 plus tokens
    expect(JSON.parse(run.free_nights)).not.toContain('2026-10-14');
    // Same week again: nothing more is searched or sent.
    expect(await runEventPicks(w.db, d, { now: NOW + HOUR, send: true })).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(d.outbound.sent).toHaveLength(4);
  });

  it('only on the picks day and time; disabled means never', () => {
    expect(picksDue(w.db, NOW)).toBe(true); // Wed 12:00
    expect(picksDue(w.db, Date.UTC(2026, 9, 14, 9, 0))).toBe(false); // before 09:30
    expect(picksDue(w.db, Date.UTC(2026, 9, 14, 21, 30))).toBe(false); // after 21:00
    expect(picksDue(w.db, NOW + DAY)).toBe(false); // Thursday
    setSetting(w.db, 'events.enabled', false);
    expect(picksDue(w.db, NOW)).toBe(false);
  });

  it('a failed search is retried later, at most 3 times a week; an unreadable answer is re-read once without search', async () => {
    const d = deps(new FakeLlmClient().on('events', { unavailable: 'rate_limited' }));
    const r1 = await runEventPicks(w.db, d, { now: NOW, send: true });
    expect(r1).toMatchObject({ status: 'failed', reason: 'rate_limited' });
    expect(await runEventPicks(w.db, d, { now: NOW + 10 * 60_000, send: true })).toEqual({ status: 'skipped', reason: 'retry_later' });
    const d2 = deps(
      new FakeLlmClient()
        .on('events', { search: { text: 'I found Sample Band at Example Hall on Oct 16, tickets at https://dice.fm/event/abc123-sample-band-16th-oct-example-hall-tickets', results: RESULTS, searches: 3 } })
        .on('events:events:' + store.runForWeek(w.db, TODAY)!.id + ':extract', {
          json: {
            events: [
              { title: 'Sample Band', performers: ['Sample Band'], venue: 'Example Hall', city: null, date: '2026-10-16', start: null, category: 'concert', genres: [], ticket_ref: 'R1', source_ref: null, why: null },
            ],
          },
        }),
    );
    const r2 = await runEventPicks(w.db, d2, { now: NOW + 40 * 60_000, send: true });
    expect(r2.status).toBe('sent');
    const calls = (d2.llm as FakeLlmClient).calls.map((c) => [c.method, c.route]);
    expect(calls[0]).toEqual(['webSearch', 'events_search']);
    expect(calls[1]).toEqual(['parse', 'events_extract']);
    expect((d2.llm as FakeLlmClient).calls[1]!.userText).not.toContain('https://'); // URLs went out as page refs
    const pick = store.picksOfRun(w.db, store.runForWeek(w.db, TODAY)!.id, { pickedOnly: true })[0]!;
    expect(pick.ticket_url).toBe(RESULTS[0]!.url);
  });

  it('no free night: nothing is searched; no delivery configured: the run waits as ready', async () => {
    for (let i = 1; i < 7; i++) calRow({ summary: 'Plans', start: at(i, 19) });
    const d = deps(new FakeLlmClient());
    expect(await runEventPicks(w.db, d, { now: NOW, send: true })).toMatchObject({ status: 'empty', reason: 'no_free_nights' });
    expect((d.llm as FakeLlmClient).calls).toHaveLength(0);
  });

  it('delivery not configured: the picks are ready (the web shows them) and nothing is lost', async () => {
    const d = deps(new FakeLlmClient().on('events', { search: { text: CANDIDATES, results: RESULTS, searches: 3 } }, { search: { text: '[]', results: [], searches: 1 } }), new FakeOutboundSender({ configured: false }));
    const r = await runEventPicks(w.db, d, { now: NOW, send: true });
    expect(r).toMatchObject({ status: 'ready', sendReason: 'delivery_not_configured' });
    expect(store.runForWeek(w.db, TODAY)!.status).toBe('ready');
  });

  it('never picks an event it sent in an earlier week', async () => {
    sentPick({ title: 'Sample Band', date: '2026-10-16', venue: 'Example Hall' });
    const d = deps(new FakeLlmClient().on('events', { search: { text: CANDIDATES, results: RESULTS, searches: 3 } }, { search: { text: '[]', results: [], searches: 1 } }));
    const r = await runEventPicks(w.db, d, { now: NOW, send: false });
    expect(r.status).toBe('ready');
    const p = store.picksOfRun(w.db, store.runForWeek(w.db, TODAY)!.id).find((x) => x.title === 'Sample Band')!;
    expect(p.drop_reason).toBe('picked_before');
  });
});

// ---------------------------------------------------------------------------------------------- routes

describe('routes', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
  });
  afterEach(() => vi.useRealTimers());

  it('GET /event-picks: the latest week with its picks and the answer counts', async () => {
    const empty = EventPicksResponse.parse((await request(app).get('/api/v1/event-picks')).body);
    expect(empty).toEqual({ week: null, history: { going: 0, notForMe: 0, passed: 0, open: 0 }, enabled: true });
    const id = sentPick({ title: 'Sample Band', date: '2026-10-16' });
    const res = await request(app).get('/api/v1/event-picks');
    expect(res.status).toBe(200);
    const body = EventPicksResponse.parse(res.body);
    expect(body.week!.picks.map((p) => [p.id, p.title, p.status, p.ticketHost])).toEqual([[id, 'Sample Band', 'picked', 't.example.com']]);
    expect(JSON.stringify(res.body)).not.toContain('https://t.example.com'); // links go through /go/<id>
  });

  it("feedback: going / not for me / undo (only the owner's own answer)", async () => {
    const id = sentPick({ title: 'Sample Band', date: '2026-10-16' });
    const nope = await request(app).post(`/api/v1/event-picks/${id}/feedback`).set('X-YB', '1').send({ verdict: 'not_for_me' });
    expect(nope.status).toBe(200);
    expect(nope.body).toMatchObject({ status: 'not_for_me', outcomeSource: 'owner' });
    const undo = await request(app).post(`/api/v1/event-picks/${id}/feedback`).set('X-YB', '1').send({ verdict: 'undo' });
    expect(undo.body).toMatchObject({ status: 'picked', outcomeSource: null });
    expect((await request(app).post(`/api/v1/event-picks/${id}/feedback`).set('X-YB', '1').send({ verdict: 'maybe' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/event-picks/NoSuchPick1/feedback`).set('X-YB', '1').send({ verdict: 'going' })).status).toBe(404);
  });

  it('/go/:id counts the tap and redirects to the stored ticket page; anything else goes to /picks', async () => {
    const id = sentPick({ title: 'Sample Band', date: '2026-10-16' });
    const res = await request(app).get(`/go/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://t.example.com/event/1');
    expect(res.headers['cache-control']).toContain('no-store');
    expect((w.db.prepare('SELECT clicks FROM event_picks WHERE id = ?').get(id) as { clicks: number }).clicks).toBe(1);
    const bad = await request(app).get('/go/..%2Fevil');
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe('/picks');
    expect((await request(app).get('/go/UnknownPick1')).headers.location).toBe('/picks');
  });
});
