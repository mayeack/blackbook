import { describe, expect, it } from 'vitest';
import type { AttendeeView } from '../src/api/types';
import {
  attendeeLine,
  attendeeTier,
  compareAttendees,
  eventPath,
  normalizeAttendee,
  normalizeEventsPage,
  normalizeGoogleStatus,
  normalizeOccasion,
  normalizeOccasionDetail,
  googleOutcome,
  occasionTitle,
  safeHttpsUrl,
  sortOccasions,
  whenLine,
} from '../src/lib/events';

// Synthetic only: invented names, example.com.
const T = new Date(2026, 9, 18, 19, 0).getTime();
const HOUR = 3_600_000;

describe('attendee tiers (≥0.75 counts, 0.5–0.75 possible, below never shown)', () => {
  it('maps status and confidence', () => {
    expect(attendeeTier('going', 1)).toBe('confirmed');
    expect(attendeeTier('attended', 0.8)).toBe('confirmed');
    expect(attendeeTier('attended', 0.74)).toBe('possible');
    expect(attendeeTier('possible', 0.9)).toBe('possible');
    expect(attendeeTier('maybe', 1)).toBe('maybe');
    expect(attendeeTier('invited', 1)).toBe('maybe');
    expect(attendeeTier('declined', 1)).toBe('declined');
    expect(attendeeTier('attended', 0.49)).toBeNull();
    expect(attendeeTier('rejected', 1)).toBeNull();
  });

  it('normalizes tolerant shapes and drops hidden, rejected and weak rows', () => {
    expect(
      normalizeAttendee({ person_id: 'p1', display_name: 'Ana Arroyo', status: 'attended', source: 'llm', confidence: 0.62, evidence: ['m:1', 'm:2'] }),
    ).toMatchObject({ personId: 'p1', name: 'Ana Arroyo', tier: 'possible', source: 'llm', confidence: 0.62, evidenceCount: 2 });
    expect(normalizeAttendee({ person: { id: 'p2', displayName: 'Ben Bell' }, status: 'going', source: 'partiful' })).toMatchObject({
      personId: 'p2',
      name: 'Ben Bell',
      tier: 'confirmed',
      confidence: 1,
      evidenceCount: 0,
    });
    expect(normalizeAttendee({ name: 'Guest', status: 'going' })).toMatchObject({ personId: null, source: 'unknown' });
    expect(normalizeAttendee({ personId: 'p3', name: 'X', hidden: true })).toBeNull();
    expect(normalizeAttendee({ personId: 'p3', name: 'X', status: 'rejected' })).toBeNull();
    expect(normalizeAttendee({ personId: 'p3', name: 'X', confidence: 0.3 })).toBeNull();
    expect(normalizeAttendee('nope')).toBeNull();
  });

  it('sorts confirmed → maybe → possible → declined, known people first, then last name A–Z', () => {
    const a = (name: string, tier: AttendeeView['tier'], personId: string | null = name, lastName: string | null = null): AttendeeView => ({
      personId,
      name,
      firstName: null,
      lastName,
      status: 'going',
      role: null,
      source: 'partiful',
      confidence: 1,
      evidenceCount: 0,
      tier,
    });
    const list = [
      a('Zoë Zimmer', 'confirmed'),
      a('Cher', 'confirmed'),
      a('Émile Ébert', 'confirmed'),
      a('Guest Person', 'confirmed', null),
      a('Bea Brook', 'possible'),
      a('Ana Arroyo', 'maybe'),
      a('Dee Dunn', 'declined'),
      a('Ola de la Vega', 'confirmed', 'ola', 'de la Vega'),
    ].sort(compareAttendees);
    expect(list.map((x) => x.name)).toEqual([
      'Ola de la Vega',
      'Émile Ébert',
      'Zoë Zimmer',
      'Cher',
      'Guest Person',
      'Ana Arroyo',
      'Bea Brook',
      'Dee Dunn',
    ]);
  });

  it('trusts the server’s counted flag and counts evidence entries', () => {
    const row = { personId: 'p', displayName: 'Ana Arroyo', status: 'going', source: 'llm', confidence: 0.9, counted: false, evidence: [{ type: 'logistics', weight: 1, messageIds: [3], ref: null }] };
    expect(normalizeAttendee(row)).toMatchObject({ name: 'Ana Arroyo', tier: 'possible', evidenceCount: 1 });
    expect(normalizeAttendee({ ...row, counted: true })!.tier).toBe('confirmed');
    expect(normalizeAttendee({ ...row, status: 'maybe', counted: false })!.tier).toBe('maybe');
  });

  it('describes an attendee: status or role, source, confidence, clues', () => {
    const base = normalizeAttendee({ personId: 'p', name: 'Ana', status: 'attended', source: 'inference', confidence: 0.6, evidenceCount: 3 })!;
    expect(attendeeLine(base)).toBe('Possibly there · Inferred · 60% · 3 clues');
    expect(attendeeLine(base, { withSource: false })).toBe('Possibly there · 60% · 3 clues');
    const host = normalizeAttendee({ personId: 'p', name: 'Ana', status: 'going', role: 'host', source: 'partiful' })!;
    expect(attendeeLine(host)).toBe('Host · Partiful');
    const cal = normalizeAttendee({ personId: 'p', name: 'Ana', status: 'going', source: 'calendar', evidenceCount: 1 })!;
    expect(attendeeLine(cal)).toBe('Going · Calendar · 1 clue');
  });
});

