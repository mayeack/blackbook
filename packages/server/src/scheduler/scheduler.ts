/**
 * "If due, run" scheduler (PLAN.md schedule table). A tick every 10 s checks each job:
 *   interval(ms)       due when next_due_at has passed (or it never ran);
 *   daily(HH:MM)       due when the latest HH:MM occurrence is after last_success_local_date, so a job missed while
 *                      the Mac slept or the server was down runs once on the next tick. With `catchUpUntil`, an
 *                      occurrence whose window [HH:MM, catchUpUntil) has passed is recorded as skipped instead;
 *   weekly(dow, HH:MM) due when the latest (dow, HH:MM) occurrence is after last_success_local_date.
 * last_success_local_date is the occurrence a run covered (not the day it ran), so a manual or catch-up run before
 * today's slot never suppresses that slot.
 * Each job is single-flight (in-process set + a job_runs lease kept fresh by a heartbeat). Failures back off
 * exponentially: min(base·2^(n−1), 1 h) after the n-th consecutive failure. Exclusive jobs never overlap
 * each other. State lives in job_state / job_runs so it survives restarts.
 */
import { addDays, localParts } from '@yb/shared';
import type { DB } from '../db/connection';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { redact } from '../ops/redact';

export type Schedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; at: string; catchUpUntil?: string }
  | { kind: 'weekly'; dow: number; at: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const interval = (everyMs: number): Schedule => ({ kind: 'interval', everyMs });
/** `catchUpUntil` (HH:MM, same day, after `at`): a missed occurrence still runs before then, later it is skipped. */
export function daily(at: string, o: { catchUpUntil?: string } = {}): Schedule {
  if (!HHMM.test(at)) throw new Error(`bad daily time ${at}`);
  if (o.catchUpUntil === undefined) return { kind: 'daily', at };
  if (!HHMM.test(o.catchUpUntil) || o.catchUpUntil <= at) throw new Error(`bad catchUpUntil ${o.catchUpUntil}`);
  return { kind: 'daily', at, catchUpUntil: o.catchUpUntil };
}
export const weekly = (dow: number, at: string): Schedule => ({ kind: 'weekly', dow, at });

export interface JobContext {
  db: DB;
  jobRunId: number;
  trigger: 'schedule' | 'manual' | 'boot';
  now(): number;
  log: Logger;
  /** Aborted when the scheduler stops; long jobs should check it between chunks. */
  signal: AbortSignal;
}

export type JobOutcome = { status?: 'ok' | 'skipped' | 'partial'; stats?: Record<string, number> } | void;

export interface JobDef {
  name: string;
  schedule: Schedule;
  run(ctx: JobContext): Promise<JobOutcome> | JobOutcome;
  /** Exclusive jobs (nightly, imports) never run at the same time as each other. */
  exclusive?: boolean;
  /** First retry delay after a failure (default: the interval, or 5 min for daily/weekly jobs). */
  backoffBaseMs?: number;
  leaseMs?: number;
  disabled?: boolean;
}

export interface Clock {
  now(): number;
}

export interface SchedulerOptions {
  db: DB;
  jobs: JobDef[];
  log?: Logger;
  clock?: Clock;
  tickMs?: number;
  /** IANA zone for daily/weekly times (default: the system zone). */
  timeZone?: string;
}

export interface RunResult {
  job: string;
  status: 'ok' | 'error' | 'skipped' | 'partial';
  jobRunId: number;
  durationMs: number;
  errorClass?: string;
}

export interface JobStatus {
  name: string;
  schedule: Schedule;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastSuccessLocalDate: string | null;
  consecutiveFailures: number;
  nextDueAt: number | null;
  lastErrorClass: string | null;
  disabled: boolean;
}

interface StateRow {
  job: string;
  last_run_at: number | null;
  last_success_at: number | null;
  last_success_local_date: string | null;
  consecutive_failures: number;
  last_error_class: string | null;
  next_due_at: number | null;
  disabled: number;
}

export const MAX_BACKOFF_MS = 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

export class JobAlreadyRunningError extends Error {
  constructor(job: string) {
    super(`${job} is already running`);
    this.name = 'JobAlreadyRunningError';
  }
}

export function backoffDelay(baseMs: number, failures: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

/** Local date of the latest occurrence of `schedule` at or before `now` (daily/weekly only). */
export function latestOccurrence(schedule: Schedule, now: number, timeZone?: string): string | null {
  if (schedule.kind === 'interval') return null;
  const p = localParts(now, timeZone);
  if (schedule.kind === 'daily') return p.hhmm >= schedule.at ? p.date : addDays(p.date, -1);
  let back = (p.dow - schedule.dow + 7) % 7;
  if (back === 0 && p.hhmm < schedule.at) back = 7;
  return addDays(p.date, -back);
}

type Dueness = { kind: 'no' } | { kind: 'run' } | { kind: 'skip'; occurrence: string };

export class Scheduler {
  private readonly db: DB;
  private readonly jobs: Map<string, JobDef>;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly timeZone?: string;
  private readonly running = new Map<string, Promise<RunResult>>();
  private timer: NodeJS.Timeout | null = null;
  private abort = new AbortController();
  private stopped = false;

  constructor(o: SchedulerOptions) {
    this.db = o.db;
    this.jobs = new Map(o.jobs.map((j) => [j.name, j]));
    if (this.jobs.size !== o.jobs.length) throw new Error('duplicate job names');
    this.log = o.log ?? nullLogger;
    this.clock = o.clock ?? { now: () => Date.now() };
    this.tickMs = o.tickMs ?? 10_000;
    this.timeZone = o.timeZone;
  }

  /** Marks job_runs left 'running' by a dead process as abandoned (the data-dir lock rules out a live one). */
  recoverAbandoned(): number {
    return this.db
      .prepare(`UPDATE job_runs SET status = 'abandoned', finished_at = ? WHERE status = 'running'`)
      .run(this.clock.now()).changes;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const abandoned = this.recoverAbandoned();
    if (abandoned) this.log.warn('scheduler.abandoned_runs', { counts: { abandoned } });
    this.timer = setInterval(() => this.safeTick(), this.tickMs);
    this.timer.unref();
    this.safeTick();
  }

  /** Timer-driven tick: a failure (e.g. the DB is busy) is logged, never an unhandled rejection. */
  private safeTick(): void {
    this.tick().catch((e: unknown) => this.log.error('scheduler.tick_failed', errorFields(e)));
  }

  /** Stops ticking, signals running jobs, and waits for them (up to graceMs). */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    const pending = [...this.running.values()];
    if (pending.length) {
      await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, graceMs).unref())]);
    }
    this.abort = new AbortController();
  }

  private state(job: string): StateRow | undefined {
    return this.db.prepare('SELECT * FROM job_state WHERE job = ?').get(job) as StateRow | undefined;
  }

  isDue(job: JobDef, now = this.clock.now()): boolean {
    return this.dueness(job, now).kind === 'run';
  }

  private dueness(job: JobDef, now: number): Dueness {
    if (job.disabled) return { kind: 'no' };
    const st = this.state(job.name);
    if (st?.disabled) return { kind: 'no' };
    if (st?.next_due_at != null && now < st.next_due_at) return { kind: 'no' }; // interval wait or failure backoff
    if (job.schedule.kind === 'interval') return { kind: 'run' };
    const occurrence = latestOccurrence(job.schedule, now, this.timeZone)!;
    const today = localParts(now, this.timeZone);
    // Never succeeded: wait for today's slot instead of firing a stale one (a fresh install at 07:00 must not
    // send the 08:00 digest early).
    const pending = st?.last_success_local_date == null ? occurrence === today.date : st.last_success_local_date < occurrence;
    if (!pending) return { kind: 'no' };
    const until = job.schedule.kind === 'daily' ? job.schedule.catchUpUntil : undefined;
    if (until && (occurrence < today.date || today.hhmm >= until)) return { kind: 'skip', occurrence };
    return { kind: 'run' };
  }

  /** Starts every due job; resolves when the jobs started by this tick finish. */
  async tick(): Promise<RunResult[]> {
    if (this.stopped) return [];
    const now = this.clock.now();
    const started: Promise<RunResult>[] = [];
    for (const job of this.jobs.values()) {
      if (this.running.has(job.name)) continue;
      const due = this.dueness(job, now);
      if (due.kind === 'skip') {
        this.recordMissed(job, due.occurrence, now);
        continue;
      }
      if (due.kind !== 'run') continue;
      if (job.exclusive && [...this.running.keys()].some((n) => this.jobs.get(n)?.exclusive)) continue;
      started.push(this.launch(job, 'schedule'));
    }
    return Promise.all(started);
  }

  /** Runs a job now (admin socket / CLI). Rejects if it is already running. */
  runNow(name: string, trigger: 'manual' | 'boot' = 'manual'): Promise<RunResult> {
    const job = this.jobs.get(name);
    if (!job) return Promise.reject(new Error(`unknown job ${name}`));
    if (this.running.has(name)) return Promise.reject(new JobAlreadyRunningError(name));
    return this.launch(job, trigger);
  }

  private launch(job: JobDef, trigger: JobContext['trigger']): Promise<RunResult> {
    const p = this.execute(job, trigger).finally(() => this.running.delete(job.name));
    this.running.set(job.name, p);
    return p;
  }

  private async execute(job: JobDef, trigger: JobContext['trigger']): Promise<RunResult> {
    const startedAt = this.clock.now();
    const leaseMs = job.leaseMs ?? DEFAULT_LEASE_MS;
    const jobRunId = Number(
      this.db
        .prepare(`INSERT INTO job_runs (job, started_at, status, trigger, lease_expires_at) VALUES (?, ?, 'running', ?, ?)`)
        .run(job.name, startedAt, trigger, startedAt + leaseMs).lastInsertRowid,
    );
    const heartbeat = setInterval(() => {
      this.db.prepare('UPDATE job_runs SET lease_expires_at = ? WHERE id = ?').run(this.clock.now() + leaseMs, jobRunId);
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    let status: RunResult['status'] = 'ok';
    let stats: Record<string, number> | undefined;
    let error: unknown;
    try {
      const out = await job.run({
        db: this.db,
        jobRunId,
        trigger,
        now: () => this.clock.now(),
        log: this.log,
        signal: this.abort.signal,
      });
      if (out && out.status) status = out.status;
      stats = out?.stats;
    } catch (e) {
      status = 'error';
      error = e;
    } finally {
      clearInterval(heartbeat);
    }

    const finishedAt = this.clock.now();
    const fields = error ? errorFields(error) : {};
    this.db
      .prepare(
        'UPDATE job_runs SET status = ?, finished_at = ?, lease_expires_at = NULL, stats = ?, error_class = ?, error_message = ? WHERE id = ?',
      )
      .run(
        status,
        finishedAt,
        stats ? JSON.stringify(stats) : null,
        fields.error_class ?? null,
        fields.error_message ? redact(fields.error_message) : null,
        jobRunId,
      );
    this.recordState(job, status, startedAt, finishedAt, fields.error_class ?? null);
    const durationMs = finishedAt - startedAt;
    if (error) this.log.error('job.failed', { job: job.name, ids: [jobRunId], duration_ms: durationMs, ...fields });
    else this.log.info('job.finished', { job: job.name, ids: [jobRunId], duration_ms: durationMs, counts: stats });
    return { job: job.name, status, jobRunId, durationMs, ...(fields.error_class ? { errorClass: fields.error_class } : {}) };
  }

  /** An occurrence whose catch-up window passed: logged as a 'skipped' run and marked handled, never executed. */
  private recordMissed(job: JobDef, occurrence: string, now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO job_runs (job, started_at, finished_at, status, trigger, stats) VALUES (?, ?, ?, 'skipped', 'schedule', ?)`,
        )
        .run(job.name, now, now, JSON.stringify({ missed_window: 1 }));
      this.db
        .prepare(
          `INSERT INTO job_state (job, last_run_at, last_success_local_date, next_due_at) VALUES (@job, @now, @date, NULL)
           ON CONFLICT(job) DO UPDATE SET last_run_at = @now, next_due_at = NULL,
             last_success_local_date = max(coalesce(last_success_local_date, @date), @date)`,
        )
        .run({ job: job.name, now, date: occurrence });
    })();
    this.log.info('job.missed_window', { job: job.name });
  }

  private recordState(job: JobDef, status: RunResult['status'], startedAt: number, finishedAt: number, errorClass: string | null): void {
    const prev = this.state(job.name);
    const failed = status === 'error';
    const failures = failed ? (prev?.consecutive_failures ?? 0) + 1 : 0;
    const base = job.backoffBaseMs ?? (job.schedule.kind === 'interval' ? job.schedule.everyMs : 5 * 60 * 1000);
    let nextDue: number | null;
    if (failed) nextDue = finishedAt + backoffDelay(base, failures);
    else nextDue = job.schedule.kind === 'interval' ? finishedAt + job.schedule.everyMs : null;
    // A run covers the latest occurrence at its start (a 23:59 run that ends after midnight still covers its day;
    // a manual run at 07:00 covers yesterday's 08:00 slot, not today's).
    const successDate = failed
      ? null
      : (latestOccurrence(job.schedule, startedAt, this.timeZone) ?? localParts(startedAt, this.timeZone).date);
    this.db
      .prepare(
        `INSERT INTO job_state (job, last_run_at, last_success_at, last_success_local_date, consecutive_failures, last_error_class, next_due_at)
         VALUES (@job, @ran, @success, @date, @failures, @err, @next)
         ON CONFLICT(job) DO UPDATE SET last_run_at = @ran,
           last_success_at = coalesce(@success, last_success_at),
           last_success_local_date = CASE WHEN @date IS NULL THEN last_success_local_date
             ELSE max(coalesce(last_success_local_date, @date), @date) END,
           consecutive_failures = @failures, last_error_class = @err, next_due_at = @next`,
      )
      .run({
        job: job.name,
        ran: startedAt,
        success: failed ? null : finishedAt,
        date: successDate,
        failures,
        err: errorClass,
        next: nextDue,
      });
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((j) => {
      const st = this.state(j.name);
      return {
        name: j.name,
        schedule: j.schedule,
        running: this.running.has(j.name),
        lastRunAt: st?.last_run_at ?? null,
        lastSuccessAt: st?.last_success_at ?? null,
        lastSuccessLocalDate: st?.last_success_local_date ?? null,
        consecutiveFailures: st?.consecutive_failures ?? 0,
        nextDueAt: st?.next_due_at ?? null,
        lastErrorClass: st?.last_error_class ?? null,
        disabled: Boolean(j.disabled || st?.disabled),
      };
    });
  }

  jobNames(): string[] {
    return [...this.jobs.keys()];
  }
}
