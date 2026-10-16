import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReadFunction,
  PARTIFUL_READ_FUNCTIONS,
  PartifulClient,
  RateGate,
  unwrapEnvelope,
  type PartifulReadFunction,
} from '../../../src/adapters/partiful/client';
import {
  PartifulAuthRequiredError,
  PartifulBudgetError,
  PartifulCallError,
  PartifulContractError,
  PartifulForbiddenFunctionError,
  PartifulHttpError,
  PartifulRateLimitedError,
} from '../../../src/adapters/partiful/errors';
import { PartifulAuth, storeSession } from '../../../src/adapters/partiful/session';
import { memDb } from '../../helpers';
import { FakePartiful, ME, seedWorld, SESSION, T0 } from './fakePartiful';

const fakes: FakePartiful[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(o: { maxCalls?: number } = {}) {
  const f = new FakePartiful();
  fakes.push(f);
  seedWorld(f);
  const db = memDb();
  const k = crypto.randomBytes(32);
  storeSession(db, k, SESSION, T0);
  const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: null, dispatcher: f.agent });
  const client = new PartifulClient({ auth, dispatcher: f.agent, gate: new RateGate(0), maxCalls: o.maxCalls });
  return { f, db, auth, client };
}

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

describe('read-only allowlist', () => {
  it('is exactly the nine read functions of the plan', () => {
    expect([...PARTIFUL_READ_FUNCTIONS].sort()).toEqual(
      [
        'getContacts',
        'getEventInfo',
        'getGuests',
        'getMutuals',
        'getMyPastEventsForHomePage',
        'getMyRsvps',
        'getMyUpcomingEventsForHomePage',
        'getPublishedEvents',
        'getUsers',
      ].sort(),
    );
    expect(Object.isFrozen(PARTIFUL_READ_FUNCTIONS)).toBe(true);
    for (const fn of PARTIFUL_READ_FUNCTIONS) expect(() => assertReadFunction(fn)).not.toThrow();
  });

  it('any other function name throws before anything is sent (no token minted, no request)', async () => {
    const { f, client } = setup();
    for (const fn of ['createEvent', 'updateGuestStatus', 'sendAuthCode', 'getLoginToken', 'sendTextBlast', 'getGuestsCsv', 'getMutualGuests', 'getguests', 'getGuests ', '']) {
      const err = await thrown(client.call(fn as PartifulReadFunction, {}));
      expect(err, fn).toBeInstanceOf(PartifulForbiddenFunctionError);
    }
    // pages() goes through call(): same guard.
    await expect(client.pages('deleteEvent' as PartifulReadFunction, {}).next()).rejects.toBeInstanceOf(PartifulForbiddenFunctionError);
    expect(f.calls).toEqual([]);
    expect(f.tokenCalls).toEqual([]);
    expect(client.callCount).toBe(0);
  });
});

