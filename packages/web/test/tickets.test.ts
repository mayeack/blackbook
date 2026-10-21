import { describe, expect, it } from 'vitest';
import type { GphotosSessionView, MetAtLink, TicketItem } from '@yb/shared';
import {
  gmailNotConfigured,
  gmailSummary,
  gphotosNotConfigured,
  gphotosSummary,
  healthProblem,
  pickerLink,
  productOutcome,
  sessionActive,
  sessionProgress,
} from '../src/lib/googleProducts';
import { channelsOf, metSignalLabel, sourceCardLabel, sourceLabel, ticketCategoryLabel, ticketStatus } from '../src/lib/labels';
import { countRows, fixCopy, GMAIL_CONNECT_URL, GPHOTOS_CONNECT_URL, googleProductFix, reconnectCopy } from '../src/lib/sources';
import {
  flattenTickets,
  metAtDetail,
  metAtHeader,
  metAtLine,
  performersLine,
  ticketCountsLine,
  ticketHref,
  ticketKindLine,
  ticketPlace,
  ticketsWhen,
  ticketWhen,
} from '../src/lib/tickets';

// Synthetic only: invented titles, venues and names.
const T = new Date(2026, 9, 18, 20, 0).getTime();
const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 16, 12).getTime();

const ticket = (o: Partial<TicketItem> = {}): TicketItem => ({
  id: 'tk-1',
  title: 'Neon Nights',
  performers: ['DJ Sample'],
  category: 'club',
  genres: ['house', 'techno'],
  venue: 'The Hall',
  city: 'Springfield',
  startsAt: T,
  endsAt: T + 4 * HOUR,
  localDate: '2026-10-18',
  status: 'holding',
  held: 2,
  quantities: { bought: 4, received: 0, sent: 2, sold: 0, refunded: 0 },
  vendors: ['dice'],
  occasionId: null,
  metHere: [],
  metHereCount: 0,
  ...o,
});

const link = (o: Partial<MetAtLink> = {}): MetAtLink => ({
  id: 'l1',
  target: { type: 'occasion', id: 'occ-1' },
  title: 'Neon Nights',
  startsAt: T,
  venue: 'The Hall',
  href: '/e/occ-1',
  signal: 'instagram_follow',
  signalAt: T + 2 * HOUR,
  confidence: 0.82,
  screenshot: false,
  ...o,
});

const session = (o: Partial<GphotosSessionView> = {}): GphotosSessionView => ({
  id: 'sess-1',
  status: 'open',
  itemsTotal: 0,
  itemsNew: 0,
  processed: 0,
  linked: 0,
  createdAt: T,
  expiresAt: null,
  ...o,
});

