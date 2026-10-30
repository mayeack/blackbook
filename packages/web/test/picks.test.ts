import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { EventPickItem, EventPicksResponse, EventPicksWeek } from '@yb/shared';
import { keys, postPickFeedback } from '../src/api/hooks';
import { historyLine, localDayMs, pickActions, pickLink, pickMeta, pickSource, pickStatus, pickTime, sortPicks, weekLine, withPick } from '../src/lib/picks';
import { PickCard, PicksPage } from '../src/pages/events/PicksPage';

// Synthetic only: invented bands, venues and hosts (*.example). Nothing may reach the network unless a test stubs it.
const refuse = () => Promise.reject(new Error('network disabled in tests'));
beforeAll(() => {
  vi.stubGlobal('fetch', refuse);
});
afterEach(() => {
  vi.stubGlobal('fetch', refuse);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const pick = (o: Partial<EventPickItem> = {}): EventPickItem => ({
  id: 'pk-1',
  ordinal: 2,
  title: 'Sample Band',
  performers: ['Sample Band', 'Opener Example'],
  venue: 'Example Hall',
  localDate: '2026-10-30',
  startTime: '22:00',
  category: 'concert',
  genres: ['indie'],
  linkKind: 'ticket',
  ticketHost: 'tickets.example',
  why: 'Like the indie shows you went to this summer.',
  wildcard: false,
  source: 'web',
  status: 'picked',
  outcomeSource: null,
  clicks: 0,
  ...o,
});

const PICKS: EventPickItem[] = [
  pick(),
  pick({
    id: 'pk-2',
    ordinal: 1,
    title: 'Late Laughs',
    performers: [],
    venue: 'Example Cellar',
    startTime: '19:30',
    category: 'comedy',
    genres: [],
    linkKind: 'listing',
    ticketHost: null,
    why: 'Something different: a stand-up night near you.',
    wildcard: true,
  }),
  pick({ id: 'pk-3', ordinal: 3, title: 'Neon Example', linkKind: 'resale', ticketHost: 'resale.example', status: 'going', outcomeSource: 'ticket' }),
  pick({ id: 'pk-4', ordinal: 4, title: 'Quiet Example', linkKind: null, ticketHost: null, why: null, status: 'not_for_me', outcomeSource: 'owner' }),
];

const week = (o: Partial<EventPicksWeek> = {}): EventPicksWeek => ({
  weekStart: '2026-10-26',
  windowEnd: '2026-11-01',
  status: 'sent',
  city: 'Springfield',
  freeNights: ['2026-10-27', '2026-10-30', '2026-10-31'],
  sentAt: new Date(2026, 9, 26, 9, 30).getTime(),
  found: 14,
  searches: 6,
  newsletters: 0,
  channel: 'text',
  picks: PICKS,
  ...o,
});

const response = (o: Partial<EventPicksResponse> = {}): EventPicksResponse => ({
  week: week(),
  history: { going: 3, notForMe: 1, passed: 0, open: 2 },
  enabled: true,
  ...o,
});

/** Server-renders /picks over a query cache seeded with `res` (the mocked GET /event-picks). */
function render(res: EventPicksResponse | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (res) qc.setQueryData(keys.eventPicks, res);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(PicksPage))));
}

/** The markup of each card, in page order. */
const cards = (html: string) => html.split('<article').slice(1);

// A React element tree walk, so a card's buttons can be pressed without a DOM.
interface El {
  type: unknown;
  props: { children?: unknown; onClick?: () => void; [k: string]: unknown };
}
const isEl = (n: unknown): n is El => typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
const textOf = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : isEl(n) ? textOf(n.props.children) : '';
function buttons(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const c of node) buttons(c, out);
  else if (isEl(node)) {
    if (node.type === 'button') out.push(node);
    buttons(node.props.children, out);
  }
  return out;
}
const press = (card: unknown, label: string) => {
  const b = buttons(card).find((x) => textOf(x.props.children) === label);
  if (!b) throw new Error(`no "${label}" button`);
  b.props.onClick?.();
};

