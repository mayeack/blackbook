/**
 * Fake delivery for tests: nothing is ever sent anywhere.
 *
 * FakeOutboundSender enforces the same hard rules as the real sender (marker on the raw text, yeackbot.com-only
 * links, no phones/emails, circuit breaker, clientRef idempotency), records every accepted text in `sent`, and —
 * with a db — writes the outbound_messages row (text_hash = outboundTextHash) the way the real sender does, so
 * the iMessage ingest's bot-row detection can be exercised end to end.
 *
 * FakePushSender records payloads; `fail(endpoint, 410)` makes a subscription "gone".
 */
import { uuidv7, type PushPayload } from '@yb/shared';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import type { DB } from '../../src/db/connection';
import {
  checkOutboundText,
  MAX_OUTBOUND_PER_HOUR,
  type OutboundOptions,
  type OutboundPurpose,
  type OutboundResult,
  type OutboundSender,
  type OutboundStatus,
  type PushSendResult,
  type PushSender,
  type PushTarget,
} from '../../src/delivery/types';

export interface SentText {
  text: string;
  purpose: OutboundPurpose;
  clientRef: string;
  options: OutboundOptions;
  outboundId: string;
  at: number;
}

export interface FakeOutboundOptions {
  /** Write outbound_messages / outbound_guids rows like the real sender. */
  db?: DB;
  /** The collector's answer (default 'delivered'). */
  status?: Exclude<OutboundStatus, 'blocked' | 'disabled' | 'duplicate'>;
  /** false = no collector / self handle configured: every send answers 'disabled'. */
  configured?: boolean;
  /** The (synthetic) self handle recorded as to_handle. */
  selfHandle?: string;
  now?: () => number;
}

export class FakeOutboundSender implements OutboundSender {
  readonly configured: boolean;
  readonly sent: SentText[] = [];
  readonly refused: { text: string; reasons: string[] }[] = [];
  private readonly byRef = new Map<string, OutboundResult>();
  private guidSeq = 0;

  constructor(private readonly o: FakeOutboundOptions = {}) {
    this.configured = o.configured ?? true;
  }

  async sendToSelf(text: string, purpose: OutboundPurpose, clientRef: string, options: OutboundOptions = {}): Promise<OutboundResult> {
    const now = this.o.now?.() ?? Date.now();
    if (!this.configured) return { status: 'disabled', outboundId: null, guids: [], reason: 'collector_unavailable' };
    const earlier = this.byRef.get(clientRef);
    if (earlier) return { ...earlier, status: 'duplicate' };
    const problems = checkOutboundText(text);
    if (problems.length) {
      this.refused.push({ text, reasons: problems });
      return { status: 'blocked', outboundId: null, guids: [], reason: problems[0] };
    }
    if (this.sent.filter((s) => s.at > now - 3_600_000).length >= MAX_OUTBOUND_PER_HOUR) {
      return { status: 'blocked', outboundId: null, guids: [], reason: 'circuit_open' };
    }
    const outboundId = uuidv7(now);
    const status = this.o.status ?? 'delivered';
    const guids = status === 'failed' || status === 'ghost' ? [] : [`FAKE-GUID-${++this.guidSeq}`];
    if (this.o.db) {
      this.o.db
        .prepare(
          `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, message_guids, digest_id, digest_ordinal, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          outboundId,
          clientRef,
          purpose,
          this.o.selfHandle ?? 'self@example.com',
          outboundTextHash(text),
          status,
          JSON.stringify(guids),
          options.digestId ?? null,
          options.digestOrdinal ?? null,
          now,
          now,
        );
      for (const g of guids) this.o.db.prepare('INSERT INTO outbound_guids (guid, outbound_id) VALUES (?, ?)').run(g, outboundId);
    }
    this.sent.push({ text, purpose, clientRef, options, outboundId, at: now });
    const result: OutboundResult = { status, outboundId, guids };
    this.byRef.set(clientRef, result);
    return result;
  }
}

export class FakePushSender implements PushSender {
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly sent: { target: PushTarget; payload: PushPayload }[] = [];
  private readonly failures = new Map<string, number>();

  constructor(o: { configured?: boolean; publicKey?: string } = {}) {
    this.configured = o.configured ?? true;
    this.publicKey = this.configured ? (o.publicKey ?? 'BFakeVapidPublicKeyForTestsOnly') : null;
  }

  /** Make every send to `endpoint` fail with `statusCode` (404/410 = gone). */
  fail(endpoint: string, statusCode: number): this {
    this.failures.set(endpoint, statusCode);
    return this;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushSendResult> {
    if (!this.configured) return { ok: false, gone: false, statusCode: null, error: 'not_configured' };
    const code = this.failures.get(target.endpoint);
    if (code) return { ok: false, gone: code === 404 || code === 410, statusCode: code, error: `push service answered ${code}` };
    this.sent.push({ target, payload });
    return { ok: true, statusCode: 201 };
  }
}
