/**
 * The collector-backed OutboundSender (delivery/types.ts): the ONLY code that texts anyone, and it texts only the
 * owner. Order of a send (rules 1–6 in delivery/types.ts):
 *   1. clientRef idempotency: a ref already recorded returns its earlier result ('duplicate'), except a send that
 *      provably never got an answer from the collector (unreachable / timed out / 5xx / still "sending" after
 *      2 min), which is retried with the SAME ref (the collector dedupes per client_ref too);
 *   2. text rules on the RAW text (marker U+1F168 first, yeackbot.com-only links, no phones/emails, ≤10k chars);
 *   3. recipient = the primary self handle (first phone of settings self_handles, else the first email). There is
 *      no `to` parameter; the collector refuses anything outside its compiled allowlist a second time;
 *   4. quiet hours (settings quiet_hours, tz) unless bypassQuietHours (direct replies to the owner's commands);
 *   5. circuit breaker: ≥ MAX_OUTBOUND_PER_HOUR rows in the last hour → blocked;
 *   6. the outbound_messages row (status 'sending', text_hash = outboundTextHash(raw text), client_ref) is written
 *      BEFORE the HTTP call, so the iMessage tail recognizes the bot's own row even before its GUIDs are known;
 *   7. POST {collector}/v1/imessage/send, then the row gets the collector's status + GUIDs (outbound_guids).
 * Never logs text, handles or tokens: ids, statuses and counts only. Never throws for delivery outcomes.
 */
import fs from 'node:fs/promises';
import { localParts, uuidv7 } from '@yb/shared';
import { COLLECTOR_ROUTES, CollectorError, SendRequest, SendResponse } from '@yb/shared/collector/v1';
import { Agent, request, type Dispatcher } from 'undici';
import { z } from 'zod';
import { outboundTextHash } from '../adapters/imessage/mapping';
import type { DB } from '../db/connection';
import { handleKey } from '../identity/resolver';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { inLocalWindow, readSetting, settingsSnapshot } from '../settings/registry';
import {
  checkOutboundText,
  MAX_OUTBOUND_PER_HOUR,
  type OutboundOptions,
  type OutboundPurpose,
  type OutboundResult,
  type OutboundSender,
  type OutboundStatus,
} from './types';

export interface OutboundSenderOptions {
  db: DB;
  /** Collector base URL + bearer token file (null = no collector configured). */
  collector: { url: string; tokenFile: string } | null;
  log?: Logger;
  /** undici dispatcher (tests pass a MockAgent). Defaults to a private keep-alive Agent. */
  dispatcher?: Dispatcher;
  now?: () => number;
  /** How long the collector waits for chat.db to show the sent row (collector default 8000). */
  verifyTimeoutMs?: number;
  /** Whole-request timeout (default 30 s: verification + AppleScript). */
  timeoutMs?: number;
}

export const disabledOutboundSender: OutboundSender = {
  configured: false,
  sendToSelf: async () => ({ status: 'disabled', outboundId: null, guids: [], reason: 'collector_unavailable' }),
};

const HOUR_MS = 3_600_000;
/** A row still 'sending' this long after it started never got an answer: safe to retry with the same ref. */
const STALE_SENDING_MS = 2 * 60_000;
const ClientRef = z.uuid();

/**
 * The handle the owner is texted at: the first phone in settings self_handles (normalized to E.164), else the first
 * email. Null when `npm run setup:self` hasn't run. PII: never log or return it from an API.
 */
export function primarySelfHandle(db: DB): string | null {
  const raw = readSetting(db, 'self_handles');
  const keys = raw.map((h) => handleKey(h)).filter((k) => k !== null && k.confidence === 1);
  return keys.find((k) => k!.kind === 'phone')?.key ?? keys.find((k) => k!.kind === 'email')?.key ?? null;
}

/** Whether `now` falls in the owner's quiet hours (settings quiet_hours, local to settings tz). */
export function inQuietHours(db: DB, now: number): boolean {
  const s = settingsSnapshot(db);
  return inLocalWindow(localParts(now, s.tz).hhmm, s.quiet_hours.start, s.quiet_hours.end);
}

/** Outbound rows written in the hour before `now` (the circuit breaker's count). */
export function outboundLastHour(db: DB, now: number): number {
  return db.prepare('SELECT count(*) FROM outbound_messages WHERE created_at > ?').pluck().get(now - HOUR_MS) as number;
}

interface OutboundRow {
  id: string;
  status: string;
  message_guids: string | null;
  collector_result: string | null;
  created_at: number;
}

