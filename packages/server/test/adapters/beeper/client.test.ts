import { afterEach, describe, expect, it } from 'vitest';
import { Agent, MockAgent, request } from 'undici';
import {
  BeeperClient,
  BeeperContractError,
  BeeperHttpError,
  BeeperReadOnlyError,
  BeeperUnavailableError,
  isAllowedBeeperPath,
  readOnlyDispatcher,
} from '../../../src/adapters/beeper/client';
import { instagramIdOf, isInstagramAccount, messageKind } from '../../../src/adapters/beeper/mapping';
import { FakeBeeper, IG_ACCOUNT, ORIGIN, ROBIN, SELF_PARTICIPANT, T0 } from './fakeBeeper';

const fakes: FakeBeeper[] = [];
const fake = () => {
  const f = new FakeBeeper();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

describe('Beeper client: read-only', () => {
  it('the dispatcher refuses every non-GET to Beeper before anything is sent', async () => {
    const f = fake();
    const guarded = readOnlyDispatcher(f.agent, ORIGIN);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const e = await thrown(request(`${ORIGIN}/v1/chats/abc/messages`, { method, dispatcher: guarded, body: '{}' }));
      expect(e).toBeInstanceOf(BeeperReadOnlyError);
    }
    // Send-ish routes are refused even as GET (not on the allowlist), and so is any other host.
    for (const p of ['/v1/chats/start', '/v1/chats/abc/read', '/v1/assets/download', '/v1/chats/abc/messages/1/reactions', '/v1/messages/search']) {
      expect(await thrown(request(`${ORIGIN}${p}`, { method: 'GET', dispatcher: guarded }))).toBeInstanceOf(BeeperReadOnlyError);
    }
    expect(await thrown(request('http://127.0.0.1:7/v1/health', { method: 'GET', dispatcher: guarded }))).toBeInstanceOf(BeeperReadOnlyError);
    // Nothing reached the (fake) server.
    expect(f.requests).toEqual([]);
  });

  it('a real Agent is guarded the same way (no socket is opened for a refused write)', async () => {
    // A real undici Agent whose connector counts and fails closed: whatever the guard does, nothing leaves the process.
    let opened = 0;
    const agent = new Agent({
      connect: (_o, cb) => {
        opened++;
        cb(Object.assign(new Error('socket opened'), { code: 'ECONNREFUSED' }), null);
      },
    });
    try {
      const guarded = readOnlyDispatcher(agent, ORIGIN);
      const e = await thrown(request(`${ORIGIN}/v1/chats/x/messages`, { method: 'POST', dispatcher: guarded, body: '{"text":"x"}' }));
      expect(e).toBeInstanceOf(BeeperReadOnlyError);
      expect(opened).toBe(0);
      // Control: an allowed read does reach the connector, so the zero above is meaningful.
      expect(await thrown(request(`${ORIGIN}/v1/accounts`, { method: 'GET', dispatcher: guarded }))).not.toBeInstanceOf(BeeperReadOnlyError);
      expect(opened).toBe(1);
    } finally {
      await agent.close();
    }
  });

  it('allowlist: only the read routes the adapter uses', () => {
    expect(isAllowedBeeperPath('/v1/accounts')).toBe(true);
    expect(isAllowedBeeperPath('/v1/chats?accountIDs=a&limit=5')).toBe(true);
    expect(isAllowedBeeperPath(`/v1/chats/${encodeURIComponent('!abc:beeper.local')}`)).toBe(true);
    expect(isAllowedBeeperPath(`/v1/chats/${encodeURIComponent('!abc:beeper.local')}/messages?cursor=1&direction=before`)).toBe(true);
    expect(isAllowedBeeperPath('/v1/accounts/x/contacts/list')).toBe(true);
    expect(isAllowedBeeperPath('/v1/accounts/x/contacts')).toBe(false); // network search
    expect(isAllowedBeeperPath('/v1/chats/search')).toBe(false);
    expect(isAllowedBeeperPath('/v1/chats/abc/archive')).toBe(false);
    expect(isAllowedBeeperPath('/v1/chats/abc/reminders')).toBe(false);
    expect(isAllowedBeeperPath('/v1/bridges/x/logins/y/remove')).toBe(false);
  });

  it('exposes no write methods', () => {
    const methods = Object.getOwnPropertyNames(BeeperClient.prototype);
    expect(methods.filter((m) => /send|post|put|patch|delete|update|archive|react|mark|create|start|upload/i.test(m))).toEqual([]);
  });
});

