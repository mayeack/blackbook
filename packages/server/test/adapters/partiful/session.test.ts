import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PartifulAuthRequiredError, PartifulContractError, SIGN_IN_MESSAGE } from '../../../src/adapters/partiful/errors';
import {
  extractBrowserSession,
  loadStoredSession,
  PartifulAuth,
  READ_AUTH_USER_JS,
  SESSION_SECRET,
  storeSession,
  type CdpConnect,
} from '../../../src/adapters/partiful/session';
import { getSecret } from '../../../src/security/secrets';
import { memDb } from '../../helpers';
import { API_KEY, FakeBrowser, fakeConnect, fakeIndexedDB, FakePage, FakePartiful, ME, REFRESH, SESSION, signedInStores, T0 } from './fakePartiful';

/** A placeholder endpoint (never the real sandbox browser's port): every test injects `connect`. */
const CDP = 'http://127.0.0.1:9';
const key = () => crypto.randomBytes(32);

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

const fakes: FakePartiful[] = [];
const fake = () => {
  const f = new FakePartiful();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

describe('extractBrowserSession (fake CDP browser, real page script)', () => {
  it('reads the Firebase user from an open partiful.com tab, then only disconnects', async () => {
    const idb = fakeIndexedDB(signedInStores());
    const userTab = new FakePage('https://example.com/news', null);
    const partifulTab = new FakePage('https://partiful.com/events', idb);
    const browser = new FakeBrowser([userTab, partifulTab], null);
    const connect = fakeConnect(browser);
    const s = await extractBrowserSession({ cdpUrl: CDP, connect });
    expect(s).toEqual(SESSION);
    expect(connect.calls).toEqual([CDP]);
    expect(partifulTab.evaluated).toEqual([READ_AUTH_USER_JS]);
    expect(browser.opened).toHaveLength(0);
    // The user's tabs stay open; the CDP connection is dropped exactly once.
    expect(userTab.closed || partifulTab.closed).toBe(false);
    expect(browser.disconnected).toBe(1);
    expect(idb.closed).toBe(1);
  });

  it('opens a partiful.com tab when none is open, and closes only that tab', async () => {
    const idb = fakeIndexedDB(signedInStores());
    const userTab = new FakePage('https://example.com/', null);
    const browser = new FakeBrowser([userTab], idb);
    const s = await extractBrowserSession({ cdpUrl: CDP, connect: fakeConnect(browser) });
    expect(s.uid).toBe(ME);
    expect(browser.opened).toHaveLength(1);
    expect(browser.opened[0]!.url()).toBe('https://partiful.com/');
    expect(browser.opened[0]!.closed).toBe(true);
    expect(userTab.closed).toBe(false);
    expect(browser.disconnected).toBe(1);
  });

  it('a signed-out browser is auth_required, and the reader never creates the database', async () => {
    const empty = fakeIndexedDB({});
    const browser = new FakeBrowser([new FakePage('https://partiful.com/', empty)], null);
    const err = await thrown(extractBrowserSession({ cdpUrl: CDP, connect: fakeConnect(browser) }));
    expect(err).toBeInstanceOf(PartifulAuthRequiredError);
    expect((err as PartifulAuthRequiredError).reason).toBe('not_signed_in');
    expect(err.message).toContain(SIGN_IN_MESSAGE);
    expect(empty.created).toEqual([]);
    expect(browser.disconnected).toBe(1);

    // A store without an authUser record (signed out after a visit) reads as not signed in too.
    const noUser = fakeIndexedDB({ firebaseLocalStorageDb: { firebaseLocalStorage: [{ fbase_key: 'firebase:host:partiful.com', value: 'x' }] } });
    const b2 = new FakeBrowser([new FakePage('https://partiful.com/', noUser)], null);
    expect(((await thrown(extractBrowserSession({ cdpUrl: CDP, connect: fakeConnect(b2) }))) as PartifulAuthRequiredError).reason).toBe('not_signed_in');
  });

  it('the reader script also works without indexedDB.databases() and refuses an upgrade', async () => {
    const idb = fakeIndexedDB({});
    const noList = { open: idb.open.bind(idb) };
    const page = new FakePage('https://partiful.com/', noList as unknown as ReturnType<typeof fakeIndexedDB>);
    expect(await page.evaluate(READ_AUTH_USER_JS)).toEqual({ error: 'no_db' });
    expect(idb.created).toEqual([]);
  });

  it('falls back to localStorage persistence when IndexedDB has no user', async () => {
    const storage = {
      unrelated: 'x',
      [`firebase:authUser:${API_KEY}:[DEFAULT]`]: JSON.stringify({ uid: ME, stsTokenManager: { refreshToken: REFRESH } }),
    };
    const browser = new FakeBrowser([new FakePage('https://partiful.com/home', fakeIndexedDB({}), storage)], null);
    expect(await extractBrowserSession({ cdpUrl: CDP, connect: fakeConnect(browser) })).toEqual(SESSION);
  });

  it('an unreachable CDP port is auth_required (browser_unreachable)', async () => {
    const err = await thrown(extractBrowserSession({ cdpUrl: CDP, connect: fakeConnect(null) }));
    expect((err as PartifulAuthRequiredError).reason).toBe('browser_unreachable');
    expect(err.message).not.toContain('ECONNREFUSED');
  });
});

describe('stored session', () => {
  it('is AES-GCM encrypted in the secrets table; the plaintext never appears in the row', () => {
    const db = memDb();
    const k = key();
    storeSession(db, k, SESSION, T0);
    const row = db.prepare('SELECT ciphertext, iv, tag FROM secrets WHERE name = ?').get(SESSION_SECRET) as Record<string, Buffer>;
    for (const v of Object.values(row)) expect(v.toString('latin1')).not.toContain(REFRESH);
    expect(JSON.parse(getSecret(db, k, SESSION_SECRET)!)).toEqual(SESSION);
    expect(loadStoredSession(db, k)).toEqual(SESSION);
    expect(loadStoredSession(db, key())).toBeNull(); // wrong key: unreadable, not a crash
    expect(loadStoredSession(db, null)).toBeNull();
    expect(storeSession(db, null, SESSION)).toBe(false);
  });
});

describe('PartifulAuth', () => {
  it('first use: session from the browser, stored, then ID tokens from securetoken with the partiful.com Referer', async () => {
    const f = fake();
    const db = memDb();
    const k = key();
    const browser = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores()))], null);
    let now = T0;
    const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: CDP, connect: fakeConnect(browser), dispatcher: f.agent, clock: () => now });
    expect(await auth.userId()).toBe(ME);
    const t1 = await auth.idToken();
    expect(f.tokenCalls).toEqual([{ key: API_KEY, refreshToken: REFRESH, referer: 'https://partiful.com/' }]);
    expect(loadStoredSession(db, k)).toEqual(SESSION);
    // Cached for its hour (minus a minute), then refreshed; `force` always refreshes.
    now += 30 * 60_000;
    expect(await auth.idToken()).toBe(t1);
    now += 30 * 60_000;
    const t2 = await auth.idToken();
    expect(t2).not.toBe(t1);
    expect(await auth.idToken({ force: true })).not.toBe(t2);
    expect(f.tokenCalls).toHaveLength(3);
    expect(auth.stats.browser_reads).toBe(1);
  });

  it('a stored session needs no browser; a rotated refresh token is stored', async () => {
    const f = fake();
    const db = memDb();
    const k = key();
    storeSession(db, k, SESSION, T0);
    f.rotateTo = 'synthetic-refresh-token-0002';
    const connect = fakeConnect(null);
    const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: CDP, connect, dispatcher: f.agent });
    await auth.idToken();
    expect(connect.calls).toEqual([]);
    expect(loadStoredSession(db, k)?.refreshToken).toBe('synthetic-refresh-token-0002');
  });

  it('a refused stored token falls back to the browser once; the same token again is auth_required', async () => {
    const f = fake();
    const db = memDb();
    const k = key();
    storeSession(db, k, { ...SESSION, refreshToken: 'synthetic-refresh-token-dead' }, T0);
    // The browser holds a newer session (the owner signed in again).
    const browser = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores()))], null);
    const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: CDP, connect: fakeConnect(browser), dispatcher: f.agent });
    await auth.idToken();
    expect(f.tokenCalls.map((c) => c.refreshToken)).toEqual(['synthetic-refresh-token-dead', REFRESH]);
    expect(loadStoredSession(db, k)?.refreshToken).toBe(REFRESH);

    // Signed out on Partiful's side: the browser still has the dead token.
    const db2 = memDb();
    const dead = { ...SESSION, refreshToken: 'synthetic-refresh-token-dead' };
    storeSession(db2, k, dead, T0);
    const b2 = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores(dead)))], null);
    const auth2 = new PartifulAuth({ db: db2, secretsKey: k, cdpUrl: CDP, connect: fakeConnect(b2), dispatcher: f.agent });
    const err = await thrown(auth2.idToken());
    expect(err).toBeInstanceOf(PartifulAuthRequiredError);
    expect((err as PartifulAuthRequiredError).reason).toBe('refresh_rejected');
    expect(err.message).not.toContain('synthetic-refresh-token');
  });

  it('after a refusal the browser is read again on the next run: signing in again recovers without a restart', async () => {
    const f = fake();
    const db = memDb();
    const k = key();
    const dead = { ...SESSION, refreshToken: 'synthetic-refresh-token-dead' };
    storeSession(db, k, dead, T0);
    const signedOut = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores(dead)))], null);
    const signedIn = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores()))], null);
    const browsers = [signedOut, signedOut, signedIn];
    let connects = 0;
    const connect: CdpConnect = async () => browsers[Math.min(connects++, browsers.length - 1)]!;
    const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: CDP, connect, dispatcher: f.agent });

    expect(((await thrown(auth.idToken())) as PartifulAuthRequiredError).reason).toBe('refresh_rejected');
    // The next scheduler retry: still signed out. The dead token is not sent to securetoken again.
    expect(((await thrown(auth.idToken())) as PartifulAuthRequiredError).reason).toBe('refresh_rejected');
    expect(f.tokenCalls.map((c) => c.refreshToken)).toEqual(['synthetic-refresh-token-dead']);
    // The owner signs in again in the sandbox browser: the same process picks it up.
    expect(await auth.idToken()).toEqual(expect.any(String));
    expect(f.tokenCalls.map((c) => c.refreshToken)).toEqual(['synthetic-refresh-token-dead', REFRESH]);
    expect(connects).toBe(3);
    expect(auth.stats.browser_reads).toBe(3);
    expect(loadStoredSession(db, k)?.refreshToken).toBe(REFRESH);
  });

  it('nothing stored and no browser → auth_required; without SECRETS_KEY the session lives in memory only', async () => {
    const f = fake();
    const db = memDb();
    const none = new PartifulAuth({ db, secretsKey: key(), cdpUrl: CDP, connect: fakeConnect(null), dispatcher: f.agent });
    expect(((await thrown(none.idToken())) as PartifulAuthRequiredError).reason).toBe('browser_unreachable');

    const browser = new FakeBrowser([new FakePage('https://partiful.com/', fakeIndexedDB(signedInStores()))], null);
    const mem = new PartifulAuth({ db, secretsKey: null, cdpUrl: CDP, connect: fakeConnect(browser), dispatcher: f.agent });
    await mem.idToken();
    expect(db.prepare('SELECT count(*) FROM secrets').pluck().get()).toBe(0);
  });

  it('a referer/API-key refusal is a contract break, not an auth problem', async () => {
    const f = fake();
    const db = memDb();
    const k = key();
    storeSession(db, k, { ...SESSION, apiKey: 'synthetic-api-key-wrong' }, T0);
    const auth = new PartifulAuth({ db, secretsKey: k, cdpUrl: null, dispatcher: f.agent });
    const err = await thrown(auth.idToken());
    expect(err).toBeInstanceOf(PartifulContractError);
    expect(err.message).not.toContain('synthetic-api-key');
  });
});
