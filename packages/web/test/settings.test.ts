import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KindPropensity, SettingKey, SettingsValues } from '@yb/shared';
import { ApiError } from '../src/api/client';
import { sortKinds, trendText } from '../src/pages/settings/learnedLogic';
import {
  addId,
  budgetShare,
  buildPatch,
  crossFieldErrors,
  dirtyKeys,
  inWindow,
  isTimeZone,
  mergeDraft,
  normalizeSpend,
  numberBounds,
  pauseUntil,
  serverFieldErrors,
  spendUsd,
  validateField,
  weekdayName,
  type Draft,
} from '../src/pages/settings/logic';
import { deviceLabel, pushSupport, sameKey, subscribeBody, subscribeThisDevice, urlBase64ToUint8Array, type PushEnv } from '../src/pages/settings/push';

// Nothing in these tests may reach the network.
beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const values = (o: Partial<SettingsValues> = {}): SettingsValues => ({
  'digest.enabled': false,
  'digest.time': '08:00',
  'digest.catch_up_until': '11:00',
  'digest.max_items': 4,
  'digest.adaptive_cap': true,
  'digest.weekly': false,
  'digest.paused_until': null,
  quiet_hours: { start: '22:00', end: '07:00' },
  'delivery.allow_test_send': false,
  'push.enabled': false,
  'push.names_in_notifications': false,
  'push.pre_event': true,
  'agent.fading_multiple': 3,
  'agent.fading_min_silence_days': 21,
  'agent.fading_min_historical': 40,
  'agent.fading_min_contact_days': 6,
  'agent.priority_fading_multiple': 2,
  'agent.priority_min_silence_days': 14,
  'agent.priority_min_historical': 15,
  'agent.dormant_days': 365,
  'agent.ignore_cooldown_days': 7,
  'learner.enabled': true,
  'learner.wildcard_epsilon': 0.2,
  'learner.muted_kinds': [],
  'llm.enabled': true,
  'llm.daily_budget_usd': 5,
  'llm.monthly_budget_usd': 60,
  'llm.backfill_budget_usd': 150,
  'llm.excluded_person_ids': [],
  'llm.excluded_conversation_ids': [],
  'llm.route_overrides': {},
  'commands.enabled': true,
  'commands.read_images': true,
  'intros.enabled': true,
  'travel.home_city': null,
  'gmail.backfill_days': 1095,
  'gmail.extra_senders': [],
  'events.enabled': true,
  'events.weekday': 1,
  'events.time': '09:30',
  'events.max_picks': 5,
  'events.city': null,
  'events.max_searches': 10,
  tz: 'UTC',
  ...o,
});