/** collector_result JSON: statuses and codes only, never text. */
interface CollectorResultNote {
  status: string;
  errorCode?: string | null;
  /** The collector never answered (unreachable, timeout, 5xx): re-sending with the same client_ref is safe. */
  retryable?: boolean;
  rowids?: number;
  httpStatus?: number;
}

const guidsOf = (row: OutboundRow): string[] => {
  try {
    const v = row.message_guids ? (JSON.parse(row.message_guids) as unknown) : [];
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
};

const noteOf = (row: OutboundRow): CollectorResultNote | null => {
  try {
    return row.collector_result ? (JSON.parse(row.collector_result) as CollectorResultNote) : null;
  } catch {
    return null;
  }
};

const SENT_STATUSES = new Set(['delivered', 'sent', 'unverified', 'ghost', 'failed']);

type HttpOutcome =
  | { kind: 'response'; status: OutboundStatus; guids: string[]; note: CollectorResultNote }
  | { kind: 'error'; note: CollectorResultNote; reason?: OutboundResult['reason'] };

export class CollectorOutboundSender implements OutboundSender {
  private token: string | null = null;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly log: Logger;
  private readonly base: string;

  constructor(private readonly o: OutboundSenderOptions & { collector: { url: string; tokenFile: string } }) {
    this.base = o.collector.url.replace(/\/+$/, '');
    this.ownsDispatcher = !o.dispatcher;
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 2 });
    this.log = o.log ?? nullLogger;
  }

  /** A collector is configured and setup:self recorded a handle to text. */
  get configured(): boolean {
    return primarySelfHandle(this.o.db) !== null;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async sendToSelf(text: string, purpose: OutboundPurpose, clientRef: string, options: OutboundOptions = {}): Promise<OutboundResult> {
    if (!ClientRef.safeParse(clientRef).success) throw new TypeError('clientRef must be a UUID');
    const db = this.o.db;
    const now = this.now();

    // 1. idempotency
    const earlier = db.prepare('SELECT id, status, message_guids, collector_result, created_at FROM outbound_messages WHERE client_ref = ?').get(clientRef) as
      | OutboundRow
      | undefined;
    let retryId: string | null = null;
    if (earlier) {
      const note = noteOf(earlier);
      const neverAnswered =
        (earlier.status === 'failed' && note?.retryable === true) ||
        ((earlier.status === 'sending' || earlier.status === 'queued') && now - earlier.created_at > STALE_SENDING_MS);
      if (!neverAnswered) {
        const status: OutboundStatus = 'duplicate';
        return { status, outboundId: earlier.id, guids: guidsOf(earlier) };
      }
      retryId = earlier.id;
    }

    // 2. text rules (raw text: no trim / normalization first)
    const problems = checkOutboundText(text);
    if (problems.length) {
      this.log.warn('outbound.blocked', { counts: { [problems[0]!]: 1 } });
      return { status: 'blocked', outboundId: null, guids: [], reason: problems[0] };
    }
    // 3. recipient
    const to = primarySelfHandle(db);
    if (!to) return { status: 'disabled', outboundId: null, guids: [], reason: 'no_self_handle' };
    // 4. quiet hours
    if (!options.bypassQuietHours && inQuietHours(db, now)) return { status: 'blocked', outboundId: null, guids: [], reason: 'quiet_hours' };
    // 5. circuit breaker (a retry reuses its row, so it doesn't count twice)
    if (!retryId && outboundLastHour(db, now) >= MAX_OUTBOUND_PER_HOUR) {
      this.log.warn('outbound.circuit_open', { counts: { last_hour: MAX_OUTBOUND_PER_HOUR } });
      return { status: 'blocked', outboundId: null, guids: [], reason: 'circuit_open' };
    }

    // 6. the row BEFORE the HTTP call
    const id = retryId ?? uuidv7(now);
    const hash = outboundTextHash(text);
    if (retryId) {
      db.prepare(
        `UPDATE outbound_messages SET status = 'sending', to_handle = ?, text_hash = ?, created_at = ?, collector_result = NULL,
           digest_id = coalesce(?, digest_id), digest_ordinal = coalesce(?, digest_ordinal) WHERE id = ?`,
      ).run(
        to,
        hash,
        now,
        options.digestId ?? null,
        options.digestOrdinal ?? null,
        id,
      );
    } else {
      const inserted = db
        .prepare(
          `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, digest_id, digest_ordinal, created_at)
           VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?) ON CONFLICT (client_ref) DO NOTHING`,
        )
        .run(id, clientRef, purpose, to, hash, options.digestId ?? null, options.digestOrdinal ?? null, now);
      if (!inserted.changes) {
        // A concurrent send with the same ref got there first: that one is the send.
        const other = db.prepare('SELECT id, message_guids FROM outbound_messages WHERE client_ref = ?').get(clientRef) as OutboundRow;
        return { status: 'duplicate', outboundId: other.id, guids: guidsOf(other) };
      }
    }

    // 7. the collector
    const outcome = await this.post({ to, text, client_ref: clientRef, verify_timeout_ms: this.o.verifyTimeoutMs ?? 8000 });
    const done = this.now();
    if (outcome.kind === 'error') {
      db.prepare(`UPDATE outbound_messages SET status = 'failed', collector_result = ? WHERE id = ?`).run(JSON.stringify(outcome.note), id);
      this.log.warn('outbound.failed', { ids: [id], error_code: outcome.note.errorCode ?? outcome.note.status });
      return { status: 'failed', outboundId: id, guids: [], reason: outcome.reason ?? 'collector_unavailable' };
    }
    const sent = outcome.status === 'delivered' || outcome.status === 'sent' || outcome.status === 'unverified';
    db.transaction(() => {
      db.prepare('UPDATE outbound_messages SET status = ?, message_guids = ?, collector_result = ?, sent_at = ? WHERE id = ?').run(
        outcome.status,
        JSON.stringify(outcome.guids),
        JSON.stringify(outcome.note),
        sent ? done : null,
        id,
      );
      const ins = db.prepare('INSERT OR IGNORE INTO outbound_guids (guid, outbound_id) VALUES (?, ?)');
      for (const g of outcome.guids) ins.run(g, id);
    })();
    this.log.info(`outbound.${outcome.status}`, { ids: [id], counts: { guids: outcome.guids.length } });
    return { status: outcome.status, outboundId: id, guids: outcome.guids };
  }

  private async readToken(): Promise<string | null> {
    try {
      const token = (await fs.readFile(this.o.collector.tokenFile, 'utf8')).trim();
      this.token = token || null;
      return this.token;
    } catch {
      return null;
    }
  }

  private async post(body: z.input<typeof SendRequest>): Promise<HttpOutcome> {
    const payload = JSON.stringify(SendRequest.parse(body));
    const attempt = async (token: string) =>
      request(`${this.base}${COLLECTOR_ROUTES.imessageSend}`, {
        method: 'POST',
        dispatcher: this.dispatcher,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: payload,
        headersTimeout: this.o.timeoutMs ?? 30_000,
        bodyTimeout: this.o.timeoutMs ?? 30_000,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    let token = this.token ?? (await this.readToken());
    if (!token) return { kind: 'error', note: { status: 'token_missing', retryable: true }, reason: 'collector_unavailable' };
    let res: Dispatcher.ResponseData;
    try {
      res = await attempt(token);
      if (res.statusCode === 401) {
        await res.body.dump();
        token = await this.readToken();
        if (!token) return { kind: 'error', note: { status: 'token_missing', retryable: true }, reason: 'collector_unavailable' };
        res = await attempt(token);
      }
    } catch (e) {
      const f = errorFields(e);
      // Nothing came back: the collector may or may not have sent. Retrying with the same client_ref is safe.
      return { kind: 'error', note: { status: 'unreachable', errorCode: f.error_code ?? f.error_class ?? null, retryable: true }, reason: 'collector_unavailable' };
    }
    let json: unknown = null;
    try {
      const raw = await res.body.text();
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const err = CollectorError.safeParse(json);
      const code = err.success ? err.data.error.code : `http_${res.statusCode}`;
      const retryable = res.statusCode >= 500 || res.statusCode === 401;
      return {
        kind: 'error',
        note: { status: 'http_error', errorCode: code, httpStatus: res.statusCode, retryable },
        reason: code === 'recipient_not_allowed' ? 'no_self_handle' : 'collector_unavailable',
      };
    }
    const parsed = SendResponse.safeParse(json);
    if (!parsed.success) return { kind: 'error', note: { status: 'contract_broken', httpStatus: res.statusCode, retryable: false } };
    const r = parsed.data;
    const status: OutboundStatus = SENT_STATUSES.has(r.status) ? r.status : 'failed';
    return {
      kind: 'response',
      status,
      guids: r.message_guids.filter(Boolean),
      note: { status: r.status, errorCode: r.error_code, rowids: r.rowids.length },
    };
  }

  async close(): Promise<void> {
    if (this.ownsDispatcher) await this.dispatcher.close();
  }
}

/** The sender for this config: inert ('disabled') without a collector. */
export function createOutboundSender(o: OutboundSenderOptions): OutboundSender {
  if (!o.collector) return disabledOutboundSender;
  return new CollectorOutboundSender({ ...o, collector: o.collector });
}
