/**
 * PII-safe structured logs: JSONL in $DATA/logs/server-YYYY-MM-DD.jsonl (14-day retention). Only allow-listed
 * fields are written; free text (error messages) goes through redact(). Never log message text, names, handles,
 * phones, emails, prompts, LLM output, request bodies, query strings or tokens. console.* is banned in src/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { localDate } from '@yb/shared';
import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  job?: string;
  run_id?: string;
  batch_id?: string;
  /** uuids / integer ids only */
  ids?: (string | number)[];
  counts?: Record<string, number>;
  duration_ms?: number;
  error_class?: string;
  error_code?: string;
  /** an upstream API's request id (Anthropic `req_…`), never a message */
  request_id?: string;
  /** redacted + truncated before writing */
  error_message?: string;
  /** access log: method, route PATTERN (never the raw URL), status */
  method?: string;
  route?: string;
  status?: number;
}

export interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,12}|[a-z]{1,4}:\d{1,12})$/i;
const TOKEN_RE = /^[a-z0-9_.:/-]{1,80}$/i;
const REQUEST_ID_RE = /^req_[A-Za-z0-9]{1,64}$/;

/** Keeps allow-listed fields with safe shapes; everything else is dropped. */
export function sanitize(level: LogLevel, event: string, fields: LogFields = {}, now = Date.now()): LogRecord {
  const rec: LogRecord = { ts: new Date(now).toISOString(), level, event: TOKEN_RE.test(event) ? event : 'invalid_event' };
  const token = (v: unknown) => (typeof v === 'string' && TOKEN_RE.test(v) ? v : undefined);
  if (token(fields.job)) rec.job = fields.job;
  if (typeof fields.run_id === 'string' && ID_RE.test(fields.run_id)) rec.run_id = fields.run_id;
  if (typeof fields.batch_id === 'string' && ID_RE.test(fields.batch_id)) rec.batch_id = fields.batch_id;
  if (Array.isArray(fields.ids)) {
    const ids = fields.ids.filter((v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && ID_RE.test(v)));
    if (ids.length) rec.ids = ids.slice(0, 50);
  }
  if (fields.counts && typeof fields.counts === 'object') {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(fields.counts)) if (TOKEN_RE.test(k) && Number.isFinite(v)) counts[k] = v;
    if (Object.keys(counts).length) rec.counts = counts;
  }
  if (Number.isFinite(fields.duration_ms)) rec.duration_ms = Math.round(fields.duration_ms!);
  if (token(fields.error_class)) rec.error_class = fields.error_class;
  if (token(fields.error_code)) rec.error_code = fields.error_code;
  if (typeof fields.request_id === 'string' && REQUEST_ID_RE.test(fields.request_id)) rec.request_id = fields.request_id;
  if (fields.error_message !== undefined) rec.error_message = redact(fields.error_message);
  if (token(fields.method)) rec.method = fields.method;
  if (token(fields.route)) rec.route = fields.route;
  if (Number.isInteger(fields.status)) rec.status = fields.status;
  return rec;
}

export type LogSink = (rec: LogRecord) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(sinks: LogSink[], minLevel: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel) => (event: string, fields?: LogFields) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const rec = sanitize(level, event, fields);
    for (const s of sinks) {
      try {
        s(rec);
      } catch {
        // a failing sink must never take the server down
      }
    }
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Appends to server-<local date>.jsonl in dir (0600 files). */
export function fileSink(dir: string, timeZone?: string): LogSink {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return (rec) => {
    const file = path.join(dir, `server-${localDate(Date.parse(rec.ts), timeZone)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  };
}

export const stderrSink: LogSink = (rec) => {
  process.stderr.write(`${JSON.stringify(rec)}\n`);
};

export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((rec: LogRecord) => void records.push(rec)) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}

export const nullLogger: Logger = createLogger([]);

/** Deletes log files older than keepDays (by the date in the file name). */
export function pruneLogs(dir: string, keepDays = 14, now = Date.now()): string[] {
  if (!fs.existsSync(dir)) return [];
  const cutoff = localDate(now - keepDays * 86_400_000);
  const removed: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^server-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1]! < cutoff) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}

/** Error → loggable fields: class name + code + redacted message. */
export function errorFields(e: unknown): LogFields {
  const err = e as { name?: string; code?: unknown; message?: string };
  return {
    error_class: typeof err?.name === 'string' ? err.name : 'Error',
    error_code: typeof err?.code === 'string' ? err.code : undefined,
    error_message: err?.message ?? String(e),
  };
}
