import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  daily,
  interval,
  JobAlreadyRunningError,
  latestOccurrence,
  MAX_BACKOFF_MS,
  Scheduler,
  weekly,
  type JobDef,
} from '../src/scheduler/scheduler';
import { memDb } from './helpers';

const TZ = 'America/Chicago';
/** Wall-clock time in Chicago (CDT, UTC−5 in October 2026). */
const at = (date: string, hhmm: string) => {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  return Date.UTC(y, mo - 1, d, h + 5, mi);
};

function counter(name: string, schedule: JobDef['schedule'], extra: Partial<JobDef> = {}) {
  const job = { name, schedule, runs: 0, ...extra, run: vi.fn(async () => void job.runs++) } as JobDef & { runs: number };
  if (extra.run) job.run = vi.fn(extra.run);
  return job;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('due rules', () => {
  it('latestOccurrence for daily and weekly', () => {
    expect(latestOccurrence(daily('02:30'), at('2026-10-14', '02:29'), TZ)).toBe('2026-10-13');
    expect(latestOccurrence(daily('02:30'), at('2026-10-14', '02:30'), TZ)).toBe('2026-10-14');
    // 2026-10-14 is a Wednesday; Sunday 04:00 → the 11th
    expect(latestOccurrence(weekly(0, '04:00'), at('2026-10-14', '12:00'), TZ)).toBe('2026-10-11');
    expect(latestOccurrence(weekly(3, '04:00'), at('2026-10-14', '03:59'), TZ)).toBe('2026-10-07');
    expect(latestOccurrence(weekly(3, '04:00'), at('2026-10-14', '04:00'), TZ)).toBe('2026-10-14');
  });

  it('backoff doubles and caps at an hour', () => {
    expect(backoffDelay(60_000, 1)).toBe(60_000);
    expect(backoffDelay(60_000, 2)).toBe(120_000);
    expect(backoffDelay(60_000, 4)).toBe(480_000);
    expect(backoffDelay(60_000, 20)).toBe(MAX_BACKOFF_MS);
  });
});

describe('Scheduler', () => {
  it('daily: a job missed while asleep runs once on wake, then waits for the next day', async () => {
    const db = memDb();
    const job = counter('nightly', daily('02:30'));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    db.prepare(`INSERT INTO job_state (job, last_success_local_date) VALUES ('nightly', '2026-10-13')`).run();

    vi.setSystemTime(at('2026-10-14', '01:00'));
    await s.tick();
    expect(job.runs).toBe(0);

    vi.setSystemTime(at('2026-10-14', '06:40')); // the Mac slept through 02:30
    await s.tick();
    expect(job.runs).toBe(1);
    await s.tick();
    vi.setSystemTime(at('2026-10-14', '23:59'));
    await s.tick();
    expect(job.runs).toBe(1);

    vi.setSystemTime(at('2026-10-15', '02:29'));
    await s.tick();
    expect(job.runs).toBe(1);
    vi.setSystemTime(at('2026-10-15', '02:30'));
    await s.tick();
    expect(job.runs).toBe(2);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state WHERE job = 'nightly'`).pluck().get()).toBe('2026-10-15');

    // down for two whole days: one catch-up run, not two
    vi.setSystemTime(at('2026-10-18', '09:00'));
    await s.tick();
    await s.tick();
    expect(job.runs).toBe(3);
  });

  it('daily: a never-run job waits for today\'s slot instead of firing early', async () => {
    const db = memDb();
    const job = counter('digest-send', daily('08:00'));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    vi.setSystemTime(at('2026-10-14', '07:00'));
    await s.tick();
    expect(job.runs).toBe(0);
    vi.setSystemTime(at('2026-10-14', '08:00'));
    await s.tick();
    expect(job.runs).toBe(1);
  });

  it('daily: an early-morning catch-up for a missed day does not eat that day\'s slot', async () => {
    const db = memDb();
    const job = counter('nightly', daily('02:30'));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    db.prepare(`INSERT INTO job_state (job, last_success_local_date) VALUES ('nightly', '2026-10-13')`).run();
    vi.setSystemTime(at('2026-10-15', '01:00')); // down through the 14th's slot
    await s.tick();
    expect(job.runs).toBe(1);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-14');
    await s.tick();
    expect(job.runs).toBe(1);
    vi.setSystemTime(at('2026-10-15', '02:30'));
    await s.tick();
    expect(job.runs).toBe(2);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-15');
  });

  it('daily: a manual run before the slot does not suppress that day\'s scheduled run', async () => {
    const db = memDb();
    const job = counter('digest-send', daily('08:00'));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    db.prepare(`INSERT INTO job_state (job, last_success_local_date) VALUES ('digest-send', '2026-10-13')`).run();
    vi.setSystemTime(at('2026-10-14', '07:00'));
    await s.runNow('digest-send');
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-13');
    await s.tick();
    expect(job.runs).toBe(1);
    vi.setSystemTime(at('2026-10-14', '08:00'));
    await s.tick();
    expect(job.runs).toBe(2);
    // a later manual run never moves the covered date backwards
    vi.setSystemTime(at('2026-10-14', '09:00'));
    await s.runNow('digest-send');
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-14');
  });

  it('daily catchUpUntil: a missed slot runs inside its window and is skipped (not run) after it', async () => {
    const db = memDb();
    const job = counter('digest-send', daily('08:00', { catchUpUntil: '11:00' }));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    db.prepare(`INSERT INTO job_state (job, last_success_local_date) VALUES ('digest-send', '2026-10-12')`).run();

    // Woke at 07:00 on the 14th: the 13th's digest window closed yesterday at 11:00, so it is skipped.
    vi.setSystemTime(at('2026-10-14', '07:00'));
    await s.tick();
    expect(job.runs).toBe(0);
    expect(db.prepare(`SELECT status, trigger FROM job_runs`).raw().all()).toEqual([['skipped', 'schedule']]);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-13');
    await s.tick();
    expect(db.prepare(`SELECT count(*) FROM job_runs`).pluck().get()).toBe(1);

    // Slept through 08:00 but woke at 10:30: still inside the window.
    vi.setSystemTime(at('2026-10-14', '10:30'));
    await s.tick();
    expect(job.runs).toBe(1);

    // Slept through the whole window on the 15th: skipped at 11:00, nothing sent late.
    vi.setSystemTime(at('2026-10-15', '11:00'));
    await s.tick();
    expect(job.runs).toBe(1);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-15');
    vi.setSystemTime(at('2026-10-16', '08:00'));
    await s.tick();
    expect(job.runs).toBe(2);
  });

  it('daily rejects bad times and windows', () => {
    expect(() => daily('8:00')).toThrow();
    expect(() => daily('08:00', { catchUpUntil: '07:00' })).toThrow();
  });

  it('weekly', async () => {
    const db = memDb();
    const job = counter('circles', weekly(0, '04:00'));
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    vi.setSystemTime(at('2026-10-11', '04:00')); // Sunday
    await s.tick();
    vi.setSystemTime(at('2026-10-14', '04:00'));
    await s.tick();
    expect(job.runs).toBe(1);
    vi.setSystemTime(at('2026-10-19', '10:00')); // slept through Sunday the 18th
    await s.tick();
    expect(job.runs).toBe(2);
  });

  it('interval jobs run, then wait their interval', async () => {
    const db = memDb();
    const job = counter('tail', interval(10_000));
    const s = new Scheduler({ db, jobs: [job] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 12));
    await s.tick();
    await s.tick();
    expect(job.runs).toBe(1);
    vi.advanceTimersByTime(9_999);
    await s.tick();
    expect(job.runs).toBe(1);
    vi.advanceTimersByTime(1);
    await s.tick();
    expect(job.runs).toBe(2);
  });

  it('single-flight: a running job is never started twice', async () => {
    const db = memDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = counter('slow', interval(1000), { run: () => gate });
    const s = new Scheduler({ db, jobs: [job] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 12));
    const first = s.tick();
    vi.advanceTimersByTime(5000);
    await s.tick();
    await expect(s.runNow('slow')).rejects.toBeInstanceOf(JobAlreadyRunningError);
    expect(job.run).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT status, lease_expires_at IS NOT NULL FROM job_runs`).raw().all()).toEqual([['running', 1]]);
    expect(s.status()[0]!.running).toBe(true);
    release();
    await first;
    expect(db.prepare(`SELECT status, lease_expires_at FROM job_runs`).raw().all()).toEqual([['ok', null]]);
    expect(s.status()[0]!.running).toBe(false);
  });

  it('exclusive jobs never overlap each other', async () => {
    const db = memDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = counter('import', interval(1000), { exclusive: true, run: () => gate });
    const b = counter('nightly-x', interval(1000), { exclusive: true });
    const c = counter('tail', interval(1000));
    const s = new Scheduler({ db, jobs: [a, b, c] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 12));
    const t = s.tick();
    expect(b.run).not.toHaveBeenCalled();
    expect(c.run).toHaveBeenCalledTimes(1);
    release();
    await t;
    await s.tick();
    expect(b.run).toHaveBeenCalledTimes(1);
  });

  it('failures back off exponentially (capped at 1 h) and success resets', async () => {
    const db = memDb();
    let fail = true;
    const job = counter('flaky', interval(60_000), {
      run: async () => {
        if (fail) throw new Error('collector unreachable at +12125550123');
      },
    });
    const s = new Scheduler({ db, jobs: [job] });
    const t0 = Date.UTC(2026, 9, 14, 12);
    vi.setSystemTime(t0);
    const [r1] = await s.tick();
    expect(r1!.status).toBe('error');
    const st = () => db.prepare(`SELECT consecutive_failures, next_due_at FROM job_state WHERE job = 'flaky'`).get() as { consecutive_failures: number; next_due_at: number };
    expect(st()).toEqual({ consecutive_failures: 1, next_due_at: t0 + 60_000 });
    vi.setSystemTime(t0 + 59_999);
    expect(await s.tick()).toEqual([]);
    vi.setSystemTime(t0 + 60_000);
    await s.tick();
    expect(st()).toEqual({ consecutive_failures: 2, next_due_at: t0 + 60_000 + 120_000 });
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(st().next_due_at);
      await s.tick();
    }
    expect(st().consecutive_failures).toBe(10);
    expect(st().next_due_at - Date.now()).toBe(MAX_BACKOFF_MS);
    // the stored error message is redacted
    expect(db.prepare(`SELECT error_message FROM job_runs ORDER BY id LIMIT 1`).pluck().get()).toBe('collector unreachable at [phone]');
    fail = false;
    vi.setSystemTime(st().next_due_at);
    await s.tick();
    expect(st()).toEqual({ consecutive_failures: 0, next_due_at: Date.now() + 60_000 });
  });

  it('daily failures retry with backoff the same day', async () => {
    const db = memDb();
    let fail = true;
    const job = counter('backup', daily('02:15'), {
      run: async () => {
        if (fail) throw new Error('disk full');
      },
    });
    const s = new Scheduler({ db, jobs: [job], timeZone: TZ });
    vi.setSystemTime(at('2026-10-14', '02:15'));
    await s.tick();
    vi.setSystemTime(at('2026-10-14', '02:19'));
    await s.tick();
    expect(job.run).toHaveBeenCalledTimes(1);
    fail = false;
    vi.setSystemTime(at('2026-10-14', '02:20')); // base 5 min
    await s.tick();
    expect(job.run).toHaveBeenCalledTimes(2);
    expect(db.prepare(`SELECT last_success_local_date FROM job_state`).pluck().get()).toBe('2026-10-14');
  });

  it('marks runs left "running" by a dead process as abandoned at start', async () => {
    const db = memDb();
    db.prepare(`INSERT INTO job_runs (job, started_at, status, lease_expires_at) VALUES ('nightly', 1, 'running', 2)`).run();
    const s = new Scheduler({ db, jobs: [] });
    s.start();
    await s.stop();
    expect(db.prepare(`SELECT status FROM job_runs`).pluck().get()).toBe('abandoned');
  });

  it('runNow runs on demand and rejects unknown jobs', async () => {
    const db = memDb();
    const job = counter('backup', daily('02:15'));
    const s = new Scheduler({ db, jobs: [job] });
    const r = await s.runNow('backup');
    expect(r).toMatchObject({ job: 'backup', status: 'ok' });
    expect(db.prepare(`SELECT trigger FROM job_runs`).pluck().get()).toBe('manual');
    await expect(s.runNow('nope')).rejects.toThrow(/unknown job/);
  });
});
