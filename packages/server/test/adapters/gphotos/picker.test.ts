import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { connectedClient, GoogleApiError, GoogleAuthError, GoogleContractError, GPHOTOS_REFRESH_TOKEN_SECRET } from '../../../src/adapters/calendar/google';
import { mediaUrl, parseDuration, pickerApi, PickerDownloadRefusedError, refusedDownload } from '../../../src/adapters/gphotos/picker';
import type { DB } from '../../../src/db/connection';
import { setSecret } from '../../../src/security/secrets';
import { memDb } from '../../helpers';
import { CLIENT, FakePhotos, MEDIA_HOST, REFRESH, T0, fakeImage } from './fakePhotos';

const KEY = crypto.randomBytes(32);
const fakes: FakePhotos[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(): { db: DB; g: FakePhotos; api: ReturnType<typeof pickerApi> } {
  const db = memDb();
  const g = new FakePhotos();
  fakes.push(g);
  setSecret(db, KEY, GPHOTOS_REFRESH_TOKEN_SECRET, REFRESH, T0);
  const client = connectedClient(db, KEY, CLIENT, g.fetch, 'photos')!;
  return { db, g, api: pickerApi(client) };
}

describe('Picker client', () => {
  it('creates a session with maxItemCount 2000 and parses the polling config', async () => {
    const { g, api } = setup();
    const s = await api.createSession();
    expect(s.id).toBe('sess-1');
    expect(s.pickerUri).toBe('https://photos.google.com/picker/sess-1');
    expect(s.pollIntervalMs).toBe(5000);
    expect(s.timeoutInMs).toBe(1_800_000);
    expect(s.expiresAt).toBe(T0 + 3_600_000);
    expect(s.mediaItemsSet).toBe(false);
    const create = g.callsTo('POST', /^\/v1\/sessions$/);
    expect(create).toHaveLength(1);
    expect(JSON.parse(create[0]!.body)).toEqual({ pickingConfig: { maxItemCount: '2000' } });
  });

  it('polls, lists every page, downloads with the size suffix and deletes', async () => {
    const { g, api } = setup();
    const s = await api.createSession();
    expect((await api.getSession(s.id)).mediaItemsSet).toBe(false);
    g.pageSize = 2;
    g.pick(s.id, [{ id: 'item-a' }, { id: 'item-b', type: 'VIDEO' }, { id: 'item-c', type: 'TYPE_UNSPECIFIED', mimeType: 'image/png' }]);
    expect((await api.getSession(s.id)).mediaItemsSet).toBe(true);
    const items = await api.listAllItems(s.id);
    expect(items.map((i) => [i.id, i.type])).toEqual([
      ['item-a', 'PHOTO'],
      ['item-b', 'VIDEO'],
      ['item-c', 'PHOTO'],
    ]);
    expect(items[0]!.createdAt).toBe(Date.parse('2026-10-20T21:00:00Z'));
    const lists = g.callsTo('GET', /^\/v1\/mediaItems$/);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.query.get('pageSize')).toBe('100');
    expect(lists[0]!.query.get('sessionId')).toBe(s.id);
    expect(lists[1]!.query.get('pageToken')).toBe('page-2');

    g.serve(`/test-${s.id}-1`, { body: fakeImage('x') });
    const media = await api.download(items[0]!.baseUrl!);
    expect(media.bytes.equals(fakeImage('x'))).toBe(true);
    expect(media.contentType).toBe('image/jpeg');
    expect(g.calls.at(-1)!.path).toBe(`/test-${s.id}-1=w1280-h1280`);
    await api.download(items[0]!.baseUrl!, 'small');
    expect(g.calls.at(-1)!.path).toBe(`/test-${s.id}-1=w960-h960`);

    await api.deleteSession(s.id);
    expect(g.sessions.get(s.id)!.deleted).toBe(true);
    await expect(api.getSession(s.id)).rejects.toMatchObject({ name: 'GoogleApiError', status: 404 });
  });

  it('maps a listing before the pick to FAILED_PRECONDITION', async () => {
    const { api } = setup();
    const s = await api.createSession();
    const err = await api.listItems(s.id).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ status: 400, reason: 'FAILED_PRECONDITION' });
  });

  it('a revoked grant is GoogleAuthError, carrying no token', async () => {
    const { g, api } = setup();
    g.refreshTokens.clear();
    const err = await api.createSession().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.reason).toBe('invalid_grant');
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(REFRESH);
  });

  it('a disabled API (403) is a GoogleApiError', async () => {
    const { g, api } = setup();
    g.failAll = { status: 403, reason: 'PERMISSION_DENIED' };
    await expect(api.createSession()).rejects.toMatchObject({ name: 'GoogleApiError', status: 403, reason: 'PERMISSION_DENIED' });
  });

  it('refuses a base URL off the allowlist before any request', async () => {
    const { g, api } = setup();
    const before = g.calls.length;
    for (const bad of ['https://evil.example/test-1', 'http://lh3.googleusercontent.com/test-1', 'https://lh3.googleusercontent.com.evil.example/x', 'not a url']) {
      await expect(api.download(bad)).rejects.toBeInstanceOf(PickerDownloadRefusedError);
    }
    expect(g.calls.length).toBe(before);
  });

  it('refuses a redirect from the media host (guardedFetch redirect: error)', async () => {
    const { g, api } = setup();
    g.serve('/test-r', { redirectTo: 'https://evil.example/elsewhere' });
    const err = await api.download(`${MEDIA_HOST}/test-r`).catch((e) => e);
    expect(err).toBeInstanceOf(PickerDownloadRefusedError);
    expect(err.reason).toBe('redirect');
  });

  it('a malformed session response is a GoogleContractError naming paths only', async () => {
    const { g, api } = setup();
    g.overrides.set('/v1/sessions/sess-x', { id: 'bad id with spaces' });
    const err = await api.getSession('sess-x').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleContractError);
    expect(err.paths).toEqual(['id']);
  });

  it('refuses session ids that could escape the path', async () => {
    const { api } = setup();
    await expect(api.getSession('../mediaItems')).rejects.toBeInstanceOf(GoogleContractError);
    await expect(api.listItems('a/b')).rejects.toBeInstanceOf(GoogleContractError);
  });
});

describe('Picker helpers', () => {
  it('parses protobuf durations', () => {
    expect(parseDuration('5s')).toBe(5000);
    expect(parseDuration('3.5s')).toBe(3500);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('1800.000000001s')).toBe(1_800_000);
    expect(parseDuration('5m')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  it('builds media URLs on lh<N> only', () => {
    expect(mediaUrl('https://lh3.googleusercontent.com/test-1', 'normal')).toBe('https://lh3.googleusercontent.com/test-1=w1280-h1280');
    expect(mediaUrl('https://lh5.googleusercontent.com/test-2', 'small')).toBe('https://lh5.googleusercontent.com/test-2=w960-h960');
    expect(() => mediaUrl('https://lh3.googleusercontent.com/test-1?x=1', 'normal')).toThrow(PickerDownloadRefusedError);
  });

  it('recognizes refusals in a cause chain', () => {
    const redirect = Object.assign(new Error('Request failed'), { cause: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) });
    expect(refusedDownload(redirect)?.reason).toBe('redirect');
    expect(refusedDownload(new Error('Request failed with status code 404'))).toBeNull();
  });
});
