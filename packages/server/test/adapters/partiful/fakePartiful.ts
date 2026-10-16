/**
 * Synthetic Partiful for tests: api.partiful.com callable functions and securetoken.googleapis.com behind an undici
 * MockAgent (no network), plus a fake sandbox browser (CDP) whose partiful.com page runs the real IndexedDB reader
 * script against an in-memory IndexedDB. Every value is invented (uid-…, synthetic-…, example handles).
 */
import vm from 'node:vm';
import { MockAgent } from 'undici';
import type { CdpBrowser, CdpConnect, CdpContext, CdpPage } from '../../../src/adapters/partiful/session';

export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
export const DAY = 86_400_000;
export const ME = 'uid-me-0001';
export const API_KEY = 'synthetic-api-key-0001';
export const REFRESH = 'synthetic-refresh-token-0001';
export const SESSION = { uid: ME, apiKey: API_KEY, refreshToken: REFRESH };

export const iso = (ms: number) => new Date(ms).toISOString();

export interface FakeGuest {
  id: string;
  userId?: string;
  /** An embedded profile, as some guest records carry. */
  user?: { id: string; name: string; socials?: Record<string, unknown> };
  name?: string;
  status: string;
  invitedBy?: string;
  anchorGuestId?: string;
  rsvpDate?: string;
}

export interface FakeEvent {
  id: string;
  title: string;
  startDate: string | null;
  list: 'upcoming' | 'past';
  ownerIds: string[];
  status?: string;
  showGuestList?: boolean;
  guestStatusCounts?: Record<string, number>;
  guest?: { id?: string; status: string; invitedBy?: string };
  locationDisplayText?: string;
  guests: FakeGuest[];
}

export interface FakeUser {
  id: string;
  name: string;
  socials?: { instagram?: { value: string } | string };
}

export interface FakeContact {
  userId: string;
  name: string;
  sharedEventCount: number;
  isPastGuest?: boolean;
  sharedEvent?: { id: string; title: string; startDate: string };
}

type Reply = { statusCode: number; data: object | string };

const header = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === name) return String(v);
  return undefined;
};

export interface RecordedCall {
  fn: string;
  params: Record<string, unknown>;
  paging: Record<string, unknown> | undefined;
  userId: unknown;
  headers: Record<string, string | undefined>;
}

export class FakePartiful {
  readonly agent = new MockAgent();
  readonly events: FakeEvent[] = [];
  readonly users = new Map<string, FakeUser>();
  readonly contacts: FakeContact[] = [];
  readonly mutuals: FakeContact[] = [];
  /** getEventInfo answers for ids not in any list (text-only events). */
  readonly eventInfo = new Map<string, Omit<FakeEvent, 'guests' | 'list'>>();
  readonly calls: RecordedCall[] = [];
  readonly tokenCalls: { key: string | null; refreshToken: string | null; referer: string | undefined }[] = [];
  /** The refresh tokens securetoken accepts. */
  readonly validRefresh = new Set([REFRESH]);
  /** When set, securetoken hands out this refresh token instead (rotation). */
  rotateTo: string | null = null;
  guestPageSize = 500;
  /** getUsers answers at most this many profiles per call (live 2026-10-16: only the first id came back). */
  usersPerCall = Infinity;
  /** Responses to substitute per function (contract-break tests); undefined falls through to the normal answer. */
  readonly override = new Map<string, (params: Record<string, unknown>) => Reply | undefined>();
  /** Function names answering 401 regardless of the token (n times). */
  unauthorized = 0;
  private tokenSeq = 0;
  private liveTokens = new Set<string>();