describe('settings validation (bounds from @yb/shared)', () => {
  it('reads numeric bounds off the shared schema', () => {
    expect(numberBounds('digest.max_items')).toEqual({ min: 3, max: 5, int: true });
    expect(numberBounds('learner.wildcard_epsilon')).toEqual({ min: 0, max: 0.5, int: false });
  });

  it('per-field messages', () => {
    expect(validateField('digest.max_items', 4)).toBeNull();
    expect(validateField('digest.max_items', 9)).toBe('A whole number from 3 to 5.');
    expect(validateField('digest.max_items', Number.NaN)).toBe('A whole number from 3 to 5.');
    expect(validateField('agent.fading_multiple', 1)).toBe('A number from 1.5 to 6.');
    expect(validateField('digest.time', '25:00')).toBe('A time like 08:00.');
    expect(validateField('travel.home_city', null)).toBeNull();
  });

  it('cross-field rules match the server', () => {
    expect(crossFieldErrors(values())).toEqual({});
    expect(crossFieldErrors(values({ 'digest.catch_up_until': '07:30' }))).toHaveProperty('digest.catch_up_until');
    expect(crossFieldErrors(values({ quiet_hours: { start: '06:00', end: '06:00' } }))).toHaveProperty('quiet_hours');
    expect(crossFieldErrors(values({ 'digest.time': '06:30', 'digest.catch_up_until': '09:00' }))).toEqual({ 'digest.time': 'Falls inside quiet hours.' });
    expect(inWindow('23:00', '22:00', '07:00')).toBe(true);
    expect(inWindow('12:00', '09:00', '17:00')).toBe(true);
    expect(inWindow('08:00', '22:00', '07:00')).toBe(false);
  });

  it('time zones and id lists', () => {
    expect(isTimeZone('America/Chicago')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(addId(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addId(['a'], 'a')).toEqual(['a']);
    expect(addId(['a'], '  ')).toEqual(['a']);
  });
});

describe('settings draft → one PATCH', () => {
  const server = values();
  const defaults = values();

  it('only changed keys are sent; equal values and empty drafts send nothing', () => {
    expect(buildPatch(server, {}, new Set(), new Set())).toBeNull();
    expect(buildPatch(server, { 'digest.time': '08:00' }, new Set(), new Set())).toBeNull();
    const draft: Draft = { 'digest.time': '07:45', 'digest.enabled': true, quiet_hours: { start: '22:00', end: '07:00' } };
    expect(buildPatch(server, draft, new Set(), new Set())).toEqual({ values: { 'digest.time': '07:45', 'digest.enabled': true } });
  });

  it('resets go in `reset` only for overridden keys, and win over a draft value', () => {
    const resets = new Set<SettingKey>(['digest.max_items', 'tz']);
    const overridden = new Set(['digest.max_items']);
    expect(buildPatch(server, { 'digest.max_items': 5 }, resets, overridden)).toEqual({ values: {}, reset: ['digest.max_items'] });
    expect(dirtyKeys(server, { 'digest.max_items': 5 }, resets, overridden)).toEqual(['digest.max_items']);
  });

  it('effective values put the draft over the server and resets back to defaults', () => {
    const merged = mergeDraft(values({ 'digest.max_items': 5 }), defaults, { 'digest.time': '09:00' }, new Set<SettingKey>(['digest.max_items']));
    expect(merged['digest.time']).toBe('09:00');
    expect(merged['digest.max_items']).toBe(4);
  });

  it('maps server issues onto fields (registry and zod shapes)', () => {
    const e = new ApiError(400, 'BAD_REQUEST', 'Some settings are invalid.', [
      { key: 'digest.catch_up_until', message: 'must be later than the brief time' },
      { path: 'values.digest.max_items', message: 'Too big' },
      { key: 'self_handles', message: 'not changeable here' },
    ]);
    expect(serverFieldErrors(e)).toEqual({ 'digest.catch_up_until': 'Must be later than the brief time.', 'digest.max_items': 'Too big.' });
    expect(serverFieldErrors(new Error('x'))).toEqual({});
  });
});

describe('settings formatters', () => {
  it('pause through a day = the next local midnight, only in the future', () => {
    const now = new Date(2026, 9, 14, 10).getTime();
    expect(pauseUntil('2026-10-20', now)).toBe(new Date(2026, 9, 21).getTime());
    expect(pauseUntil('2026-10-01', now)).toBeNull();
    expect(pauseUntil('nope', now)).toBeNull();
  });

  it('budget share and spend parsing', () => {
    expect(budgetShare(2.5, 5)).toBe(0.5);
    expect(budgetShare(9, 5)).toBe(1);
    expect(budgetShare(1, 0)).toBeNull();
    expect(normalizeSpend({ llmConfigured: true })).toBeNull();
    expect(normalizeSpend({ llmSpend: { todayUsd: 0.4, monthUsd: 3, backfillUsd: 12, requestsToday: 7, cacheHitRate: 0.8 } })).toEqual({
      todayUsd: 0.4,
      monthUsd: 3,
      backfillUsd: 12,
      requestsToday: 7,
      cacheHitRate: 0.8,
    });
    expect(normalizeSpend({ llmSpend: { todayUsd: 'x', monthUsd: 1 } })).toBeNull();
    // Haiku-priced spend is often under a cent: keep it visible instead of "$0.00".
    expect(spendUsd(0.0042)).toBe('$0.0042');
    expect(spendUsd(0)).toBe('$0.00');
    expect(spendUsd(0.37)).toBe('$0.37');
  });

  it('learned kinds sort and trend text', () => {
    const k = (kind: KindPropensity['kind'], propensity: number, muted = false): KindPropensity => ({
      kind,
      alpha: 2,
      beta: 2,
      propensity,
      trend: 'flat',
      trendDelta: 0,
      shown30d: 1,
      acted30d: 0,
      muted,
    });
    expect(sortKinds([k('fading', 0.3), k('intro', 0.9, true), k('reply_debt', 0.7)]).map((x) => x.kind)).toEqual(['reply_debt', 'fading', 'intro']);
    expect(trendText('up', 0.06)).toBe('↑ 6 pts');
    expect(trendText('down', 0.01)).toBe('↓ 1 pt');
    expect(trendText('flat', 0.2)).toBe('steady');
    expect(trendText('up', 0.001)).toBe('steady');
  });
});

describe('push on this device', () => {
  const env = (o: Partial<PushEnv> = {}): PushEnv => ({
    hasPushManager: true,
    hasNotification: true,
    hasServiceWorker: true,
    workerRegistered: true,
    permission: 'default',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    standalone: false,
    ...o,
  });
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

  it('support states', () => {
    expect(pushSupport(env())).toBe('ready');
    expect(pushSupport(env({ userAgent: IPHONE }))).toBe('needs_install');
    expect(pushSupport(env({ userAgent: IPHONE, standalone: true }))).toBe('ready');
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushSupport(env({ workerRegistered: false }))).toBe('no_worker');
    expect(pushSupport(env({ permission: 'denied' }))).toBe('denied');
  });

  it('device labels never carry the full user agent', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone · Safari');
    expect(deviceLabel(env().userAgent)).toBe('Mac · Safari');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabel('')).toBe('Device · Browser');
  });

  it('VAPID key decoding and comparison', () => {
    const k = urlBase64ToUint8Array('AQID-_8');
    expect([...k]).toEqual([1, 2, 3, 251, 255]);
    expect(sameKey(new Uint8Array([1, 2, 3, 251, 255]).buffer, k)).toBe(true);
    expect(sameKey(new Uint8Array([1, 2]).buffer, k)).toBe(false);
    expect(sameKey(null, k)).toBe(false);
  });

  it('subscribe body requires an https endpoint and both keys', () => {
    const json = { endpoint: 'https://push.example.com/x', expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } };
    expect(subscribeBody(json, IPHONE)).toEqual({ ...json, userAgent: 'iPhone · Safari' });
    expect(subscribeBody({ ...json, endpoint: 'http://push.example.com/x' }, IPHONE)).toBeNull();
    expect(subscribeBody({ endpoint: json.endpoint, keys: { p256dh: 'pk' } }, IPHONE)).toBeNull();
  });

  function fakeRegistration(existing: { key: Uint8Array } | null) {
    const unsubscribe = vi.fn(async () => true);
    const mk = (key: Uint8Array, endpoint: string) =>
      ({
        endpoint,
        options: { applicationServerKey: key.buffer, userVisibleOnly: true },
        unsubscribe,
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } }),
      }) as unknown as PushSubscription;
    const subscribe = vi.fn(async (o: PushSubscriptionOptionsInit) => mk(o.applicationServerKey as Uint8Array, 'https://push.example.com/new'));
    const pushManager = {
      getSubscription: async () => (existing ? mk(existing.key, 'https://push.example.com/old') : null),
      subscribe,
    } as unknown as PushManager;
    return { reg: { pushManager }, subscribe, unsubscribe };
  }

  it('asks permission, subscribes user-visible with the key, and registers it', async () => {
    const { reg, subscribe } = fakeRegistration(null);
    const post = vi.fn(async () => ({ id: 'dev-1' }));
    const out = await subscribeThisDevice('AQID', { requestPermission: async () => 'granted', getRegistration: async () => reg, post, userAgent: IPHONE });
    expect(out).toEqual({ ok: true, id: 'dev-1', endpoint: 'https://push.example.com/new' });
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.com/new', userAgent: 'iPhone · Safari' }));
  });

  it('reuses a subscription made with the same key; replaces one made with another key', async () => {
    const same = fakeRegistration({ key: new Uint8Array([1, 2, 3]) });
    const post = vi.fn(async () => ({ id: 'dev-1' }));
    const deps = { requestPermission: async () => 'granted' as const, post, userAgent: '' };
    expect(await subscribeThisDevice('AQID', { ...deps, getRegistration: async () => same.reg })).toMatchObject({ endpoint: 'https://push.example.com/old' });
    expect(same.subscribe).not.toHaveBeenCalled();
    const rotated = fakeRegistration({ key: new Uint8Array([9, 9, 9]) });
    expect(await subscribeThisDevice('AQID', { ...deps, getRegistration: async () => rotated.reg })).toMatchObject({ endpoint: 'https://push.example.com/new' });
    expect(rotated.unsubscribe).toHaveBeenCalled();
  });

  it('stops without permission, a worker or a key (and never posts)', async () => {
    const post = vi.fn(async () => ({ id: 'x' }));
    const { reg } = fakeRegistration(null);
    const base = { post, userAgent: '', getRegistration: async () => reg };
    expect(await subscribeThisDevice('AQID', { ...base, requestPermission: async () => 'denied' })).toEqual({ ok: false, reason: 'denied' });
    expect(await subscribeThisDevice('AQID', { ...base, requestPermission: async () => 'granted', getRegistration: async () => null })).toEqual({
      ok: false,
      reason: 'no_worker',
    });
    expect(await subscribeThisDevice(null, { ...base, requestPermission: async () => 'granted' })).toEqual({ ok: false, reason: 'no_key' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('extra ticket senders (gmail.extra_senders)', () => {
  it('keeps valid, lowercased, de-duplicated domains from comma or space separated text', async () => {
    const { parseSenderDomains } = await import('../src/pages/settings/logic');
    expect(parseSenderDomains('Club.Example, tickets.venue.example  @promo.example;club.example')).toEqual(['club.example', 'tickets.venue.example', 'promo.example']);
    expect(parseSenderDomains('not a domain, x, -bad.example, ok.example')).toEqual(['ok.example']);
    expect(parseSenderDomains('')).toEqual([]);
  });
});

describe('event picks (events.*)', () => {
  it('bounds, messages and the weekday names the select shows', () => {
    expect(numberBounds('events.max_picks')).toEqual({ min: 2, max: 8, int: true });
    expect(numberBounds('events.max_searches')).toEqual({ min: 2, max: 12, int: true });
    expect(numberBounds('events.weekday')).toEqual({ min: 0, max: 6, int: true });
    expect(validateField('events.max_picks', 9)).toBe('A whole number from 2 to 8.');
    expect(validateField('events.time', '9:30pm')).toBe('A time like 08:00.');
    expect(validateField('events.time', '21:30')).toBeNull();
    expect(validateField('events.city', null)).toBeNull();
    expect(validateField('events.city', 'Springfield')).toBeNull();
    expect(validateField('events.city', 'X')).not.toBeNull();
    expect(weekdayName(0)).toMatch(/^Sun/);
    expect(weekdayName(1)).toMatch(/^Mon/);
    expect(weekdayName(6)).toMatch(/^Sat/);
  });

  it('a changed pick day goes in the one PATCH like any other key', () => {
    const v = values();
    expect(buildPatch(v, { 'events.weekday': 5, 'events.city': 'Springfield' }, new Set(), new Set())).toEqual({
      values: { 'events.weekday': 5, 'events.city': 'Springfield' },
    });
    expect(crossFieldErrors(values({ 'events.time': '23:00' }))).toEqual({});
  });
});