describe('Beeper client: requests and validation', () => {
  it('sends the Bearer token, repeats accountIDs, and drops (and counts) odd items', async () => {
    const f = fake();
    f.addChat('!dm1:beeper.local', { participants: [ROBIN, SELF_PARTICIPANT] });
    f.add('!dm1:beeper.local', { from: ROBIN, at: T0, text: 'hello there' });
    f.add('!dm1:beeper.local', { from: ROBIN, at: T0 + 1, text: 'and again' });
    const c = f.client();
    const accounts = await c.accounts();
    expect(accounts.items.map((a) => a.accountID)).toContain(IG_ACCOUNT);
    const chats = await c.chats({ accountIDs: [IG_ACCOUNT, 'second'], limit: 500 });
    expect(chats.items).toHaveLength(1);
    expect(f.requests.at(-1)!.path).toBe(`/v1/chats?accountIDs=${encodeURIComponent(IG_ACCOUNT)}&accountIDs=second&limit=200`);
    // One malformed message among valid ones is dropped, not fatal.
    f.chats.get('!dm1:beeper.local')!.messages.push({ id: 'bad', chatID: '!dm1:beeper.local', timestamp: 'not a date', senderID: 'x' });
    const page = await c.messages('!dm1:beeper.local');
    expect(page.items).toHaveLength(2);
    expect(page.invalid).toBe(1);
    expect(c.requests).toBe(3);
  });

  it('maps failures to typed errors without bodies or tokens', async () => {
    const f = fake();
    const bad = await thrown(f.client({ token: 'wrong' }).accounts());
    expect(bad).toBeInstanceOf(BeeperHttpError);
    expect((bad as BeeperHttpError).status).toBe(401);
    expect(bad.message).not.toContain('wrong');

    f.chats.clear();
    f.addChat('!x:beeper.local', { participants: [] });
    f.chats.get('!x:beeper.local')!.messages.push({ nope: true }, { nope: 1 });
    expect(await thrown(f.client().messages('!x:beeper.local'))).toBeInstanceOf(BeeperContractError);

    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get(ORIGIN).intercept({ path: '/v1/accounts', method: 'GET' }).replyWithError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    const down = await thrown(new BeeperClient({ baseUrl: ORIGIN, token: 't', dispatcher: mock }).accounts());
    expect(down).toBeInstanceOf(BeeperUnavailableError);
    await mock.close();
  });
});

describe('Beeper mapping', () => {
  it('keeps Instagram accounts only', () => {
    const f = new FakeBeeper();
    expect(f.accounts.filter((a) => isInstagramAccount(a as never)).map((a) => a.accountID)).toEqual([IG_ACCOUNT]);
    expect(isInstagramAccount({ accountID: 'local-instagram_ba_x', network: null, bridge: null })).toBe(true);
    expect(isInstagramAccount({ accountID: 'whatsapp', network: 'WhatsApp', bridge: { type: 'whatsapp' } })).toBe(false);
    void f.close();
  });

  it('extracts the numeric Instagram id from Beeper user ids', () => {
    expect(instagramIdOf(ROBIN.id)).toBe('9000000002');
    expect(instagramIdOf('9000000001')).toBe('9000000001');
    expect(instagramIdOf('@owner:beeper.com')).toBeNull();
    expect(instagramIdOf('@whatsapp_15555550101:beeper.local')).toBeNull();
  });

  it('message kinds', () => {
    expect(messageKind({ type: 'TEXT', text: 'hi' })).toBe('text');
    expect(messageKind({ type: 'TEXT', text: 'https://www.instagram.com/reel/abc/' })).toBe('link');
    expect(messageKind({ type: 'IMAGE', text: null, attachments: [{ type: 'img' }] })).toBe('attachment');
    expect(messageKind({ type: 'STICKER' })).toBe('sticker');
    expect(messageKind({ type: 'NOTICE', text: 'x' })).toBe('system');
    expect(messageKind({ type: 'TEXT', text: 'x', isHidden: true })).toBe('system');
    expect(messageKind({ type: 'TEXT', text: '  ' })).toBe('system');
  });
});
