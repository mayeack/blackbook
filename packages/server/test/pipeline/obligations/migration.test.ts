import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/connection';
import { migrate } from '../../../src/db/migrate';
import { runCommitments, runReplyDebtsAsync } from '../../../src/pipeline/obligations';
import { seedPerson } from '../../helpers';
import { ago, DAY, HOUR, NOW, world } from './world';

describe('migration 012', () => {
  it('upgrades a v11 database: legacy reminders read as origin legacy and keep working', () => {
    const db = openDatabase(':memory:');
    migrate(db, 11);
    const p = seedPerson(db, { display_name: 'Morgan Sample', first_name: 'Morgan' });
    db.prepare(
      `INSERT INTO commitments (id, person_id, owner, kind, what, due_at, due_precision, confidence, status, created_at, updated_at)
       VALUES ('019a0000-0000-7000-8000-000000000001', ?, 'me', 'other', 'Return the drill', ?, 'date', 1, 'open', ?, ?)`,
    ).run(p, NOW - 2 * DAY, NOW - 10 * DAY, NOW - 10 * DAY);
    migrate(db);
    const row = db.prepare('SELECT origin, made_at, sensitive, what_norm FROM commitments').get();
    expect(row).toEqual({ origin: 'legacy', made_at: null, sensitive: 0, what_norm: null });
    expect(db.prepare(`SELECT count(*) FROM pragma_table_list WHERE name = 'reply_verdicts'`).pluck().get()).toBe(1);
    // The lifecycle treats it like any dated promise: due now, lapsed 30 days after its due date.
    runCommitments(db, { now: NOW });
    expect(db.prepare('SELECT status FROM commitments').pluck().get()).toBe('due');
    runCommitments(db, { now: NOW + 29 * DAY });
    expect(db.prepare('SELECT status FROM commitments').pluck().get()).toBe('lapsed');
  });
});

describe('async pass', () => {
  it('hands the event loop back between steps and stops on abort', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      const p = w.person(`Pal${i}`);
      w.msg(w.dm(p.identity), p.identity, ago(10 * HOUR), 'are you around this weekend?');
    }
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const r = await runReplyDebtsAsync(w.db, { now: NOW, sliceMs: 0 });
    clearInterval(timer);
    expect(r.complete).toBe(true);
    expect(r.stats.created).toBe(5);
    expect(ticks).toBeGreaterThan(0);
    const ac = new AbortController();
    ac.abort();
    expect((await runReplyDebtsAsync(w.db, { now: NOW + 1, signal: ac.signal })).complete).toBe(false);
  });
});
