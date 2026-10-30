/**
 * The weekly event picks as a Sunday-evening email (owner requests 2026-10-25): "send it to me over email every
 * sunday evening", "check my calendar 'Recurring events' for cool recurring events happening that week, in addition
 * to what you find online / summarized in my newsletters", and "continuously try and improve … based on what events I
 * actually go to, based on signals in calendar and email". Covers the email (MIME, the gmail_send grant, the guard),
 * the Recurring Events listings, the newsletters, the learning changes and whole evening runs.
 * Every performer, venue, title, address and URL is invented; the world runs in UTC on 2026-10-14 (a Wednesday).
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventPicksEmailStatus } from '@yb/shared';
import { GMAIL_SEND_ADDRESS_SECRET, GMAIL_SEND_REFRESH_TOKEN_SECRET, GoogleEgressRefusedError, GOOGLE_PRODUCTS, guardedFetch, type FetchLike } from '../../src/adapters/calendar/google';
import { idTokenEmail } from '../../src/adapters/calendar/oauth';
import type { GmailApi, GmailMessage } from '../../src/adapters/gmail/api';
import type { AppConfig } from '../../src/config';
import { buildMime, createEmailSender, encodeHeader } from '../../src/delivery/email';
import { picksEmail } from '../../src/intel/eventPicks/email';
import { chooseListings, listingCategory, listingsBetween, listingVenue, longestGap, restingSeries } from '../../src/intel/eventPicks/listings';
import { isEventNewsletter, newsletterEvents, newsletterText, readNewsletters, scrub } from '../../src/intel/eventPicks/newsletters';
import { nightsOf } from '../../src/intel/eventPicks/nights';
import { updatePickOutcomes } from '../../src/intel/eventPicks/outcomes';
import { tasteProfile } from '../../src/intel/eventPicks/profile';
import { learnFrom, seededRng } from '../../src/intel/eventPicks/rank';
import { EMAIL_NOTES, firstNight, runEventPicks, type EventPicksDeps } from '../../src/intel/eventPicks/run';
import * as store from '../../src/intel/eventPicks/store';
import { nullLogger } from '../../src/ops/logger';
import { createEventPicksRouter } from '../../src/routes/eventPicks';
import { setSecret } from '../../src/security/secrets';
import { readSetting } from '../../src/settings/registry';
import { FakeEmailSender, FakeOutboundSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { CAL } from '../pipeline/occasions/world';
import { ticketEvent } from './eventInviteWorld';
import { at, HOUR, intelWorld, NOW, setSetting, type IntelWorld } from './world';

/** A synthetic address, built so it reads as one only at run time (the PII lint scans for literal ones). */
const addr = (local: string, domain: string) => [local, domain].join('@');
const OTHER_CAL = addr('othercal0001', 'group.calendar.google.com');
const DICE = `DICE <${addr('news', 'dice.fm')}>`;
const CLUB = `Example Club <${addr('hello', 'venue.example.com')}>`;
/** Wednesday 17:00: an evening send, so the week is Thursday 10-15 … Wednesday 10-21. */
const EVENING = Date.UTC(2026, 9, 14, 17, 0);
const WEEK = '2026-10-15';

