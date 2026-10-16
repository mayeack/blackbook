import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { SETTING_KEYS, SettingsResponse, SettingsValues } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { undoBatch } from '../../src/journal/undo';
import { readSelfHandles } from '../../src/adapters/imessage/ingest';
import {
  ALL_SETTING_KEYS,
  exposedSettings,
  inLocalWindow,
  readSetting,
  settingDefault,
  settingDefaults,
  settingsMeta,
  settingsSnapshot,
  SettingsError,
  settingTimeZone,
  systemTimeZone,
  writeSetting,
  writeSettings,
} from '../../src/settings/registry';
import { writeSelfHandlesSetting } from '../../src/setup/selfHandles';
import { memDb, T0 } from '../helpers';

const issuesOf = (fn: () => unknown): { key: string; message: string }[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SettingsError) return e.issues;
    throw e;
  }
  throw new Error('expected a SettingsError');
};

describe('settings registry: defaults', () => {
  it('an empty database reads every default; delivery, push and test sends ship disabled', () => {
    const db = memDb();
    const s = settingsSnapshot(db);
    expect(s['digest.enabled']).toBe(false);
    expect(s['push.enabled']).toBe(false);
    expect(s['delivery.allow_test_send']).toBe(false);
    expect(s['digest.time']).toBe('08:00');
    expect(s['digest.catch_up_until']).toBe('11:00');
    expect(s['digest.max_items']).toBe(4);
    expect(s['digest.weekly']).toBe(false);
    expect(s.quiet_hours).toEqual({ start: '22:00', end: '07:00' });
    expect(s['push.names_in_notifications']).toBe(false);
    expect(s['agent.fading_multiple']).toBe(3);
    expect(s['agent.fading_min_silence_days']).toBe(21);
    expect([s['agent.priority_fading_multiple'], s['agent.priority_min_silence_days'], s['agent.priority_min_historical']]).toEqual([2, 14, 15]);
    expect(s['learner.wildcard_epsilon']).toBe(0.2);
    // Cost pass (Haiku 5.5 makes $1/day ample): $1/day, $10/month, $20 one-time backfill.
    expect([s['llm.daily_budget_usd'], s['llm.monthly_budget_usd'], s['llm.backfill_budget_usd']]).toEqual([1, 10, 20]);
    expect(s['llm.route_overrides']).toEqual({});
    expect(s['llm.enabled']).toBe(true);
    expect(s['commands.enabled']).toBe(true);
    expect(s['intros.enabled']).toBe(true);
    expect(s.tz).toBe(systemTimeZone());
    expect(s.self_handles).toEqual([]);
    expect(Object.keys(s).sort()).toEqual([...ALL_SETTING_KEYS].sort());
  });

  it('the defaults satisfy the shared schema, and every exposed key has metadata', () => {
    expect(SettingsValues.parse(settingDefaults())).toEqual(settingDefaults());
    const meta = settingsMeta(memDb());
    expect(meta.map((m) => m.key)).toEqual(SETTING_KEYS);
    expect(meta.every((m) => m.label && m.description && !m.overridden && m.updatedAt === null)).toBe(true);
    // Internal keys never appear in the exposed set.
    expect(SETTING_KEYS).not.toContain('self_handles');
  });

  it('a missing or invalid stored value falls back to the default (reads never throw)', () => {
    const db = memDb();
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES (?, ?, 1, 1)');
    put.run('digest.max_items', '9');
    put.run('digest.time', '"25:99"');
    put.run('tz', '"Mars/Olympus_Mons"');
    put.run('quiet_hours', '{"start":"23:00"}');
    expect(readSetting(db, 'digest.max_items')).toBe(4);
    expect(readSetting(db, 'digest.time')).toBe('08:00');
    expect(settingTimeZone(db)).toBe(systemTimeZone());
    expect(settingsSnapshot(db).quiet_hours).toEqual({ start: '22:00', end: '07:00' });
    put.run('tz', '"America/Chicago"');
    expect(settingTimeZone(db)).toBe('America/Chicago');
  });

  it('inLocalWindow handles windows that wrap midnight', () => {
    expect(inLocalWindow('23:00', '22:00', '07:00')).toBe(true);
    expect(inLocalWindow('06:59', '22:00', '07:00')).toBe(true);
    expect(inLocalWindow('07:00', '22:00', '07:00')).toBe(false);
    expect(inLocalWindow('12:00', '09:00', '17:00')).toBe(true);
    expect(inLocalWindow('17:00', '09:00', '17:00')).toBe(false);
  });
});

