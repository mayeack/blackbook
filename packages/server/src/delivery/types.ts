/**
 * Delivery contracts: the only ways yeackbot reaches the owner.
 *   - OutboundSender: iMessage TO SELF via the collector (POST /v1/imessage/send). Implemented in
 *     delivery/outbound.ts; tests use test/fakes/delivery.ts.
 *   - PushSender: Web Push (VAPID) to the owner's own subscribed PWA devices. Implemented in delivery/push.ts.
 *
 * HARD RULES (enforced in the implementation; the fakes enforce them too, so a caller that breaks one fails its
 * tests):
 *   1. Recipients are only the configured self handles (settings self_handles ∩ the collector's compiled list).
 *      There is no `to` parameter: sendToSelf picks the handle.
 *   2. Every outbound text starts with BOT_MARKER (U+1F168), checked on the RAW text (no trim/NFKC first).
 *   3. Every send is recorded in outbound_messages BEFORE the HTTP call, with text_hash =
 *      outboundTextHash(text) (adapters/imessage/mapping.ts) and client_ref, so the iMessage ingest recognizes
 *      the bot's own rows (GUID, marker, or hash within 30 s) and never parses them as commands.
 *   4. Links are allowlisted to yeackbot.com; no phone numbers, emails or sensitive facts in any text.
 *   5. Circuit breaker: > MAX_OUTBOUND_PER_HOUR sends in the last hour → 'blocked' (circuit_open). A brief is up to
 *      six texts (one per suggestion + one health text), so the cap leaves room for a brief, a test and replies.
 *   6. Digest delivery ships DISABLED (settings digest.enabled=false); quiet hours apply except to direct replies
 *      to the owner's own commands (bypassQuietHours).
 *   7. Conversation-starter drafts are never sent by any code path.
 *   8. Push bodies carry no names unless push.names_in_notifications, never sensitive content; a 404/410 from
 *      the push service removes the subscription.
 */
import type { PushPayload } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';

export { BOT_MARKER };

/** outbound_messages.purpose */
export type OutboundPurpose = 'digest' | 'reply' | 'alert' | 'brief' | 'answer' | 'heartbeat' | 'test' | 'events';

export const MAX_OUTBOUND_PER_HOUR = 30;
export const MAX_COMMANDS_PER_HOUR = 30;
/** The collector's own cap on one message. */
export const MAX_OUTBOUND_CHARS = 10_000;
/** iMessage Ask answers. */
export const MAX_ANSWER_CHARS = 600;
export const OUTBOUND_URL_ALLOWLIST: readonly string[] = ['yeackbot.com'];

export type OutboundStatus =
  /** collector outcomes (outbound_messages.status) */
  | 'delivered'
  | 'sent'
  | 'unverified'
  | 'ghost'
  | 'failed'
  /** refused before sending */
  | 'blocked'
  /** delivery not configured (no collector / no self handle) */
  | 'disabled'
  /** this clientRef was already sent: the earlier result is returned, nothing is re-sent */
  | 'duplicate';

export type OutboundBlockReason =
  | 'no_marker'
  | 'url_not_allowed'
  | 'contains_identifier'
  | 'too_long'
  | 'circuit_open'
  | 'quiet_hours'
  | 'no_self_handle'
  | 'collector_unavailable';

export interface OutboundOptions {
  digestId?: string | null;
  /** The digest item this text carries (one text per suggestion), so an inline reply can act on that item. */
  digestOrdinal?: number | null;
  /** Direct replies to the owner's own command go out during quiet hours. */
  bypassQuietHours?: boolean;
}

export interface OutboundResult {
  status: OutboundStatus;
  /** outbound_messages.id (null when refused before a row was written). */
  outboundId: string | null;
  guids: string[];
  reason?: OutboundBlockReason;
}

export interface OutboundSender {
  /** A collector + self handle are configured. */
  readonly configured: boolean;
  /**
   * Texts the owner (self-thread). `clientRef` is a UUID and the idempotency key: the same ref never sends twice.
   * Never throws for delivery outcomes.
   */
  sendToSelf(text: string, purpose: OutboundPurpose, clientRef: string, options?: OutboundOptions): Promise<OutboundResult>;
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendResult =
  | { ok: true; statusCode: number }
  /** gone = 404/410: the subscription is dead (delete it; the PWA resubscribes). */
  | { ok: false; gone: boolean; statusCode: number | null; error: string };

export interface PushSender {
  /** VAPID keys are configured. */
  readonly configured: boolean;
  readonly publicKey: string | null;
  send(target: PushTarget, payload: PushPayload, options?: { ttlSeconds?: number; urgency?: 'low' | 'normal' | 'high' }): Promise<PushSendResult>;
}

// ---------------------------------------------------------------------------------------------- text rules

const URL_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** Formatted NANP / E.164 shapes, and bare 10–11 digit runs ("2125550199"). */
const PHONE_RE = /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|\b\d{10,11}\b/;
/** Explicit links (a scheme or www.): their real host is checked, IP literals included. */
export const EXPLICIT_LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
/** A bare IPv4 literal (data detectors make it tappable). */
export const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/** yeackbot.com or a subdomain (never an IP literal). */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return OUTBOUND_URL_ALLOWLIST.some((ok) => h === ok || h.endsWith(`.${ok}`));
}

/** The hostname of an explicit link ("https://…", "www.…"), or null when it doesn't parse. */
export function linkHost(link: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`).hostname;
  } catch {
    return null;
  }
}

/** Problems with an outbound text (empty = OK to send). Pure; the sender and the fakes both apply it. */
export function checkOutboundText(text: string): OutboundBlockReason[] {
  const problems: OutboundBlockReason[] = [];
  if (!text.startsWith(BOT_MARKER)) problems.push('no_marker');
  if (text.length > MAX_OUTBOUND_CHARS) problems.push('too_long');
  if (EMAIL_RE.test(text) || PHONE_RE.test(text)) problems.push('contains_identifier');
  const withoutEmails = text.replace(new RegExp(EMAIL_RE.source, 'g'), '');
  const badLink =
    [...withoutEmails.matchAll(URL_RE)].some((m) => !isAllowedHost(m[1]!)) ||
    [...withoutEmails.matchAll(EXPLICIT_LINK_RE)].some((m) => {
      const host = linkHost(m[0]);
      return !host || !isAllowedHost(host);
    }) ||
    new RegExp(IPV4_RE.source).test(withoutEmails);
  if (badLink) problems.push('url_not_allowed');
  return problems;
}

const DOMAIN_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

/**
 * Removes links a domain-based URL filter can't see: explicit links whose host is an IP literal (or doesn't parse)
 * and bare IPv4 literals. Links to named domains are left for the caller's own allowlist handling.
 */
export function stripIpLinks(text: string, replacement = ''): string {
  return text
    .replace(EXPLICIT_LINK_RE, (m) => {
      const host = linkHost(m);
      return host && DOMAIN_HOST.test(host) ? m : replacement;
    })
    .replace(IPV4_RE, replacement);
}

/**
 * Removes every link an outbound text may not carry: explicit links whose host isn't yeackbot.com (IP literals
 * too) and bare IPv4 literals. Bare domains are left to the callers' own URL handling.
 */
export function stripDisallowedLinks(text: string, replacement = ''): string {
  return text
    .replace(EXPLICIT_LINK_RE, (m) => {
      const host = linkHost(m);
      return host && isAllowedHost(host) ? m : replacement;
    })
    .replace(IPV4_RE, replacement);
}