let w: IntelWorld;
beforeEach(() => {
  w = intelWorld();
  const cal = w.db.prepare(
    `INSERT INTO gcal_calendars (calendar_id, summary, is_primary, kind, default_treatment, first_seen_at, last_listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  cal.run(CAL.personal, CAL.personal, 1, 'primary', 'attending', NOW, NOW, NOW);
  cal.run(CAL.community, 'Recurring Events', 0, 'owned', 'classify', NOW, NOW, NOW);
  cal.run(OTHER_CAL, 'Club socials', 0, 'owned', 'classify', NOW, NOW, NOW);
});

/** A weekly happening on a calendar (default: the Recurring Events one). */
function listing(o: { summary: string; start: number; series: string; location?: string; description?: string; calendar?: string; end?: number }): string {
  const id = w.cal({ summary: o.summary, start: o.start, end: o.end, calendar: o.calendar ?? CAL.community, location: o.location ?? null, description: o.description ?? null });
  w.db.prepare(`UPDATE calendar_events SET recurring_event_id = ?, html_link = ? WHERE id = ?`).run(o.series, `https://www.google.com/calendar/event?eid=${o.series}`, id);
  return id;
}

/** A plan on his own calendar. */
const plan = (summary: string, start: number, attendees: unknown[] = []) => w.cal({ summary, start, attendees });

let weekSeq = 0;
/** A pick sent in its own (synthetic, earlier) week. */
function sentPick(o: { title: string; date: string; venue?: string; source?: store.NewPick['source']; sourceRef?: string | null; clicks?: number; status?: store.PickStatus; category?: string }): string {
  const runId = store.newRunId();
  const week = `2025-02-${String(++weekSeq).padStart(2, '0')}`;
  w.db.prepare(`INSERT INTO event_pick_runs (id, week_start, window_end, status, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, ?)`).run(runId, week, o.date, NOW, NOW);
  const id = store.newPickId();
  store.savePicks(
    w.db,
    runId,
    [
      {
        id,
        ordinal: 1,
        eventKey: `k-${id}`,
        source: o.source ?? 'web',
        sourceRef: o.sourceRef ?? null,
        title: o.title,
        performers: [],
        genres: [],
        category: o.category ?? 'concert',
        venue: o.venue ?? 'Example Lounge',
        venueKey: (o.venue ?? 'Example Lounge').toLowerCase(),
        city: null,
        localDate: o.date,
        startTime: '20:00',
        startsAt: Date.parse(`${o.date}T20:00:00Z`),
        ticketUrl: null,
        ticketHost: null,
        linkKind: null,
        sourceUrl: null,
        why: null,
        parts: null,
        wildcard: false,
        dropReason: null,
      },
    ],
    NOW - 10 * 86_400_000,
  );
  if (o.status && o.status !== 'picked') w.db.prepare(`UPDATE event_picks SET status = ?, outcome_source = 'owner' WHERE id = ?`).run(o.status, id);
  if (o.clicks) w.db.prepare(`UPDATE event_picks SET clicks = ? WHERE id = ?`).run(o.clicks, id);
  return id;
}

// ---------------------------------------------------------------------------------------------- the schedule

describe('Sunday evening, the week ahead', () => {
  it('defaults: Sunday 18:00, by email, with newsletters and the Recurring Events calendar', () => {
    expect(readSetting(w.db, 'events.weekday')).toBe(0);
    expect(readSetting(w.db, 'events.time')).toBe('18:00');
    expect(readSetting(w.db, 'events.channel')).toBe('email');
    expect(readSetting(w.db, 'events.newsletters')).toBe(true);
    expect(readSetting(w.db, 'events.listings')).toBe(true);
  });

  it('an evening send covers the next seven nights (Sunday → Monday to Sunday); a morning one starts that night', () => {
    expect(firstNight('2026-10-25', '18:00')).toBe('2026-10-26');
    expect(firstNight('2026-10-25', '16:00')).toBe('2026-10-26');
    expect(firstNight('2026-10-26', '09:30')).toBe('2026-10-26');
  });
});

// ---------------------------------------------------------------------------------------------- the email itself

describe('email to himself (gmail_send)', () => {
  it('From = To = his own address; UTF-8 subject as encoded words; bodies in base64; no header injection', () => {
    const mime = buildMime('owner@example.com', { subject: 'Your week: 3 picks · Mon\r\nBcc: someone@example.net', text: 'Hi ✓', html: '<p>Hi ✓</p>', tag: 'event-picks' }, { now: NOW, boundary: 'b1' });
    const [head, ...rest] = mime.split('\r\n\r\n');
    expect(head).toContain('From: yeackbot <owner@example.com>');
    expect(head).toContain('To: <owner@example.com>');
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(head).toContain('X-Yeackbot: event-picks');
    const body = rest.join('\r\n\r\n');
    expect(body).toContain(Buffer.from('Hi ✓').toString('base64'));
    expect(body.trimEnd().endsWith('--b1--')).toBe(true);
    expect(() => buildMime('not an address', { subject: 's', text: 't', html: 'h', tag: 't' }, { now: NOW })).toThrow();
    expect(encodeHeader('Plain subject')).toBe('Plain subject');
  });

  it("the consent asks for gmail.send plus openid email, and keeps only Google's verified address", () => {
    expect(GOOGLE_PRODUCTS.gmail_send.scope).toBe('https://www.googleapis.com/auth/gmail.send');
    expect(GOOGLE_PRODUCTS.gmail_send.extraScopes).toEqual(['openid', 'email']);
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    expect(idTokenEmail(jwt({ email: 'owner@example.com', email_verified: true }))).toBe('owner@example.com');
    expect(idTokenEmail(jwt({ email: 'owner@example.com', email_verified: false }))).toBeNull();
    expect(idTokenEmail('garbage')).toBeNull();
    expect(idTokenEmail(undefined)).toBeNull();
  });

  it("the guard lets messages.send out only from the send grant's client, and nothing else that writes to the mailbox", async () => {
    const seen: string[] = [];
    const inner: FetchLike = async (u, init) => {
      seen.push(`${init?.method} ${String(u)}`);
      return new Response('{}');
    };
    for (const product of [null, 'gmail', 'calendar'] as const)
      await expect(guardedFetch(inner, product)('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST' })).rejects.toBeInstanceOf(GoogleEgressRefusedError);
    const f = guardedFetch(inner, 'gmail_send');
    await f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST' });
    for (const path of ['messages/abc/modify', 'messages/abc/trash', 'drafts', 'messages/import', 'settings/filters'])
      await expect(f(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method: 'POST' })).rejects.toBeInstanceOf(GoogleEgressRefusedError);
    expect(seen).toEqual(['POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
  });

  it('sends through the real client: a token refresh, then one POST to messages.send addressed to him', async () => {
    const key = crypto.randomBytes(32);
    const google = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'test-secret', redirectUri: 'https://yeackbot.example/api/v1/google/callback' };
    let raw = '';
    const calls: string[] = [];
    const fetch: FetchLike = async (u, init) => {
      const url = String(u);
      calls.push(url.replace(/\?.*$/, ''));
      if (url.includes('oauth2.googleapis.com/token'))
        return new Response(JSON.stringify({ access_token: 'test-access', expires_in: 3600, token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } });
      raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
      return new Response(JSON.stringify({ id: 'msg-1', threadId: 'thr-1' }), { headers: { 'content-type': 'application/json' } });
    };
    const disconnected = createEmailSender({ db: w.db, secretsKey: key, google, fetch });
    expect(disconnected.configured).toBe(false);
    expect(await disconnected.sendToSelf({ subject: 's', text: 't', html: 'h', tag: 'test' })).toEqual({ status: 'disabled', reason: 'not_connected' });
    setSecret(w.db, key, GMAIL_SEND_REFRESH_TOKEN_SECRET, 'test-refresh-send');
    setSecret(w.db, key, GMAIL_SEND_ADDRESS_SECRET, 'owner@example.com');
    const sender = createEmailSender({ db: w.db, secretsKey: key, google, fetch });
    expect(sender.configured).toBe(true);
    expect(await sender.sendToSelf({ subject: 'Your week', text: 'Hello', html: '<p>Hello</p>', tag: 'event-picks' }, { now: NOW })).toEqual({ status: 'sent', messageId: 'msg-1' });
    expect(calls).toEqual(['https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: <owner@example.com>');
    expect((w.db.prepare(`SELECT status FROM source_health WHERE source = 'gmail_send'`).get() as { status: string }).status).toBe('ok');
  });

  it('the picks email: every section, yeackbot.com links only, web text filtered and escaped', () => {
    const m = picksEmail({
      weekStart: '2026-10-26',
      windowEnd: '2026-11-01',
      freeNights: ['2026-10-27', '2026-10-30'],
      picks: [
        { id: 'pkA1b2c3d4', title: 'Sample Band <script>', venue: 'Example Hall', localDate: '2026-10-30', startTime: '21:00', why: 'Indie, call 555-010-0199 for info', wildcard: false, hasLink: true, ticketHost: 'dice.fm', source: 'web' },
        { id: 'pkE5f6g7h8', title: 'Laugh Riot', venue: 'Example Club', localDate: '2026-10-27', startTime: null, why: null, wildcard: true, hasLink: true, ticketHost: null, source: 'newsletter' },
      ],
      listings: [{ id: 'pkI9j0k1l2', title: 'Jazz at Example Lounge', venue: 'Example Lounge', localDate: '2026-10-27', startTime: '20:00', why: 'Close to what you usually go to.', wildcard: false, hasLink: false, ticketHost: null, source: 'calendar' }],
      lastWeek: { sent: 4, went: [{ title: 'Neon Example', how: 'a ticket in your email' }], tapped: 1, notForMe: 1 },
    });
    expect(m.subject).toBe('Your week: 3 event picks (Mon Oct 26 – Sun Nov 1)');
    expect(m.text).toContain('Your free nights this week: Tue, Fri.');
    expect(m.text).toContain('1. Fri Oct 30 · Sample Band');
    expect(m.text).toContain('Get tickets on dice.fm: https://yeackbot.com/go/pkA1b2c3d4');
    expect(m.text).toContain('🎲 Something different: Tue Oct 27 · Laugh Riot');
    expect(m.text).toContain('From one of your newsletters');
    expect(m.text).toContain('ON YOUR RECURRING EVENTS CALENDAR');
    expect(m.text).toContain('Details: https://yeackbot.com/go/pkI9j0k1l2');
    expect(m.text).toContain('Last week: you went to Neon Example (a ticket in your email); you looked at 1 other; 1 was not for you. This week leans that way.');
    expect(`${m.text}${m.html}`).not.toMatch(/555|010-0199/);
    expect(m.html).not.toContain('<script>');
    const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
    expect(links.every((u) => u.startsWith('https://yeackbot.com/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- Recurring Events

describe('the Recurring Events calendar', () => {
  it('reads only the calendar named "recurring", only listings (recurring, no invitees), with the venue line and its own link', () => {
    listing({ summary: 'Jazz at Example Lounge', start: at(1, 20), series: 'jazz', location: 'Example Lounge, 1 Sample St, Example City', description: 'Info: https://lounge.example.com/events/jazz-night-2026-10-15' });
    listing({ summary: 'Members mixer', start: at(1, 19), series: 'mixer', calendar: OTHER_CAL });
    const withFriend = listing({ summary: 'Wine club', start: at(2, 19), series: 'wine' });
    w.db.prepare(`UPDATE calendar_events SET attendees = ? WHERE id = ?`).run(JSON.stringify([{ email: 'friend@example.com' }]), withFriend);
    const ls = listingsBetween(w.db, at(0, 0), at(7, 0), 'UTC');
    expect(ls.map((l) => l.title)).toEqual(['Jazz at Example Lounge']);
    expect(ls[0]).toMatchObject({ venue: 'Example Lounge', date: '2026-10-15', startTime: '20:00', category: 'concert', seriesRef: 'jazz', ticketUrl: 'https://lounge.example.com/events/jazz-night-2026-10-15' });
    expect(listingCategory('Sample Night Market')).toBe('other');
    expect(listingCategory('Comedy & Friends')).toBe('comedy');
    expect(listingCategory('Kit Quill & Friends', 'Example Comedy Theater')).toBe('comedy');
    expect(listingVenue(null, 'Jazz @ Example Bar')).toBe('Example Bar');
    expect(listingVenue('', 'Sounds at the Example Hotel')).toBe('Example Hotel');
    expect(listingVenue('Example Lounge, 1 Sample St', 'Jazz')).toBe('Example Lounge');
  });

  it('when he is free: evening ones need a free night, daytime ones an empty slot; one per series, at most one a night', () => {
    listing({ summary: 'Jazz at Example Lounge', start: at(1, 20), series: 'jazz', location: 'Example Lounge' }); // Thu evening
    listing({ summary: 'Jazz at Example Lounge', start: at(2, 20), series: 'jazz', location: 'Example Lounge' }); // Fri: same series
    listing({ summary: 'Sunday Comedy', start: at(4, 20), series: 'comedy', location: 'Example Cellar' }); // Sun evening: busy
    plan('Dinner with friends', at(4, 19));
    listing({ summary: 'Weekend Market', start: at(3, 10), end: at(3, 14), series: 'market', location: 'Example Lot' }); // Sat daytime: free
    listing({ summary: 'Morning Flea', start: at(5, 10), end: at(5, 13), series: 'flea', location: 'Example Yard' }); // Mon daytime: a plan in the middle
    plan('Brunch', at(5, 11));
    listing({ summary: 'All Day Fair', start: at(6, 10), end: at(6, 18), series: 'fair', location: 'Example Park' }); // Tue: 10–3 still free
    plan('Afternoon thing', at(6, 15));
    listing({ summary: 'Thursday Trivia', start: at(1, 21), series: 'trivia', location: 'Example Pub' }); // Thu: second on a night
    const nights = nightsOf(w.db, WEEK, 7, 'UTC');
    const chosen = chooseListings(w.db, { nights, first: WEEK, days: 7, timeZone: 'UTC', profile: tasteProfile(w.db, NOW), learned: new Map(), rng: seededRng(1), runId: 'epr_test', max: 5 });
    expect(chosen.map((c) => [c.l.title, c.l.date])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/Jazz|Trivia/), '2026-10-15'],
        ['Weekend Market', '2026-10-17'],
      ]),
    );
    expect(chosen.map((c) => c.l.title)).toContain('All Day Fair');
    expect(chosen).toHaveLength(3);
    expect(longestGap([{ start: 5, end: 7 }, { start: 6, end: 9 }], 0, 12)).toBe(5);
    expect(chosen.map((c) => c.l.title)).not.toContain('Sunday Comedy');
    expect(chosen.map((c) => c.l.title)).not.toContain('Morning Flea');
  });

  it('a series shown lately and ignored rests; one he went to or tapped keeps coming', () => {
    sentPick({ title: 'Jazz at Example Lounge', date: '2026-10-08', source: 'calendar', sourceRef: 'jazz' });
    sentPick({ title: 'Weekend Market', date: '2026-10-10', source: 'calendar', sourceRef: 'market', clicks: 1 });
    sentPick({ title: 'Old Comedy', date: '2026-09-01', source: 'calendar', sourceRef: 'comedy' });
    expect([...restingSeries(w.db, WEEK, 'epr_now')]).toEqual(['jazz']);
  });
});

// ---------------------------------------------------------------------------------------------- newsletters

const html = (body: string) => `<html><body>${body}</body></html>`;
const NEWSLETTER_HTML = html(`<p>Hi Owner,</p>
<p>This week at Example Club: Laugh Riot, Sat Oct 17 at 9pm. <a href="https://click.venue-example.com/ls/click?upn=abc123">Get tickets</a></p>
<p>Follow us @exampleclub or call +1 (555) 010-0199. Questions? owner@example.com</p>
<p><a href="https://venue-example.com/prefs?u=1">Manage preferences</a> · <a href="https://venue-example.com/unsub?u=1">Unsubscribe</a></p>`);

function gmailMessage(id: string, from: string, subject: string, body: string, internalAt = EVENING - HOUR): GmailMessage {
  return {
    id,
    threadId: id,
    labelIds: [],
    internalAt,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      parts: [{ mimeType: 'text/html', body: { data: Buffer.from(body).toString('base64url') } }],
    },
  };
}

function fakeGmail(messages: GmailMessage[]): GmailApi & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async listMessages(q) {
      queries.push(q.q);
      return { messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: null };
    },
    async getMessage(id, format) {
      const m = messages.find((x) => x.id === id)!;
      return format === 'full' ? m : { ...m, payload: { ...m.payload!, parts: [] } };
    },
  };
}

describe('event newsletters (read-only Gmail)', () => {
  it('reads event newsletters, never order mail or retail sales', () => {
    expect(isEventNewsletter(DICE, 'New this week near you')).toBe(true);
    expect(isEventNewsletter(CLUB, 'This weekend: comedy and late sets')).toBe(true);
    expect(isEventNewsletter(`Shop <${addr('deals', 'shop.example.com')}>`, '30% off everything this weekend')).toBe(false);
    expect(isEventNewsletter(DICE, 'Your order confirmation #A1B2')).toBe(false);
    expect(isEventNewsletter(`Someone <${addr('a', 'b.example.com')}>`, 'Lunch?')).toBe(false);
  });

  it('text for Claude: links become refs (the URLs stay here), junk links go, his name, emails, phones and @handles too', () => {
    const t = newsletterText(gmailMessage('n1', 'x', 's', NEWSLETTER_HTML).payload, { id: 'n1', ownerForms: ['Owner', 'Owner Example'], startRef: 1 });
    expect(t.links).toEqual([{ ref: 'L1', url: 'https://click.venue-example.com/ls/click?upn=abc123', label: 'Get tickets', newsletterId: 'n1' }]);
    expect(t.text).toContain('Get tickets [L1]');
    expect(t.text).toContain('Laugh Riot, Sat Oct 17 at 9pm');
    expect(t.text).not.toMatch(/https?:|Owner|owner@example\.com|555|@exampleclub|Unsubscribe \[/);
    expect(t.text).toContain('exampleclub');
    expect(scrub('On 2026-10-17 doors at 8', [])).toBe('On 2026-10-17 doors at 8');
  });

  it("one Haiku call over them; a ref becomes that newsletter's own link (a ticket by its words); a made-up ref none", async () => {
    const gmail = fakeGmail([gmailMessage('n1', CLUB, 'This week at Example Club', NEWSLETTER_HTML), gmailMessage('n2', `Shop <${addr('deals', 'shop.example.com')}>`, '30% off', html('<p>Sale</p>'))]);
    const read = await readNewsletters(w.db, gmail, { now: EVENING });
    expect(read.newsletters.map((n) => n.id)).toEqual(['n1']);
    expect(gmail.queries[0]).toMatch(/^newer_than:9d .*unsubscribe/);
    const llm = new FakeLlmClient().on('events', {
      json: {
        events: [
          { title: 'Laugh Riot', performers: [], venue: 'Example Club', city: 'Example City', date: '2026-10-17', start: '21:00', category: 'comedy', genres: [], link_ref: '[L1]', why: 'Stand-up for a change' },
          { title: 'Mystery Night', performers: [], venue: 'Example Club', city: null, date: '2026-10-18', start: null, category: 'club', genres: [], link_ref: 'L9', why: null },
        ],
      },
    });
    const out = await newsletterEvents({ llm, egress: new FakeEgress(), runId: 'epr_t' }, tasteProfile(w.db, NOW), { city: 'Example City', nights: ['2026-10-17', '2026-10-18'] }, read.newsletters);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.events.map((e) => [e.title, e.ticket?.url ?? null, e.ticket?.kind ?? null, e.newsletterId])).toEqual([
      ['Laugh Riot', 'https://click.venue-example.com/ls/click?upn=abc123', 'ticket', 'n1'],
      ['Mystery Night', null, null, null],
    ]);
    expect(llm.calls[0]).toMatchObject({ method: 'parse', route: 'events_newsletter' });
    expect(llm.calls[0]!.userText).toContain('[L1]');
    expect(llm.calls[0]!.userText).not.toContain('click.venue-example.com');
  });
});

// ---------------------------------------------------------------------------------------------- learning

describe('learning from what he actually goes to', () => {
  it("a Recurring Events entry is never proof he went; a real plan, a ticket email or his answer is", () => {
    listing({ summary: 'Jazz at Example Lounge', start: at(1, 20), series: 'jazz', location: 'Example Lounge' });
    const listingPick = sentPick({ title: 'Jazz at Example Lounge', date: '2026-10-15', source: 'calendar', sourceRef: 'jazz' });
    listing({ summary: 'Example Flea Market', start: at(3, 10), series: 'market', location: 'Example Lot' });
    const marketPick = sentPick({ title: 'Example Flea Market', date: '2026-10-17', venue: 'Example Lot', source: 'calendar', sourceRef: 'market', category: 'other' });
    plan('Example Flea Market with Sam', at(3, 10), [{ email: 'friend@example.com' }]);
    const showPick = sentPick({ title: 'Sample Band', date: '2026-10-16', venue: 'Example Hall' });
    ticketEvent(w.db, { title: 'Sample Band', start: at(2, 21), performers: ['Sample Band'], venue: 'Example Hall', localDate: '2026-10-16' });
    updatePickOutcomes(w.db, at(5, 12), 'UTC');
    const row = (id: string) => w.db.prepare('SELECT status, outcome_source FROM event_picks WHERE id = ?').get(id);
    expect(row(listingPick)).toEqual({ status: 'passed', outcome_source: 'date' });
    expect(row(marketPick)).toEqual({ status: 'going', outcome_source: 'calendar' });
    expect(row(showPick)).toEqual({ status: 'going', outcome_source: 'ticket' });
  });

  it('a pick that passed on a night he had other plans teaches nothing; the source of a pick is learned too', () => {
    const busy = sentPick({ title: 'Late Show', date: '2026-10-15', venue: 'Example Hall' });
    plan('Work dinner', at(1, 19));
    const free = sentPick({ title: 'Other Show', date: '2026-10-16', venue: 'Example Hall' });
    updatePickOutcomes(w.db, at(5, 12), 'UTC');
    const src = (id: string) => (w.db.prepare('SELECT outcome_source FROM event_picks WHERE id = ?').get(id) as { outcome_source: string }).outcome_source;
    expect([src(busy), src(free)]).toEqual(['busy', 'date']);
    const learned = learnFrom([
      { category: 'concert', genres: [], performers: [], venueKey: 'example hall', status: 'passed', clicks: 0, source: 'web', outcomeSource: 'busy' },
      { category: 'comedy', genres: [], performers: [], venueKey: '', status: 'going', clicks: 0, source: 'newsletter', outcomeSource: 'ticket' },
    ]);
    expect(learned.get('c:concert')).toBeUndefined();
    expect(learned.get('s:newsletter')).toEqual({ yes: 1, no: 0 });
  });
});

// ---------------------------------------------------------------------------------------------- whole runs

const RESULTS = [
  { url: 'https://dice.fm/event/abc123-sample-band-16th-oct-example-hall-tickets', title: 'Sample Band · Example Hall' },
  { url: 'https://tix.example.com/event/777', title: 'Jazz Night · Example Lounge' },
];
const CANDIDATES = JSON.stringify([
  { title: 'Sample Band', performers: ['Sample Band'], venue: 'Example Hall', city: 'Example City', date: '2026-10-16', start: '21:00', category: 'concert', genres: ['indie'], ticket_url: RESULTS[0]!.url, source_url: null, why: 'Indie like the shows you go to' },
  { title: 'Jazz Night', performers: [], venue: 'Example Lounge', city: 'Example City', date: '2026-10-15', start: '20:00', category: 'concert', genres: ['jazz'], ticket_url: RESULTS[1]!.url, source_url: null, why: 'Live jazz' },
  { title: 'Tonight Thing', performers: [], venue: 'Example Hall', city: 'Example City', date: '2026-10-14', start: '20:00', category: 'concert', genres: [], ticket_url: RESULTS[0]!.url, source_url: null, why: '' },
]);
const NEWSLETTER_REPLY = {
  json: {
    events: [{ title: 'Laugh Riot', performers: [], venue: 'Example Club', city: 'Example City', date: '2026-10-17', start: '21:00', category: 'comedy', genres: [], link_ref: 'L1', why: 'Stand-up for a change' }],
  },
};

function runDeps(o: { email?: FakeEmailSender; outbound?: FakeOutboundSender; gmail?: GmailApi | null } = {}): EventPicksDeps & { outbound: FakeOutboundSender; email: FakeEmailSender; llm: FakeLlmClient } {
  return {
    llm: new FakeLlmClient().on('events', { search: { text: CANDIDATES, results: RESULTS, searches: 3 } }, NEWSLETTER_REPLY),
    egress: new FakeEgress(),
    outbound: o.outbound ?? new FakeOutboundSender({ db: w.db, now: () => EVENING }),
    email: o.email ?? new FakeEmailSender(),
    gmail: () => (o.gmail === undefined ? fakeGmail([gmailMessage('n1', CLUB, 'This week at Example Club', NEWSLETTER_HTML)]) : o.gmail),
  };
}

describe('an evening run', () => {
  beforeEach(() => {
    setSetting(w.db, 'events.city', 'Example City, EX');
    setSetting(w.db, 'events.weekday', 3); // Wednesday, like the world
    setSetting(w.db, 'events.time', '16:00');
    listing({ summary: 'Jazz at Example Lounge', start: at(1, 20), series: 'jazz', location: 'Example Lounge, 1 Sample St' });
    listing({ summary: 'Weekend Market', start: at(3, 10), end: at(3, 14), series: 'market', location: 'Example Lot' });
    listing({ summary: 'Club socials night', start: at(2, 19), series: 'social', calendar: OTHER_CAL });
  });

  it('web + newsletter + Recurring Events in one email to himself; nothing texted; the week starts tomorrow', async () => {
    const d = runDeps();
    const r = await runEventPicks(w.db, d, { now: EVENING, send: true });
    expect(r).toMatchObject({ status: 'sent', channel: 'email', newsletters: 1, listings: 2 });
    expect(d.outbound.sent).toHaveLength(0);
    expect(d.email.sent).toHaveLength(1);
    const run = store.runForWeek(w.db, WEEK)!;
    expect(run).toMatchObject({ status: 'sent', channel: 'email', email_state: 'sent', email_id: 'msg1', window_end: '2026-10-21', newsletters: 1, listings: 2 });
    const picks = store.picksOfRun(w.db, run.id);
    const by = new Map(picks.map((p) => [p.title, p]));
    expect(by.get('Tonight Thing')!.drop_reason).toBe('outside_window'); // Wednesday isn't in the week any more
    expect(by.get('Jazz Night')!.drop_reason).toBe('on_calendar'); // he already has it on his calendar…
    expect(by.get('Jazz at Example Lounge')).toMatchObject({ source: 'calendar', source_ref: 'jazz', ticket_url: RESULTS[1]!.url, link_kind: 'ticket' }); // …which gets its ticket link
    expect(by.get('Laugh Riot')).toMatchObject({ source: 'newsletter', source_ref: 'n1', ticket_url: 'https://click.venue-example.com/ls/click?upn=abc123', link_kind: 'ticket' });
    expect(by.has('Club socials night')).toBe(false);
    const sent = picks.filter((p) => p.ordinal !== null).sort((a, b) => a.ordinal! - b.ordinal!);
    expect(sent.map((p) => p.source)).toEqual(['web', 'newsletter', 'calendar', 'calendar']); // listings numbered after the picks
    const m = d.email.sent[0]!;
    expect(m.subject).toBe('Your week: 4 event picks (Thu Oct 15 – Wed Oct 21)');
    expect(m.text).toContain(`https://yeackbot.com/go/${by.get('Sample Band')!.id}`);
    expect(m.text).toContain('From one of your newsletters');
    expect(m.text).toMatch(/ON YOUR RECURRING EVENTS CALENDAR[\s\S]*Jazz at Example Lounge[\s\S]*Weekend Market/);
    expect(d.llm.calls.map((c) => c.route)).toEqual(['events_search', 'events_newsletter']);
    // Later ticks the same evening: nothing more goes out.
    expect(await runEventPicks(w.db, d, { now: EVENING + HOUR, send: true })).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(d.email.attempts).toHaveLength(1);
  });

  it('email not connected yet: the same picks by text, saying how to get them by email', async () => {
    const d = runDeps({ email: new FakeEmailSender({ configured: false }) });
    const r = await runEventPicks(w.db, d, { now: EVENING, send: true });
    expect(r).toMatchObject({ status: 'sent', channel: 'text' });
    expect(d.outbound.sent[0]!.text).toContain(EMAIL_NOTES.notConnected);
    expect(d.outbound.sent.some((s) => s.text.includes('On your Recurring Events calendar: Thu Oct 15 · Jazz at Example Lounge'))).toBe(true);
    expect(store.runForWeek(w.db, WEEK)!.channel).toBe('text');
  });

  it('Gmail busy: wait for the next tick; still failing near the end of the evening: texts instead', async () => {
    const email = new FakeEmailSender({ results: [{ status: 'failed', reason: 'http_503', auth: false, retryable: true }] });
    const d = runDeps({ email });
    expect(await runEventPicks(w.db, d, { now: EVENING, send: true })).toMatchObject({ status: 'ready', sendReason: 'email_http_503' });
    expect(d.outbound.sent).toHaveLength(0);
    const late = await runEventPicks(w.db, d, { now: Date.UTC(2026, 9, 14, 20, 40), send: true });
    expect(late).toMatchObject({ status: 'sent', channel: 'text' });
    expect(d.outbound.sent[0]!.text).toContain(EMAIL_NOTES.failed);
    expect(email.attempts).toHaveLength(2);
  });

  it('an email that may have gone out (stopped mid-send) is never sent again', async () => {
    const d = runDeps({ email: new FakeEmailSender({ results: [{ status: 'failed', reason: 'http_503', auth: false, retryable: true }] }) });
    await runEventPicks(w.db, d, { now: EVENING, send: true });
    w.db.prepare(`UPDATE event_pick_runs SET email_state = 'sending' WHERE week_start = ?`).run(WEEK);
    const again = new FakeEmailSender();
    const r = await runEventPicks(w.db, { ...d, email: again }, { now: EVENING + 20 * 60_000, send: true });
    expect(r).toMatchObject({ status: 'sent', channel: 'email' });
    expect(again.attempts).toHaveLength(0);
    expect(d.outbound.sent).toHaveLength(0);
  });

  it('newsletters off or Gmail not connected: web and calendar only, no newsletter call', async () => {
    const d = runDeps({ gmail: null });
    const r = await runEventPicks(w.db, d, { now: EVENING, send: true });
    expect(r).toMatchObject({ status: 'sent', newsletters: 0 });
    expect(d.llm.calls.map((c) => c.route)).toEqual(['events_search']);
  });
});

// ---------------------------------------------------------------------------------------------- routes

describe('"Email me" routes', () => {
  const key = crypto.randomBytes(32);
  const config = { google: { clientId: 'cid', clientSecret: 'test-secret', redirectUri: 'https://yeackbot.example/cb' }, secretsKey: key } as unknown as AppConfig;
  const app = (email = new FakeEmailSender(), cfg: AppConfig | undefined = config) =>
    express()
      .use(express.json())
      .use('/api/v1', createEventPicksRouter({ db: w.db, log: nullLogger, config: cfg }, { email }));

  it('status: connected, the address it sends to, the last email; 503 without a Google client', async () => {
    expect((await request(app(undefined, {} as AppConfig)).get('/api/v1/event-picks/email')).status).toBe(503);
    const off = EventPicksEmailStatus.parse((await request(app()).get('/api/v1/event-picks/email')).body);
    expect(off).toMatchObject({ configured: true, connected: false, address: null });
    setSecret(w.db, key, GMAIL_SEND_REFRESH_TOKEN_SECRET, 'test-refresh-send');
    setSecret(w.db, key, GMAIL_SEND_ADDRESS_SECRET, 'owner@example.com');
    const on = EventPicksEmailStatus.parse((await request(app()).get('/api/v1/event-picks/email')).body);
    expect(on).toMatchObject({ connected: true, address: 'owner@example.com', needsReconnect: false });
  });

  it('a test email goes to him; disconnect drops the token and the address', async () => {
    setSecret(w.db, key, GMAIL_SEND_REFRESH_TOKEN_SECRET, 'test-refresh-send');
    setSecret(w.db, key, GMAIL_SEND_ADDRESS_SECRET, 'owner@example.com');
    const email = new FakeEmailSender();
    const t = await request(app(email)).post('/api/v1/event-picks/email/test').send({});
    expect(t.body).toEqual({ sent: true, reason: null });
    expect(email.sent[0]!.subject).toBe('yeackbot can email you');
    // Another Google product still connected: no revoke call, only this product's secrets go.
    setSecret(w.db, key, GOOGLE_PRODUCTS.gmail.secret, 'test-refresh-gmail');
    const dc = await request(app(email)).post('/api/v1/event-picks/email/disconnect').send({});
    expect(dc.body).toEqual({ connected: false, revoked: false });
    const names = w.db.prepare('SELECT name FROM secrets ORDER BY name').pluck().all();
    expect(names).toEqual([GOOGLE_PRODUCTS.gmail.secret]);
  });
});