describe('PartifulClient', () => {
  it('POSTs {data:{params, paging, userId}} with a Bearer ID token and browser-like headers', async () => {
    const { f, client } = setup();
    const r = await client.call('getGuests', { eventId: 'evtPast0001', includeInvitedGuests: true }, { maxResults: 500 });
    expect(Array.isArray(r.data)).toBe(true);
    const c = f.calls[0]!;
    expect(c.fn).toBe('getGuests');
    expect(c.params).toEqual({ eventId: 'evtPast0001', includeInvitedGuests: true });
    expect(c.paging).toEqual({ maxResults: 500 });
    expect(c.userId).toBe(ME);
    expect(c.headers.authorization).toMatch(/^Bearer synthetic-id-token-/);
    expect(c.headers.origin).toBe('https://partiful.com');
    expect(c.headers.referer).toBe('https://partiful.com/');
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.headers['user-agent']).toMatch(/Mozilla\/5\.0 .*Chrome\//);
  });

  it('follows cursors page by page', async () => {
    const { f, client } = setup();
    f.guestPageSize = 2;
    const pages = [];
    for await (const p of client.pages('getGuests', { eventId: 'evtPast0001' }, { maxResults: 500 })) pages.push(p);
    expect(pages.map((p) => (p.data as unknown[]).length)).toEqual([2, 2, 2, 1]);
    expect(f.fnCalls('getGuests').map((c) => c.paging?.cursor ?? null)).toEqual([null, '2', '4', '6']);
  });

  it('unwraps {result:{data}}, {result}, bare arrays; finds cursors in result.paging or data.paging', () => {
    expect(unwrapEnvelope('getMyRsvps', { result: { data: { rsvps: [] } } })).toEqual({ data: { rsvps: [] }, nextCursor: null });
    expect(unwrapEnvelope('getPublishedEvents', [{ id: 'a' }])).toEqual({ data: [{ id: 'a' }], nextCursor: null });
    expect(unwrapEnvelope('getUsers', { result: [{ id: 'a' }] }).data).toEqual([{ id: 'a' }]);
    expect(unwrapEnvelope('getGuests', { result: { data: { guests: [] }, paging: { nextCursor: 'c1' } } }).nextCursor).toBe('c1');
    expect(unwrapEnvelope('getGuests', { result: { data: { guests: [], paging: { nextCursor: 'c2' } } } }).nextCursor).toBe('c2');
    expect(() => unwrapEnvelope('getGuests', { data: [] })).toThrow(PartifulContractError);
    expect(() => unwrapEnvelope('getGuests', null)).toThrow(PartifulContractError);
  });

  it('re-mints the ID token once on a 401; a persistent 401 is auth_required', async () => {
    const { f, client } = setup();
    f.unauthorized = 1;
    await client.call('getMyRsvps');
    expect(f.tokenCalls).toHaveLength(2);
    f.unauthorized = 2;
    const err = await thrown(client.call('getMyRsvps'));
    expect(err).toBeInstanceOf(PartifulAuthRequiredError);
    expect((err as PartifulAuthRequiredError).reason).toBe('api_unauthorized');
  });

  it('maps failures: callable errors, a missing function, 429 and 5xx', async () => {
    const { f, client } = setup();
    const nf = await thrown(client.call('getEventInfo', { eventId: 'evtNope' }));
    expect(nf).toBeInstanceOf(PartifulCallError);
    expect((nf as PartifulCallError).code).toBe('NOT_FOUND');
    f.override.set('getMyRsvps', () => ({ statusCode: 404, data: '<html>gone</html>' }));
    expect(await thrown(client.call('getMyRsvps'))).toBeInstanceOf(PartifulContractError);
    f.override.set('getMyRsvps', () => ({ statusCode: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } }));
    expect(await thrown(client.call('getMyRsvps'))).toBeInstanceOf(PartifulRateLimitedError);
    f.override.set('getMyRsvps', () => ({ statusCode: 503, data: '' }));
    const http = await thrown(client.call('getMyRsvps'));
    expect(http).toBeInstanceOf(PartifulHttpError);
    expect(http.message).toBe('Partiful getMyRsvps failed (HTTP 503)');
    f.override.set('getMyRsvps', () => ({ statusCode: 200, data: { error: { status: 'INTERNAL', message: 'boom' } } }));
    expect(((await thrown(client.call('getMyRsvps'))) as PartifulCallError).code).toBe('INTERNAL');
  });

  it('stops at the per-run call budget without sending', async () => {
    const { f, client } = setup({ maxCalls: 2 });
    await client.call('getMyRsvps');
    await client.call('getMyRsvps');
    expect(await thrown(client.call('getMyRsvps'))).toBeInstanceOf(PartifulBudgetError);
    expect(f.calls).toHaveLength(2);
    expect(client.remaining).toBe(0);
  });
});

describe('RateGate', () => {
  it('spaces request starts ≥ minIntervalMs apart', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const gate = new RateGate(1000, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await gate.wait();
    await gate.wait();
    now += 300;
    await gate.wait();
    now += 5_000;
    await gate.wait();
    expect(sleeps).toEqual([1000, 700]);
  });
});