  constructor() {
    this.agent.disableNetConnect();
    this.agent
      .get('https://api.partiful.com')
      .intercept({ path: () => true, method: 'POST' })
      .reply((opts) => this.route(opts.path, opts.headers, opts.body))
      .persist();
    this.agent
      .get('https://securetoken.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/v1/token'), method: 'POST' })
      .reply((opts) => this.token(opts.path, opts.headers, opts.body))
      .persist();
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** The ID tokens handed out so far (to assert none leaks). */
  issuedTokens(): string[] {
    return [...this.liveTokens];
  }

  fnCalls(fn: string): RecordedCall[] {
    return this.calls.filter((c) => c.fn === fn);
  }

  private token(path: string, headers: unknown, body: unknown): Reply {
    const url = new URL(path, 'https://securetoken.googleapis.com');
    const form = new URLSearchParams(typeof body === 'string' ? body : '');
    const call = { key: url.searchParams.get('key'), refreshToken: form.get('refresh_token'), referer: header(headers, 'referer') };
    this.tokenCalls.push(call);
    if (call.referer !== 'https://partiful.com/') {
      return {
        statusCode: 403,
        data: { error: { code: 403, message: 'Requests from referer <empty> are blocked.', status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } },
      };
    }
    if (call.key !== API_KEY) return { statusCode: 400, data: { error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } } };
    if (form.get('grant_type') !== 'refresh_token' || !call.refreshToken || !this.validRefresh.has(call.refreshToken)) {
      return { statusCode: 400, data: { error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' } } };
    }
    const idToken = `synthetic-id-token-${String(++this.tokenSeq).padStart(4, '0')}`;
    this.liveTokens.add(idToken);
    const refresh = this.rotateTo ?? call.refreshToken;
    this.validRefresh.add(refresh);
    return { statusCode: 200, data: { id_token: idToken, refresh_token: refresh, expires_in: '3600', token_type: 'Bearer', user_id: ME } };
  }

  private eventJson(e: FakeEvent | Omit<FakeEvent, 'guests' | 'list'>): Record<string, unknown> {
    const counts = 'guests' in e ? this.counts(e) : (e.guestStatusCounts ?? {});
    return {
      id: e.id,
      title: e.title,
      status: e.status ?? 'PUBLISHED',
      startDate: e.startDate ?? 'TBD',
      timezone: 'America/New_York',
      ownerIds: e.ownerIds,
      showGuestList: e.showGuestList ?? true,
      showHostList: true,
      showGuestCount: true,
      guestStatusCounts: e.guestStatusCounts ?? counts,
      ...(e.locationDisplayText ? { locationDisplayText: e.locationDisplayText } : {}),
      ...(e.guest ? { guest: e.guest } : {}),
      image: { url: 'https://example.com/cover.png' },
    };
  }

  private counts(e: FakeEvent): Record<string, number> {
    const out: Record<string, number> = {};
    for (const g of e.guests) out[g.status] = (out[g.status] ?? 0) + 1;
    return out;
  }

  private ok(data: object, paging?: Record<string, unknown>): Reply {
    return { statusCode: 200, data: { result: { data, ...(paging ? { paging } : {}) } } };
  }

  private route(path: string, headers: unknown, rawBody: unknown): Reply {
    const fn = path.replace(/^\//, '').split('?')[0]!;
    let body: { data?: { params?: Record<string, unknown>; paging?: Record<string, unknown>; userId?: unknown } } = {};
    try {
      body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}');
    } catch {
      return { statusCode: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'bad json' } } };
    }
    const params = body.data?.params ?? {};
    this.calls.push({
      fn,
      params,
      paging: body.data?.paging,
      userId: body.data?.userId,
      headers: {
        authorization: header(headers, 'authorization'),
        origin: header(headers, 'origin'),
        referer: header(headers, 'referer'),
        'user-agent': header(headers, 'user-agent'),
        'content-type': header(headers, 'content-type'),
      },
    });
    const auth = header(headers, 'authorization') ?? '';
    if (this.unauthorized > 0) {
      this.unauthorized--;
      return { statusCode: 401, data: { error: { status: 'UNAUTHENTICATED', message: 'Unauthenticated' } } };
    }
    if (!auth.startsWith('Bearer ') || !this.liveTokens.has(auth.slice(7))) {
      return { statusCode: 401, data: { error: { status: 'UNAUTHENTICATED', message: 'Unauthenticated' } } };
    }
    if (body.data?.userId !== ME) return { statusCode: 403, data: { error: { status: 'PERMISSION_DENIED', message: 'wrong user' } } };
    const o = this.override.get(fn)?.(params);
    if (o) return o;
    switch (fn) {
      case 'getMyUpcomingEventsForHomePage':
        return this.ok({ upcomingEvents: this.events.filter((e) => e.list === 'upcoming').map((e) => this.eventJson(e)) });
      case 'getMyPastEventsForHomePage':
        return this.ok({ pastEvents: this.events.filter((e) => e.list === 'past').map((e) => this.eventJson(e)) });
      case 'getMyRsvps': {
        // Wrapper shape {event, guest}: exercises unwrapping.
        const items = this.events.filter((e) => e.guest).map((e) => ({ event: { ...this.eventJson(e), guest: undefined }, guest: e.guest }));
        return this.ok({ rsvps: items });
      }
      case 'getPublishedEvents':
        // A bare array, as the research notes for this function.
        return { statusCode: 200, data: this.events.filter((e) => e.ownerIds.includes(ME)).map((e) => this.eventJson(e)) };
      case 'getEventInfo': {
        const id = String(params.eventId);
        const e = this.events.find((x) => x.id === id) ?? this.eventInfo.get(id);
        if (!e) return { statusCode: 404, data: { error: { status: 'NOT_FOUND', message: 'Event not found' } } };
        return this.ok({ event: this.eventJson(e) });
      }
      case 'getGuests': {
        const e = this.events.find((x) => x.id === params.eventId);
        if (!e) return { statusCode: 404, data: { error: { status: 'NOT_FOUND', message: 'Event not found' } } };
        if (e.showGuestList === false && !e.ownerIds.includes(ME)) return { statusCode: 403, data: { error: { status: 'PERMISSION_DENIED', message: 'hidden' } } };
        const start = Number(body.data?.paging?.cursor ?? 0);
        const size = Math.min(Number(body.data?.paging?.maxResults ?? 500), this.guestPageSize);
        const page = e.guests.slice(start, start + size);
        const next = start + size < e.guests.length ? String(start + size) : null;
        // Live (2026-10-16): getGuests answers a bare array.
        return this.ok(page, { nextCursor: next });
      }
      case 'getUsers': {
        // Live (2026-10-16): a bare array, and [] unless party stats are requested.
        const ids = Array.isArray(params.ids) && params.includePartyStats === true ? (params.ids as string[]) : [];
        return this.ok(ids.map((id) => this.users.get(id)).filter((u): u is FakeUser => !!u).slice(0, this.usersPerCall));
      }
      case 'getContacts':
        return this.ok({ contacts: this.contacts });
      case 'getMutuals':
        return this.ok(this.mutuals);
      default:
        return { statusCode: 404, data: '<html>Not Found</html>' };
    }
  }
}