describe('settings registry: writes', () => {
  it('writes are validated, journaled as one batch and undoable', () => {
    const db = memDb();
    const r = writeSettings(db, { 'digest.time': '07:45', 'digest.max_items': 5, 'travel.home_city': 'Springfield' }, { actor: 'user', now: T0 });
    expect(r.batchId).toBeTruthy();
    expect([...r.changed].sort()).toEqual(['digest.max_items', 'digest.time', 'travel.home_city']);
    expect(db.prepare('SELECT kind, actor, title FROM change_batches WHERE id = ?').get(r.batchId)).toEqual({
      kind: 'setting',
      actor: 'user',
      title: 'Changed 3 settings',
    });
    expect(readSetting(db, 'digest.time')).toBe('07:45');
    expect(settingsMeta(db).find((m) => m.key === 'digest.time')).toMatchObject({ overridden: true, updatedAt: T0 });

    undoBatch(db, r.batchId!);
    expect(readSetting(db, 'digest.time')).toBe('08:00');
    expect(readSetting(db, 'travel.home_city')).toBeNull();
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
  });

  it('writing the stored value again changes nothing (no batch)', () => {
    const db = memDb();
    writeSetting(db, 'push.enabled', true, { actor: 'user' });
    const again = writeSetting(db, 'push.enabled', true, { actor: 'user' });
    expect(again).toEqual({ batchId: null, changed: [] });
    expect(writeSettings(db, {}, { actor: 'user', reset: ['digest.time'] })).toEqual({ batchId: null, changed: [] });
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(1);
  });

  it('reset removes the stored row (undo brings it back)', () => {
    const db = memDb();
    writeSetting(db, 'learner.wildcard_epsilon', 0.1, { actor: 'user' });
    const r = writeSettings(db, {}, { actor: 'user', reset: ['learner.wildcard_epsilon'] });
    expect(r.changed).toEqual(['learner.wildcard_epsilon']);
    expect(readSetting(db, 'learner.wildcard_epsilon')).toBe(0.2);
    undoBatch(db, r.batchId!);
    expect(readSetting(db, 'learner.wildcard_epsilon')).toBe(0.1);
  });

  it('rejects unknown keys, bad values, internal keys and bad zones before writing anything', () => {
    const db = memDb();
    const issues = issuesOf(() =>
      writeSettings(
        db,
        {
          'digest.time': '09:00',
          'digest.max_items': 6,
          'learner.wildcard_epsilon': 0.9,
          'learner.muted_kinds': ['fading', 'not_a_kind'],
          'nope.key': 1,
          self_handles: ['owner@example.com'],
          tz: 'Mars/Olympus_Mons',
        },
        { actor: 'user' },
      ),
    );
    expect(issues.map((i) => i.key).sort()).toEqual(['digest.max_items', 'learner.muted_kinds', 'learner.wildcard_epsilon', 'nope.key', 'self_handles', 'tz']);
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM change_batches').pluck().get()).toBe(0);
  });

  it('cross-field rules: catch-up after the brief time, brief outside quiet hours, quiet window non-empty', () => {
    const db = memDb();
    expect(issuesOf(() => writeSetting(db, 'digest.catch_up_until', '07:00', { actor: 'user' })).map((i) => i.key)).toEqual(['digest.catch_up_until']);
    expect(issuesOf(() => writeSettings(db, { 'digest.time': '06:30', 'digest.catch_up_until': '09:00' }, { actor: 'user' })).map((i) => i.key)).toEqual([
      'digest.time',
    ]);
    expect(issuesOf(() => writeSetting(db, 'quiet_hours', { start: '22:00', end: '22:00' }, { actor: 'user' })).map((i) => i.key)).toEqual(['quiet_hours']);
    // A failed cross-field check writes nothing, not even an empty run.
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(0);
    // Together the change is consistent.
    expect(writeSettings(db, { 'digest.time': '11:30', 'digest.catch_up_until': '13:00' }, { actor: 'user' }).changed).toHaveLength(2);
  });

  it('internal keys: only with allowInternal; self_handles stays compatible with setup:self and the ingest', () => {
    const db = memDb();
    writeSelfHandlesSetting(db, ['+12125550123', 'owner@example.com'], T0);
    expect(readSetting(db, 'self_handles')).toEqual(['+12125550123', 'owner@example.com']);
    writeSettings(db, { self_handles: ['+12125550124'] }, { actor: 'system', allowInternal: true });
    expect(readSelfHandles(db).map((h) => h.key)).toEqual(['+12125550124']);
    // The legacy {handles:[…]} shape still reads.
    db.prepare(`UPDATE settings SET value = '{"handles":["owner@example.com"]}' WHERE key = 'self_handles'`).run();
    expect(readSetting(db, 'self_handles')).toEqual(['owner@example.com']);
    expect(exposedSettings(db)).not.toHaveProperty('self_handles');
  });

  it('a write can join a caller-provided run', () => {
    const db = memDb();
    db.prepare(`INSERT INTO runs (id, kind, started_at, status) VALUES ('run-1', 'command', 1, 'running')`).run();
    const r = writeSetting(db, 'digest.paused_until', T0 + 86_400_000, { actor: 'user', runId: 'run-1', title: 'Paused the brief' });
    expect(db.prepare('SELECT run_id, title FROM change_batches WHERE id = ?').get(r.batchId)).toEqual({ run_id: 'run-1', title: 'Paused the brief' });
    expect(settingDefault('digest.paused_until')).toBeNull();
  });
});

