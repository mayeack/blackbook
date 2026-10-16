/**
 * Service-sender filter (intelligence §1.3). A service identity (short code, business chat, chatbot, spam, OTP or
 * marketing sender, Partiful) keeps its messages as episodes but never becomes a person: its identity gets
 * status 'service' and hangs off a people row with status 'service' (kind business/shortcode/bot), which
 * person_visible, ties, windows and reply debt all exclude.
 */
import type { DB } from '../db/connection';

export type ServiceReason =
  | 'shortcode'
  | 'business_chat'
  | 'chatbot'
  | 'spam'
  | 'noreply_email'
  | 'toll_free'
  | 'otp_marketing'
  | 'partiful';

/** Identity key as stored in identities(kind, key). */
export interface IdentityRef {
  kind: string;
  key: string;
}

/** Partiful's senders: verified iMessage business account, SMS short code, login-code number (toll-free). */
export const PARTIFUL_SENDERS: readonly IdentityRef[] = [
  { kind: 'business_chat', key: 'urn:biz:29896aa3-06a9-4b54-b544-5e113c222d08' },
  { kind: 'shortcode', key: '39781' },
  { kind: 'phone', key: '+18449460698' },
];

export const isPartifulSender = (r: IdentityRef): boolean => PARTIFUL_SENDERS.some((p) => p.kind === r.kind && p.key === r.key);

// The local-part alternatives must start the local part or follow a separator ("kevininfo@" is a person).
const NOREPLY_EMAIL = /(^|[._+-])(no-?reply|notifications?|alerts?|mailer|bounce|support|info)@|@(.*\.)?(partiful|partiful-mail)\.com$/i;
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;
const OTP = /\b\d{4,8}\b.{0,40}\b(code|passcode|verification|OTP|2FA)\b|\b(code|passcode)\b.{0,20}\b\d{4,8}\b/i;
const MARKETING = /reply stop|msg ?& ?data rates|unsubscribe|txt stop/i;
const LINK_ONLY = /^\s*(https?:\/\/|www\.)\S+\s*$/i;

export const isTollFree = (e164: string): boolean => TOLL_FREE.test(e164);

/** OTP, marketing boilerplate, or a bare link. */
export function isOtpOrMarketing(text: string | null): boolean {
  if (!text) return false;
  return OTP.test(text) || MARKETING.test(text) || LINK_ONLY.test(text);
}

/** Classification from the identity key alone. */
export function classifyIdentity(r: IdentityRef): ServiceReason | null {
  if (isPartifulSender(r)) return 'partiful';
  if (r.kind === 'shortcode') return 'shortcode';
  if (r.kind === 'business_chat') return 'business_chat';
  if (r.kind === 'email' && NOREPLY_EMAIL.test(r.key)) return 'noreply_email';
  return null;
}

/** Per-message signals: an Apple Messages for Business chatbot balloon, or chat.db's is_spam flag. */
export function messageServiceSignal(m: { balloon_bundle_id: string | null; is_spam: boolean }): ServiceReason | null {
  if (m.balloon_bundle_id && /chatbot/i.test(m.balloon_bundle_id)) return 'chatbot';
  if (m.is_spam) return 'spam';
  return null;
}

/** Messages I sent to this identity in 1:1 chats (the "I texted them" signal). */
export function messagesFromMeTo(db: DB, identityId: string): number {
  return db
    .prepare(
      `SELECT count(*) FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.identity_id = ?
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
       WHERE m.is_from_me = 1 AND m.is_bot = 0 AND m.kind NOT IN ('system','group_event')`,
    )
    .pluck()
    .get(identityId) as number;
}

/**
 * History rules: a toll-free number I have never texted, or ≥2 inbound 1:1 messages with nothing from me and ≥60% of
 * them OTP/marketing/link-only. Group posts don't count: a friend who only drops links in a group chat is a person.
 */
export function classifyByHistory(db: DB, identityId: string, r: IdentityRef): ServiceReason | null {
  if (messagesFromMeTo(db, identityId) > 0) return null;
  if (r.kind === 'phone' && isTollFree(r.key)) return 'toll_free';
  const texts = db
    .prepare(
      `SELECT m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.kind <> 'group'
       WHERE m.sender_identity_id = ? AND m.is_from_me = 0 AND m.kind NOT IN ('system','group_event')`,
    )
    .pluck()
    .all(identityId) as (string | null)[];
  if (texts.length < 2) return null;
  const hits = texts.filter(isOtpOrMarketing).length;
  return hits / texts.length >= 0.6 ? 'otp_marketing' : null;
}

/** people.kind for a service sender. */
export function serviceKind(reason: ServiceReason): 'shortcode' | 'business' | 'bot' {
  if (reason === 'shortcode') return 'shortcode';
  if (reason === 'chatbot') return 'bot';
  return 'business';
}