// ------------------------------------------------------------------------------------------- fake browser (CDP)

type Rows = { fbase_key: string; value: unknown }[];

/** Minimal async IndexedDB: databases → object stores → rows. Records any database it would create. */
export function fakeIndexedDB(dbs: Record<string, Record<string, Rows>>) {
  const created: string[] = [];
  let closed = 0;
  const later = (fn: () => void) => setTimeout(fn, 0);
  const api = {
    created,
    get closed() {
      return closed;
    },
    databases: async () => Object.keys(dbs).map((name) => ({ name, version: 1 })),
    open(name: string) {
      const req: Record<string, unknown> & {
        onsuccess?: () => void;
        onerror?: () => void;
        onupgradeneeded?: () => void;
        aborted?: boolean;
      } = {};
      later(() => {
        if (!dbs[name]) {
          req.transaction = {
            abort() {
              req.aborted = true;
            },
          };
          req.onupgradeneeded?.();
          if (req.aborted) {
            req.onerror?.();
            return;
          }
          created.push(name);
          dbs[name] = {};
        }
        const stores = dbs[name]!;
        req.result = {
          objectStoreNames: { contains: (s: string) => s in stores },
          transaction: (store: string) => ({
            objectStore: () => ({
              getAll() {
                const r: { result?: unknown; onsuccess?: () => void } = {};
                later(() => {
                  r.result = stores[store] ?? [];
                  r.onsuccess?.();
                });
                return r;
              },
            }),
          }),
          close() {
            closed++;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  return api;
}

/** The partiful.com Firebase IndexedDB with one signed-in user (synthetic). */
export function signedInStores(s: { uid: string; apiKey: string; refreshToken: string } = SESSION): Record<string, Record<string, Rows>> {
  return {
    firebaseLocalStorageDb: {
      firebaseLocalStorage: [
        { fbase_key: 'firebase:host:partiful.com', value: 'unrelated' },
        {
          fbase_key: `firebase:authUser:${s.apiKey}:[DEFAULT]`,
          value: {
            uid: s.uid,
            apiKey: s.apiKey,
            displayName: 'Synthetic Owner',
            stsTokenManager: { refreshToken: s.refreshToken, accessToken: 'synthetic-access-token-0001', expirationTime: T0 + 3_600_000 },
          },
        },
      ],
    },
  };
}

export class FakePage implements CdpPage {
  closed = false;
  readonly evaluated: string[] = [];
  constructor(
    private href: string,
    private readonly idb: ReturnType<typeof fakeIndexedDB> | null,
    /** The page's localStorage (Firebase browserLocalPersistence). */
    private readonly storage: Record<string, string> | null = null,
  ) {}
  url() {
    return this.href;
  }
  async goto(url: string) {
    this.href = url;
    return null;
  }
  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    // Runs the real page script in a fresh context that only has the fake IndexedDB (no Node globals).
    const store = this.storage;
    const localStorage = store
      ? { get length() { return Object.keys(store).length; }, key: (i: number) => Object.keys(store)[i] ?? null, getItem: (k: string) => store[k] ?? null }
      : undefined;
    return vm.runInNewContext(expression, { indexedDB: this.idb ?? undefined, localStorage });
  }
  async close() {
    this.closed = true;
  }
}

export class FakeBrowser implements CdpBrowser {
  disconnected = 0;
  readonly opened: FakePage[] = [];
  readonly context: CdpContext;
  constructor(
    readonly pages: FakePage[],
    /** IndexedDB a newly opened partiful.com tab sees. */
    idbForNewTabs: ReturnType<typeof fakeIndexedDB> | null,
  ) {
    const self = this;
    this.context = {
      pages: () => self.pages.filter((p) => !p.closed),
      async newPage() {
        const p = new FakePage('about:blank', idbForNewTabs);
        self.opened.push(p);
        self.pages.push(p);
        return p;
      },
    };
  }
  contexts() {
    return [this.context];
  }
  async close() {
    this.disconnected++;
  }
}

/** A connector that hands out `browser` (or fails like an unreachable CDP port). */
export function fakeConnect(browser: FakeBrowser | null): CdpConnect & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (endpoint: string) => {
    calls.push(endpoint);
    if (!browser) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    return browser;
  }) as unknown as CdpConnect & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// ------------------------------------------------------------------------------------------- a synthetic world

export const HOST = 'uid-host-0001';
export const ROBIN = 'uid-robin-0001';
export const SAM = 'uid-sam-0001';
export const JORDAN = 'uid-jordan-0001';
export const CASEY = 'uid-casey-0001';
export const DREW = 'uid-drew-0001';
export const LEE = 'uid-lee-0001';

/**
 * evtPast0001   a past party hosted by Avery: me GOING (invited by Avery); Robin GOING (invited by Avery), Sam
 *               MAYBE, Jordan DECLINED, Casey GOING as Robin's plus-one, an SMS invitee who isn't on Partiful
 * evtHosted001  my own party in 3 days: Robin GOING, Drew SENT, Lee MAYBE
 * evtHidden001  a past party whose host hid the guest list
 * evtCancel001  a canceled party
 */
export function seedWorld(f: FakePartiful): void {
  f.events.push(
    {
      id: 'evtPast0001',
      title: 'Synthetic Rooftop Party',
      startDate: iso(T0 - 30 * DAY),
      list: 'past',
      ownerIds: [HOST],
      guest: { id: 'g-me', status: 'GOING', invitedBy: HOST },
      locationDisplayText: 'Example Rooftop',
      guests: [
        { id: 'g-host', userId: HOST, name: 'Avery Example', status: 'GOING' },
        { id: 'g-me', userId: ME, name: 'Synthetic Owner', status: 'GOING', invitedBy: HOST },
        { id: 'g-robin', userId: ROBIN, name: 'Robin Example', status: 'GOING', invitedBy: HOST, rsvpDate: iso(T0 - 35 * DAY) },
        { id: 'g-sam', userId: SAM, name: 'Sam Sample', status: 'MAYBE', invitedBy: 'g-robin' },
        { id: 'g-jordan', userId: JORDAN, name: 'Jordan Demo', status: 'DECLINED' },
        { id: 'g-casey', userId: CASEY, name: 'Casey Plusone', status: 'GOING', anchorGuestId: 'g-robin' },
        { id: 'g-sms', name: 'Text Invitee', status: 'SENT' },
      ],
    },
    {
      id: 'evtHosted001',
      title: 'Synthetic Dinner At Mine',
      startDate: iso(T0 + 3 * DAY),
      list: 'upcoming',
      ownerIds: [ME],
      guest: { id: 'h-me', status: 'GOING' },
      guests: [
        { id: 'h-robin', userId: ROBIN, name: 'Robin Example', status: 'GOING' },
        { id: 'h-drew', userId: DREW, name: 'Drew Invitee', status: 'SENT' },
        { id: 'h-lee', userId: LEE, name: 'Lee Maybe', status: 'MAYBE' },
      ],
    },
    {
      id: 'evtHidden001',
      title: 'Synthetic Secret Party',
      startDate: iso(T0 - 60 * DAY),
      list: 'past',
      ownerIds: ['uid-other-0001'],
      showGuestList: false,
      guest: { status: 'GOING' },
      guests: [{ id: 'x-1', userId: 'uid-hidden-0001', name: 'Hidden Guest', status: 'GOING' }],
    },
    {
      id: 'evtCancel001',
      title: 'Synthetic Canceled Picnic',
      startDate: iso(T0 - 90 * DAY),
      list: 'past',
      ownerIds: [HOST],
      status: 'CANCELED',
      guest: { status: 'GOING' },
      guests: [{ id: 'c-1', userId: ROBIN, name: 'Robin Example', status: 'GOING' }],
    },
  );
  for (const u of [
    { id: HOST, name: 'Avery Example' },
    { id: ROBIN, name: 'Robin Example', socials: { instagram: { value: '@robin.example' } } },
    { id: SAM, name: 'Sam Sample', socials: { instagram: 'sam.sample.ig' } },
    { id: JORDAN, name: 'Jordan Demo', socials: { instagram: { value: 'taken.handle' } } },
    { id: CASEY, name: 'Casey Plusone' },
    { id: DREW, name: 'Drew Invitee' },
    { id: LEE, name: 'Lee Maybe' },
  ]) {
    f.users.set(u.id, u);
  }
}