describe('event pick lines', () => {
  it('the week: start day, city, free nights, and how it went out', () => {
    expect(weekLine(week())).toBe('Week of Mon, Oct 26 · Springfield · 3 free nights · texted');
    expect(weekLine(week({ channel: 'email' }))).toBe('Week of Mon, Oct 26 · Springfield · 3 free nights · emailed');
    expect(weekLine(week({ channel: null }))).toBe('Week of Mon, Oct 26 · Springfield · 3 free nights · sent');
    expect(weekLine(week({ status: 'ready', city: null, freeNights: ['2026-10-27'] }))).toBe('Week of Mon, Oct 26 · 1 free night');
  });

  it('where a pick came from, and a night that passed while he had plans', () => {
    expect(pickSource(pick())).toBeNull();
    expect(pickSource(pick({ source: 'newsletter' }))).toBe('From your newsletters');
    expect(pickSource(pick({ source: 'calendar' }))).toBe('Recurring Events calendar');
    expect(pickStatus(pick({ status: 'passed', outcomeSource: 'busy' }))?.label).toBe('Passed · you had plans');
    expect(pickStatus(pick({ status: 'passed', outcomeSource: 'date' }))?.label).toBe('Passed');
  });

  it('venue · start time, compact; the date tile gets the local date and time', () => {
    expect(pickTime('22:00')).toBe('10pm');
    expect(pickTime('19:30')).toBe('7:30pm');
    expect(pickTime('00:15')).toBe('12:15am');
    expect(pickTime('12:00')).toBe('12pm');
    expect(pickMeta(pick())).toBe('Example Hall · 10pm');
    expect(pickMeta(pick({ startTime: null }))).toBe('Example Hall');
    expect(pickMeta(pick({ venue: ' ', startTime: null }))).toBe('');
    expect(localDayMs('2026-10-30', '22:00')).toBe(new Date(2026, 9, 30, 22, 0).getTime());
    expect(localDayMs('2026-10-30')).toBe(new Date(2026, 9, 30).getTime());
  });

  it('status pills: none while open; Going says what yeackbot found', () => {
    expect(pickStatus(pick())).toBeNull();
    expect(pickStatus(pick({ status: 'going', outcomeSource: 'owner' }))).toEqual({ label: 'Going', tone: 'ok' });
    expect(pickStatus(pick({ status: 'going', outcomeSource: 'ticket' }))?.label).toBe('Going · found your ticket');
    expect(pickStatus(pick({ status: 'going', outcomeSource: 'calendar' }))?.label).toBe('Going · on your calendar');
    expect(pickStatus(pick({ status: 'going', outcomeSource: 'partiful' }))?.label).toBe('Going · Partiful RSVP');
    expect(pickStatus(pick({ status: 'not_for_me', outcomeSource: 'owner' }))).toEqual({ label: 'Not for me', tone: 'neutral' });
    expect(pickStatus(pick({ status: 'passed', outcomeSource: 'date' }))?.label).toBe('Passed');
  });

  it('links go through /go/<id>, labelled by kind and host', () => {
    expect(pickLink(pick())).toEqual({ href: '/go/pk-1', label: 'Get tickets on tickets.example' });
    expect(pickLink(pick({ linkKind: 'resale', ticketHost: null }))).toEqual({ href: '/go/pk-1', label: 'Get tickets' });
    expect(pickLink(pick({ linkKind: 'listing' }))?.label).toBe('See listing');
    expect(pickLink(pick({ id: 'pk 1/2' }))?.href).toBe('/go/pk%201%2F2');
    expect(pickLink(pick({ linkKind: null }))).toBeNull();
  });

  it('answers while open or passed; Undo only for the owner’s own answer', () => {
    expect(pickActions(pick())).toEqual({ answer: true, undo: false });
    expect(pickActions(pick({ status: 'passed', outcomeSource: 'date' }))).toEqual({ answer: true, undo: false });
    expect(pickActions(pick({ status: 'going', outcomeSource: 'ticket' }))).toEqual({ answer: false, undo: false });
    expect(pickActions(pick({ status: 'going', outcomeSource: 'owner' }))).toEqual({ answer: false, undo: true });
    expect(pickActions(pick({ status: 'not_for_me', outcomeSource: 'owner' }))).toEqual({ answer: false, undo: true });
  });

  it('history footer leaves zeros out; order by ordinal; the POST answer replaces its pick', () => {
    expect(historyLine({ going: 3, notForMe: 1, passed: 0, open: 2 })).toBe('So far: 3 went · 1 not for me');
    expect(historyLine({ going: 0, notForMe: 0, passed: 4, open: 0 })).toBe('So far: 4 passed');
    expect(historyLine({ going: 0, notForMe: 0, passed: 0, open: 5 })).toBeNull();
    expect(sortPicks(PICKS).map((p) => p.id)).toEqual(['pk-2', 'pk-1', 'pk-3', 'pk-4']);
    expect(PICKS[0]!.id).toBe('pk-1');
    const next = withPick(response(), { ...PICKS[0]!, status: 'going', outcomeSource: 'owner' });
    expect(next.week?.picks.map((p) => p.status)).toEqual(['going', 'picked', 'going', 'not_for_me']);
    expect(withPick(response({ week: null }), PICKS[0]!).week).toBeNull();
  });
});

