import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@yb/shared';
import { createApp } from '../../src/http/app';
import type { SourcesView } from '../../src/routes/sources';
import { sourcesView } from '../../src/routes/sources';
import { memDb, T0 } from '../helpers';
import { DAY } from './world';

const devApp = (db = memDb()) => createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

function seedMessages(db: ReturnType<typeof memDb>, source: string, times: number[]) {
  const conv = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'direct', ?, ?)`,
  ).run(conv, source, conv, T0, T0);
  const ins = db.prepare(
    `INSERT INTO messages (source, source_msg_id, conversation_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'text', 'x', ?, ?)`,
  );
  for (const t of times) ins.run(source, uuidv7(), conv, t, T0, T0);
}

describe('GET /api/v1/sources', () => {
  it('is empty on a fresh database', async () => {
    const res = await request(devApp()).get('/api/v1/sources');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('joins health, cursors and message counts per source, in a fixed order, with errors redacted', async () => {
    const db = memDb();
    const health = db.prepare(
      `INSERT INTO source_health (source, status, last_ok_at, newest_data_at, last_error, details, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    health.run('whatsapp', 'stale', T0 - DAY, T0 - DAY, null, JSON.stringify({ snapshotMtime: T0 - DAY, note: 'from +15555550123' }), T0);
    health.run('imessage', 'error', T0 - 2 * DAY, null, 'send to someone@example.com failed for +1 555 555 0199', null, T0);
    const cur = db.prepare('INSERT INTO source_cursors (source, scope, cursor, high_water_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    cur.run('imessage', '', '84123', T0, T0);
    cur.run('beeper', '15555550123@chat', 'a'.repeat(80), null, T0 - 1);
    const now = Date.now();
    seedMessages(db, 'imessage', [now - 1000, now - 3 * DAY, now - 30 * DAY]);

    const view = sourcesView(db, now);
    expect(view.sources.map((s) => s.source)).toEqual(['imessage', 'whatsapp', 'beeper']);
    const [imessage, whatsapp, beeper] = view.sources;
    expect(imessage).toMatchObject({
      status: 'error',
      lastOkAt: T0 - 2 * DAY,
      lastError: 'send to [email] failed for [phone]',
      cursorCount: 1,
      cursors: [{ scope: '', cursor: '84123', highWaterAt: T0, updatedAt: T0 }],
      messages: { total: 3, last24h: 1, last7d: 2, oldestAt: now - 30 * DAY, newestAt: now - 1000 },
      // no health row value → falls back to the newest message
      newestDataAt: now - 1000,
    });
    expect(whatsapp).toMatchObject({ status: 'stale', details: { snapshotMtime: T0 - DAY, note: 'from [phone]' }, messages: null, cursors: [] });
    expect(beeper!.status).toBe('unknown');
    expect(beeper!.cursors[0]!.scope).not.toContain('5555550123');
    expect(beeper!.cursors[0]!.cursor.length).toBeLessThanOrEqual(32);

    const res = await request(devApp(db)).get('/api/v1/sources');
    expect(res.status).toBe(200);
    expect((res.body as SourcesView).sources.map((s) => s.source)).toEqual(['imessage', 'whatsapp', 'beeper']);
    expect(res.text).not.toContain('example.com');
    expect(res.text).not.toMatch(/555\s?555\s?01\d\d/);
  });
});