describe('GET/PATCH /api/v1/settings', () => {
  const setup = () => {
    const db = memDb();
    const app = createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
    const patch = (body: object) => request(app).patch('/api/v1/settings').set('X-YB', '1').set('Content-Type', 'application/json').send(body);
    return { db, app, patch };
  };

  it('GET returns typed values, defaults, metadata and environment; never internal keys', async () => {
    const { db, app } = setup();
    writeSelfHandlesSetting(db, ['owner@example.com'], T0);
    const res = await request(app).get('/api/v1/settings');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = SettingsResponse.parse(res.body);
    expect(body.values['digest.enabled']).toBe(false);
    expect(body.environment).toMatchObject({ llmConfigured: false, pushConfigured: false, systemTimeZone: systemTimeZone() });
    expect(body.environment.llmSpend).toMatchObject({ todayUsd: 0, dailyBudgetUsd: 1 });
    expect(body.environment.llmModel).toEqual({ label: 'Claude Haiku 5.5', overriddenRoutes: 0 });
    expect(JSON.stringify(res.body)).not.toContain('owner@example.com');
    expect(JSON.stringify(res.body)).not.toContain('self_handles');
  });

  it('PATCH writes one undoable batch; bad input is a 400 with per-key issues; CSRF applies', async () => {
    const { app, patch } = setup();
    const ok = await patch({ values: { 'digest.enabled': true, quiet_hours: { start: '23:00', end: '06:30' } } });
    expect(ok.status).toBe(200);
    expect(ok.body.values['digest.enabled']).toBe(true);
    expect(ok.body.changed.sort()).toEqual(['digest.enabled', 'quiet_hours']);

    const undo = await request(app).post(`/api/v1/activity/${ok.body.batchId}/undo`).set('X-YB', '1').set('Content-Type', 'application/json').send({});
    expect(undo.status).toBe(200);
    expect((await request(app).get('/api/v1/settings')).body.values['digest.enabled']).toBe(false);

    expect((await patch({ values: { 'digest.max_items': 7 } })).status).toBe(400);
    expect((await patch({ values: { self_handles: ['owner@example.com'] } })).status).toBe(400);
    expect((await patch({ values: { 'made.up': true } })).status).toBe(400);
    const cross = await patch({ values: { 'digest.catch_up_until': '07:59' } });
    expect(cross.status).toBe(400);
    expect(cross.body.error.details).toEqual([{ key: 'digest.catch_up_until', message: 'must be later than the brief time' }]);
    expect((await patch({ reset: ['self_handles'] })).status).toBe(400);
    expect((await request(app).patch('/api/v1/settings').set('Content-Type', 'application/json').send({ values: {} })).status).toBe(403);
  });
});