describe('Event picks page', () => {
  it('renders the week, one card per pick in the text’s order, and the history', () => {
    const html = render(response());
    expect(html).toContain('<h1>Event picks</h1>');
    expect(html).toContain('Events on your free nights, from the web, your newsletters and your Recurring Events calendar.');
    expect(html).toContain('Week of Mon, Oct 26 · Springfield · 3 free nights · texted');
    expect(cards(html).map((c) => /aria-label="([^"]+)"/.exec(c)?.[1])).toEqual(['Late Laughs', 'Sample Band', 'Neon Example', 'Quiet Example']);
    expect(html).toContain('So far: 3 went · 1 not for me');
  });

  it('a ticket pick: meta, performers, why, a /go link in a new tab, both answers', () => {
    const c = cards(render(response()))[1]!;
    expect(c).toContain('Example Hall · 10pm');
    expect(c).toContain('Opener Example');
    expect(c).toContain('Like the indie shows you went to this summer.');
    expect(c).toContain('<a class="btn btn-sm btn-primary" href="/go/pk-1" target="_blank" rel="noopener noreferrer">Get tickets on tickets.example</a>');
    expect(c).toContain('>I’m going</button>');
    expect(c).toContain('>Not for me</button>');
    expect(c).not.toContain('Undo');
    expect(c).not.toContain('Going');
  });

  it('the wildcard gets its pill and a listing link', () => {
    const c = cards(render(response()))[0]!;
    expect(c).toContain('🎲 Something different');
    expect(c).toContain('href="/go/pk-2"');
    expect(c).toContain('>See listing</a>');
    expect(c).toContain('Example Cellar · 7:30pm');
  });

  it('going (found a ticket): the pill says so, no answer buttons; the owner’s Not for me offers Undo', () => {
    const [, , going, notForMe] = cards(render(response()));
    expect(going).toContain('Going · found your ticket');
    expect(going).toContain('Get tickets on resale.example');
    expect(going).not.toContain('</button>');
    expect(notForMe).toContain('<span class="pill">Not for me</span>');
    expect(notForMe).toContain('>Undo</button>');
    expect(notForMe).not.toContain('>Not for me</button>');
    expect(notForMe).not.toContain('/go/pk-4');
  });

  it('empty and off states; no footer without answers', () => {
    const none = render(response({ week: null, history: { going: 0, notForMe: 0, passed: 0, open: 0 } }));
    expect(none).toContain('No picks yet.');
    expect(none).toContain('They arrive once a week.');
    expect(none).not.toContain('So far');
    const off = render(response({ week: null, enabled: false }));
    expect(off).toContain('Weekly event picks are off.');
    expect(off).toContain('href="/settings/agent"');
    expect(off).not.toContain('No picks yet.');
    // Turned off after a week went out: that week stays answerable under the notice.
    const offWithWeek = render(response({ enabled: false }));
    expect(offWithWeek).toContain('Weekly event picks are off.');
    expect(cards(offWithWeek)).toHaveLength(4);
    expect(render(null)).toContain('Loading…');
  });

  it('each button answers with its verdict', () => {
    const verdicts: string[] = [];
    const card = PickCard({ p: pick(), onVerdict: (v) => verdicts.push(v) });
    press(card, 'I’m going');
    press(card, 'Not for me');
    press(PickCard({ p: pick({ status: 'not_for_me', outcomeSource: 'owner' }), onVerdict: (v) => verdicts.push(v) }), 'Undo');
    expect(verdicts).toEqual(['going', 'not_for_me', 'undo']);
  });

  it('clicking Not for me POSTs {verdict: not_for_me} to /api/v1/event-picks/<id>/feedback', async () => {
    const updated = pick({ status: 'not_for_me', outcomeSource: 'owner' });
    const json = { status: 200, headers: { 'content-type': 'application/json' } };
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(updated), json));
    vi.stubGlobal('fetch', fetch);
    let answer: Promise<EventPickItem> | null = null;
    const p = pick();
    press(PickCard({ p, onVerdict: (verdict) => (answer = postPickFeedback({ id: p.id, verdict })) }), 'Not for me');
    expect(await answer).toEqual(updated);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/event-picks/pk-1/feedback');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-YB': '1' });
    expect(JSON.parse(String(init.body))).toEqual({ verdict: 'not_for_me' });
  });
});