describe('ticket cards', () => {
  it('?when=past switches tabs; anything else is upcoming', () => {
    expect(ticketsWhen(new URLSearchParams('when=past'))).toBe('past');
    expect(ticketsWhen(new URLSearchParams('when=later'))).toBe('upcoming');
    expect(ticketsWhen(new URLSearchParams())).toBe('upcoming');
  });

  it('when and where: weekday + span; venue · city, the city not repeated', () => {
    expect(ticketWhen(ticket(), NOW)).toMatch(/^\w{3}, Oct 18, 8:00/);
    expect(ticketPlace(ticket())).toBe('The Hall · Springfield');
    expect(ticketPlace(ticket({ venue: 'The Hall, Springfield' }))).toBe('The Hall, Springfield');
    expect(ticketPlace(ticket({ venue: null }))).toBe('Springfield');
    expect(ticketPlace(ticket({ venue: ' ', city: null }))).toBeNull();
  });

  it('counts: the status headline, then every non-zero flow', () => {
    expect(ticketCountsLine(ticket())).toBe('You hold 2 tickets · bought 4 · sent 2');
    expect(ticketCountsLine(ticket({ held: 1, quantities: { bought: 0, received: 1, sent: 0, sold: 0, refunded: 0 } }))).toBe('You hold 1 ticket · received 1');
    expect(ticketCountsLine(ticket({ held: null }))).toBe('Holding (count unknown) · bought 4 · sent 2');
    expect(ticketCountsLine(ticket({ status: 'sold', held: 0, quantities: { bought: 2, received: 0, sent: 0, sold: 2, refunded: 0 } }))).toBe('All sold · bought 2 · sold 2');
    expect(ticketCountsLine(ticket({ status: 'gave_away', held: 0 }))).toBe('All given away · bought 4 · sent 2');
    expect(ticketCountsLine(ticket({ status: 'unconfirmed', held: null, quantities: { bought: 0, received: 0, sent: 0, sold: 0, refunded: 0 } }))).toBe(
      'No ticket confirmation found',
    );
    expect(ticketCountsLine(ticket({ status: 'cancelled' }))).toMatch(/^Event cancelled/);
    expect(ticketCountsLine(ticket({ status: 'refunded', quantities: { bought: 2, received: 0, sent: 0, sold: 0, refunded: 2 } }))).toBe('Refunded · bought 2 · refunded 2');
  });

  it('kind, performers and the link to its get-together', () => {
    expect(ticketKindLine(ticket())).toBe('Club night · house, techno');
    expect(ticketKindLine(ticket({ category: 'member_event', genres: [] }))).toBe('Members’ event');
    expect(performersLine(ticket({ title: 'DJ Sample', performers: ['DJ Sample'] }))).toBeNull();
    expect(performersLine(ticket({ performers: ['A', 'B', 'C', 'D', 'E', 'F'] }))).toBe('A, B, C, D +2');
    expect(ticketHref(ticket())).toBeNull();
    expect(ticketHref(ticket({ occasionId: 'occ 1' }))).toBe('/e/occ%201');
  });

  it('pages join in order and a ticket that moved between pages shows once', () => {
    const a = ticket({ id: 'a' });
    const b = ticket({ id: 'b' });
    expect(flattenTickets([{ items: [a, b] }, { items: [b, ticket({ id: 'c' })] }]).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('status pills and labels', () => {
    expect(ticketStatus('holding')).toEqual({ label: 'Holding', tone: 'ok' });
    expect(ticketStatus('cancelled').tone).toBe('bad');
    expect(ticketStatus('gave_away').label).toBe('Gave away');
    expect(ticketStatus('mystery')).toEqual({ label: 'Mystery', tone: 'neutral' });
    expect(ticketCategoryLabel('festival')).toBe('Festival');
    // The events pages badge a ticket source in a fixed place after Calendar.
    expect(sourceLabel('ticket')).toBe('Ticket');
    expect(channelsOf(['ticket', 'partiful', 'gcal'])).toEqual(['partiful', 'calendar', 'ticket']);
    expect(sourceCardLabel('gmail')).toBe('Gmail (tickets)');
    expect(sourceCardLabel('gphotos')).toBe('Google Photos (screenshots)');
  });
});

describe('met at', () => {
  it('lines for the person page: event · date · via signal; how sure and when they connected', () => {
    expect(metAtLine(link(), NOW)).toBe('Met at Neon Nights · Oct 18 · via an Instagram follow');
    expect(metAtLine(link({ title: null, signal: 'contact_added' }), NOW)).toBe('Met at an event · Oct 18 · via a new contact card');
    expect(metAtDetail(link(), NOW)).toBe('82% sure · connected Oct 18');
    expect(metAtDetail(link({ screenshot: true }), NOW)).toBe('82% sure · connected Oct 18 · you saved their contact');
    expect(metSignalLabel('contact_screenshot')).toBe('a contact screenshot');
    expect(metSignalLabel('something_new')).toBe('something new');
  });

  it('the header line names the first link, or nothing', () => {
    expect(metAtHeader({ links: [link(), link({ id: 'l2', title: 'Later' })] }, NOW)).toEqual({
      title: 'Neon Nights',
      when: 'Oct 18',
      via: 'an Instagram follow',
      href: '/e/occ-1',
    });
    expect(metAtHeader({ links: [link({ title: null, signal: 'contact_screenshot' })] }, NOW)).toMatchObject({ title: 'an event', via: 'a contact screenshot' });
    expect(metAtHeader({ links: [] })).toBeNull();
    expect(metAtHeader(null)).toBeNull();
  });
});

describe('Settings → Email & photos', () => {
  it('callback outcomes per product (?gmail= / ?gphotos=)', () => {
    expect(productOutcome('gmail', null)).toBeNull();
    expect(productOutcome('gmail', '')).toBeNull();
    expect(productOutcome('gmail', 'connected')).toMatchObject({ tone: 'ok', text: expect.stringContaining('Gmail connected') });
    expect(productOutcome('gphotos', 'connected')).toMatchObject({ tone: 'ok', text: expect.stringContaining('Google Photos connected') });
    expect(productOutcome('gphotos', 'denied')).toEqual({ tone: 'bad', text: 'Google Photos access was declined, so nothing was connected.' });
    expect(productOutcome('gmail', 'scope')?.text).toMatch(/read access to your email/);
    expect(productOutcome('gmail', 'expired')?.tone).toBe('bad');
    expect(productOutcome('gmail', 'error')?.text).toBe('Gmail couldn’t be connected. Try again in a minute.');
  });

  it('which fix each panel shows: set up the client, set SECRETS_KEY, connect, reconnect, or none', () => {
    const base = { configured: true, secretsAvailable: true, connected: true, needsReconnect: false };
    expect(googleProductFix('gmail', undefined)).toBeNull();
    expect(googleProductFix('gmail', { ...base, configured: false })).toEqual({ kind: 'google_not_configured' });
    expect(googleProductFix('gmail', { ...base, connected: false })).toEqual({ kind: 'connect_gmail' });
    expect(googleProductFix('gphotos', { ...base, connected: false })).toEqual({ kind: 'connect_gphotos' });
    expect(googleProductFix('gphotos', { ...base, connected: false, secretsAvailable: false })).toEqual({ kind: 'google_secrets_missing' });
    expect(googleProductFix('gmail', { ...base, needsReconnect: true })).toEqual({ kind: 'connect_gmail' });
    expect(googleProductFix('gmail', base)).toBeNull();
    expect(googleProductFix('gmail', gmailNotConfigured())).toEqual({ kind: 'google_not_configured' });
    expect(googleProductFix('gphotos', gphotosNotConfigured())).toEqual({ kind: 'google_not_configured' });
  });

  it('connect buttons go to the product’s own consent; reconnect wording names it', () => {
    expect(fixCopy({ kind: 'connect_gmail' }).action).toEqual({ label: 'Connect Gmail', href: '/api/v1/google/connect?product=gmail' });
    expect(fixCopy({ kind: 'connect_gphotos' }).action).toEqual({ label: 'Connect Google Photos', href: '/api/v1/google/connect?product=photos' });
    expect(GMAIL_CONNECT_URL).toBe('/api/v1/google/connect?product=gmail');
    expect(GPHOTOS_CONNECT_URL).toBe('/api/v1/google/connect?product=photos');
    expect(fixCopy({ kind: 'connect_gphotos' }).body).toMatch(/never sent to an AI/);
    expect(reconnectCopy('connect_gmail')?.title).toBe('Reconnect Gmail');
    expect(reconnectCopy('connect_google')?.title).toBe('Reconnect Google Calendar');
    expect(reconnectCopy('sign_in_partiful')).toBeNull();
  });

  it('Sources count rows for the Gmail and Google Photos cards', () => {
    expect(countRows({ emailsScanned: 1200, ticketEmails: 14, tickets: 6, screenshots: 0 })).toEqual([
      { label: 'Emails checked', value: (1200).toLocaleString() },
      { label: 'Ticket emails', value: '14' },
      { label: 'Ticketed events', value: '6' },
    ]);
    expect(countRows({ screenshots: 9, screenshotsLinked: 6 }).map((r) => r.label)).toEqual(['Screenshots read', 'Linked to people']);
  });

  it('summaries', () => {
    const g = gmailNotConfigured();
    expect(gmailSummary(g)).toBe('No ticket emails found yet.');
    expect(gmailSummary({ counts: { scanned: 50, ticketEmails: 14, parsed: 11, pending: 3, events: 6, upcoming: 2 } })).toBe(
      '14 ticket emails · 6 events (2 coming up) · 3 waiting to be read',
    );
    expect(gmailSummary({ counts: { scanned: 5, ticketEmails: 1, parsed: 1, pending: 0, events: 1, upcoming: 0 } })).toBe('1 ticket email · 1 event');
    expect(gphotosSummary(gphotosNotConfigured())).toBe('No screenshots picked yet.');
    expect(gphotosSummary({ counts: { screenshots: 9, linked: 6, pendingOcr: 2 } })).toBe('9 screenshots · 6 linked to people · 2 waiting for the Mac helper');
  });

  it('a connected panel names its health problem: errors only', () => {
    const h = (status: string, lastError: string | null = null) => ({ status, lastError, lastOkAt: null, checkedAt: T });
    expect(healthProblem(null)).toBeNull();
    expect(healthProblem(h('ok'))).toBeNull();
    expect(healthProblem(h('unknown'))).toBeNull();
    expect(healthProblem(h('auth_required', 'invalid_grant'))).toBeNull(); // the Reconnect box says it
    expect(healthProblem(h('error', 'The Gmail API is not enabled in the Google Cloud project.'))).toBe('The Gmail API is not enabled in the Google Cloud project.');
    expect(healthProblem(h('error', '  '))).toBe('The last check failed.');
    expect(healthProblem(h('contract_broken'))).toMatch(/unexpected shape/);
  });

  it('the picker opens Google’s https page + /autoclose, nothing else', () => {
    expect(pickerLink('https://photos.google.com/picker/abc123')).toBe('https://photos.google.com/picker/abc123/autoclose');
    expect(pickerLink('https://photos.google.com/picker/abc123/')).toBe('https://photos.google.com/picker/abc123/autoclose');
    expect(pickerLink('http://photos.google.com/picker/abc123')).toBeNull();
    expect(pickerLink('https://photos.google.com.evil.example/picker/x')).toBeNull();
    expect(pickerLink('javascript:alert(1)')).toBeNull();
    expect(pickerLink('not a url')).toBeNull();
  });

  it('session progress: picking, downloading, reading on the Mac, done; polling stops once nothing moves', () => {
    expect(sessionProgress(session())).toMatch(/Waiting for your picks/);
    expect(sessionActive(session())).toBe(true);
    expect(sessionProgress(session({ status: 'picked', itemsTotal: 12 }))).toBe('Downloading 12 photos…');
    expect(sessionActive(session({ status: 'picked' }))).toBe(true);
    const reading = session({ status: 'done', itemsTotal: 12, itemsNew: 9, processed: 4 });
    expect(sessionProgress(reading)).toBe('9 new screenshots (3 already read) · reading 4 of 9 on the Mac…');
    expect(sessionActive(reading)).toBe(true);
    const done = session({ status: 'done', itemsTotal: 9, itemsNew: 9, processed: 9, linked: 6 });
    expect(sessionProgress(done)).toBe('9 new screenshots · 6 people linked');
    expect(sessionActive(done)).toBe(false);
    expect(sessionProgress(session({ status: 'done', itemsTotal: 3, itemsNew: 0 }))).toBe('No new screenshots (3 already read) · 0 people linked');
    expect(sessionProgress(session({ status: 'done' }))).toBe('Nothing was picked.');
    expect(sessionProgress(session({ status: 'expired' }))).toMatch(/expired/);
    expect(sessionActive(session({ status: 'expired' }))).toBe(false);
    expect(sessionProgress(session({ status: 'failed' }))).toMatch(/Try again/);
    expect(sessionProgress(session({ status: 'cancelled' }))).toMatch(/cancelled/);
  });
});