describe('occasions', () => {
  it('normalizes a list item: counts, sources, sorted attendees', () => {
    const o = normalizeOccasion({
      id: 'occ1',
      title: 'Dinner at Example Bistro',
      kind: 'social',
      starts_at: T,
      ends_at: T + 2 * HOUR,
      venue_text: 'Example Bistro',
      sources: [{ source: 'calendar', role: 'primary' }, 'partiful', 'calendar'],
      attendees: [
        { personId: 'b', name: 'Bea Brook', status: 'attended', confidence: 0.6, source: 'inference', evidenceCount: 2 },
        { personId: 'a', name: 'Ana Arroyo', status: 'going', source: 'partiful' },
        { personId: 'h', name: 'Hidden', hidden: true },
      ],
    })!;
    expect(o).toMatchObject({
      id: 'occ1',
      startsAt: T,
      endsAt: T + 2 * HOUR,
      venue: 'Example Bistro',
      sources: ['calendar', 'partiful'],
      attendeeCount: 1,
      possibleCount: 1,
      evidenceCount: 2,
      allDay: false,
      sensitive: false,
    });
    expect(o.attendees.map((a) => a.personId)).toEqual(['a', 'b']);
    // Server totals win when the card carries only the first few attendees.
    expect(normalizeOccasion({ id: 'x', attendeeCount: 40, possibleCount: 3, evidenceCount: 9 })).toMatchObject({
      attendeeCount: 40,
      possibleCount: 3,
      evidenceCount: 9,
    });
    expect(normalizeOccasion({ title: 'no id' })).toBeNull();
    expect(normalizeOccasion({ id: 'iso', startsAt: '2026-10-18T19:00:00Z' })!.startsAt).toBe(Date.UTC(2026, 9, 18, 19));
    expect(normalizeOccasion({ id: 'one', source: 'partiful' })!.sources).toEqual(['partiful']);
  });

  it('reads pages under items / events / occasions or a bare array', () => {
    expect(normalizeEventsPage({ items: [{ id: 'a' }, { nope: 1 }], nextCursor: 'c2' })).toMatchObject({ items: [{ id: 'a' }], nextCursor: 'c2' });
    expect(normalizeEventsPage({ occasions: [{ id: 'b' }], next_cursor: null }).items.map((i) => i.id)).toEqual(['b']);
    expect(normalizeEventsPage([{ id: 'c' }]).items.map((i) => i.id)).toEqual(['c']);
    expect(normalizeEventsPage(null)).toEqual({ items: [], nextCursor: null });
  });

  it('detail: unwraps, keeps only https links, lists calendar names', () => {
    const d = normalizeOccasionDetail({ occasion: { id: 'o', url: 'https://partiful.example.com/e/abc', calendars: [{ name: 'Personal' }, 'Shared'] } })!;
    expect(d).toMatchObject({ id: 'o', url: 'https://partiful.example.com/e/abc', calendars: ['Personal', 'Shared'] });
    expect(normalizeOccasionDetail({ id: 'o', url: 'javascript:alert(1)' })!.url).toBeNull();
    // routes/events.ts shape: the link lives on the linked Partiful event; sources are objects.
    const landed = normalizeOccasionDetail({
      id: 'o2',
      type: 'occasion',
      sources: [{ source: 'calendar', role: 'primary', title: 't', calendarTreatment: 'attending' }, { source: 'partiful', role: 'primary' }],
      partifulEvent: { id: 'e', title: 't', url: 'https://partiful.example.com/e/x' },
      attendees: [],
    })!;
    expect(landed).toMatchObject({ url: 'https://partiful.example.com/e/x', sources: ['calendar', 'partiful'] });
    expect(normalizeOccasionDetail({ nope: true })).toBeNull();
    expect(safeHttpsUrl('http://example.com')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
  });

  it('titles: sensitive occasions never show theirs', () => {
    expect(occasionTitle({ title: 'Checkup', kind: 'appointment', sensitive: true })).toBe('Private appointment');
    expect(occasionTitle({ title: null, kind: 'social', sensitive: false })).toBe('Untitled event');
    expect(eventPath('a/b')).toBe('/e/a%2Fb');
  });

  it('orders upcoming soonest first and past latest first; undated last', () => {
    const items = [{ id: 'a', startsAt: T }, { id: 'b', startsAt: T - HOUR }, { id: 'c', startsAt: null }, { id: 'd', startsAt: T + HOUR }].map(
      (x) => normalizeOccasion(x)!,
    );
    expect(sortOccasions(items, 'upcoming').map((o) => o.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortOccasions(items, 'past').map((o) => o.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('formats when: timed with weekday, all-day single and multi-day (exclusive end)', () => {
    const now = T;
    expect(whenLine({ startsAt: T, endsAt: T + 2 * HOUR, allDay: false }, now)).toMatch(/^\w{3}, Oct 18, .+ – .+$/);
    const day = new Date(2026, 9, 18).getTime();
    expect(whenLine({ startsAt: day, endsAt: day + 24 * HOUR, allDay: true }, now)).toBe('Oct 18');
    expect(whenLine({ startsAt: day, endsAt: day + 3 * 24 * HOUR, allDay: true }, now)).toBe('Oct 18 – Oct 20');
    expect(whenLine({ startsAt: null, endsAt: null, allDay: false }, now)).toBe('Date not set');
  });
});

describe('Google status', () => {
  it('normalizes calendars (primary first, then by name) and the treatments on offer', () => {
    const g = normalizeGoogleStatus({
      configured: true,
      connected: true,
      account: 'owner@example.com',
      calendars: [
        { id: 'c2', summary: 'US Holidays', treatment: 'excluded' },
        { id: 'c3', name: 'Book club', treatment: 'recurring_special' },
        { id: 'c1', summary: 'Personal', primary: true },
        { summary: 'no id' },
      ],
      last_sync_at: 5,
    });
    expect(g).toMatchObject({ configured: true, connected: true, needsReconnect: false, account: 'owner@example.com', lastSyncAt: 5 });
    expect(g.calendars.map((c) => [c.id, c.treatment])).toEqual([
      ['c1', 'attending'],
      ['c3', 'recurring_special'],
      ['c2', 'excluded'],
    ]);
    // Defaults plus any treatment a calendar already has, so the select can show it.
    expect(g.treatments).toEqual(['attending', 'candidate', 'classify', 'excluded', 'recurring_special']);
    expect(normalizeGoogleStatus({ connected: true, treatments: ['attending', 'excluded'] }).treatments).toEqual(['attending', 'excluded']);
  });

  it('skips removed calendars, reads event counts and secretsAvailable', () => {
    const g = normalizeGoogleStatus({
      configured: true,
      secretsAvailable: false,
      connected: false,
      calendars: [
        { id: 'a', name: 'Personal', treatment: 'attending', primary: true, events: 12 },
        { id: 'b', name: 'Old', treatment: 'candidate', removed: true },
      ],
    });
    expect(g.secretsAvailable).toBe(false);
    expect(g.calendars).toEqual([{ id: 'a', name: 'Personal', treatment: 'attending', primary: true, events: 12 }]);
    expect(normalizeGoogleStatus({}).secretsAvailable).toBe(true);
  });

  it('words the OAuth callback outcome', () => {
    expect(googleOutcome(null)).toBeNull();
    expect(googleOutcome('connected')!.tone).toBe('ok');
    for (const o of ['denied', 'expired', 'scope', 'invalid', 'error']) expect(googleOutcome(o)!.tone, o).toBe('bad');
  });

  it('reads not configured / not connected / needs reconnect', () => {
    expect(normalizeGoogleStatus({ configured: false })).toMatchObject({ configured: false, connected: false });
    expect(normalizeGoogleStatus({ status: 'not_configured' }).configured).toBe(false);
    expect(normalizeGoogleStatus({})).toMatchObject({ configured: true, connected: false, needsReconnect: false, calendars: [] });
    expect(normalizeGoogleStatus({ connected: true, needsReconnect: true })).toMatchObject({ connected: false, needsReconnect: true });
    expect(normalizeGoogleStatus({ status: 'connected' }).connected).toBe(true);
  });
});
