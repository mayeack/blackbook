/**
 * Pure WhatsApp for Mac → episode mapping rules (no I/O). The Mac app is the iOS app under Catalyst, so its stores
 * are the iOS Core Data layout: Z-prefixed tables, Z_PK joins, dates in seconds since 2001-01-01.
 */
import crypto from 'node:crypto';
import { looksLikePhone } from '@yb/shared';
import type { EpisodeMessageKind } from '../common/episodes';
import { URL_ONLY } from '../imessage/mapping';

export const SOURCE = 'whatsapp';

/** Core Data reference date (2001-01-01T00:00:00Z) in Unix seconds. */
export const CORE_DATA_EPOCH_S = 978_307_200;

/** Core Data seconds (REAL) → Unix ms; null for a missing or non-finite value. */
export function coreDataToMs(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round((v + CORE_DATA_EPOCH_S) * 1000);
}

export const msToCoreData = (ms: number): number => ms / 1000 - CORE_DATA_EPOCH_S;

/** ZWACHATSESSION.ZSESSIONTYPE: 0 direct, 1 group (2 broadcast lists and 3 status updates are never ingested). */
export const SESSION_DIRECT = 0;
export const SESSION_GROUP = 1;

const USER_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'lid']);
const SKIPPED_JID = /(@broadcast|@newsletter|@call)$|^status@/;

/** The conversation kind of a chat session, or null when it is broadcast/status/channel or malformed. */
export function chatKind(sessionType: number | null, jid: string | null | undefined): 'direct' | 'group' | null {
  const j = jid?.trim().toLowerCase();
  if (!j || SKIPPED_JID.test(j)) return null;
  const server = j.slice(j.lastIndexOf('@') + 1);
  if (sessionType === SESSION_DIRECT) return USER_SERVERS.has(server) && parseUserJid(j) ? 'direct' : null;
  if (sessionType === SESSION_GROUP) return server === 'g.us' ? 'group' : null;
  return null;
}

export type UserJid = { kind: 'phone'; digits: string } | { kind: 'lid'; digits: string };

/** "user[.agent][:device]@server" for a person (phone JID or LID); null for groups, broadcasts and junk. */
export function parseUserJid(raw: string | null | undefined): UserJid | null {
  const s = raw?.normalize('NFKC').trim().toLowerCase();
  if (!s) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const server = s.slice(at + 1);
  const m = /^\+?(\d{3,20})(?:[.:]\d+)*$/.exec(s.slice(0, at));
  if (!m) return null;
  if (server === 'lid') return { kind: 'lid', digits: m[1]! };
  if (server === 's.whatsapp.net' || server === 'c.us') return { kind: 'phone', digits: m[1]! };
  return null;
}

export const phoneJid = (digits: string): string => `${digits}@s.whatsapp.net`;
export const lidJid = (digits: string): string => `${digits}@lid`;

/** A LID as the LID / Contacts stores keep it ("123…" or "123…@lid") → its digits. */
export function lidDigits(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) {
    const j = parseUserJid(s);
    return j?.kind === 'lid' ? j.digits : null;
  }
  return /^\d{3,20}$/.test(s) ? s : null;
}

/**
 * An international phone number as the LID store keeps it ("+15125550101", "15125550101", or a phone JID) →
 * digits. Formatted local numbers (ContactsV2.ZPHONENUMBER) are not accepted: they lack the country code.
 */
export function internationalDigits(raw: string | null | undefined): string | null {
  const s = raw?.normalize('NFKC').trim();
  if (!s) return null;
  if (s.includes('@')) {
    const j = parseUserJid(s);
    return j?.kind === 'phone' ? j.digits : null;
  }
  const m = /^\+?(\d{7,15})$/.exec(s.replace(/[\s().-]/g, ''));
  return m ? m[1]! : null;
}

// ---------- message types ----------

/** ZWAMESSAGE.ZMESSAGETYPE codes for media (stored as an attachment of that kind; no paths, no media). */
const MEDIA: Readonly<Record<number, string>> = {
  1: 'image',
  2: 'video',
  3: 'audio',
  4: 'contact',
  5: 'location',
  8: 'document',
  11: 'gif',
};

export interface MappedKind {
  kind: EpisodeMessageKind;
  /** Attachment kind for media rows (image, video, …), else null. */
  attachment: string | null;
  /** "This message was deleted". */
  retracted: boolean;
  /** false: a type code this table doesn't know (counted per code so a live run can extend the table). */
  known: boolean;
}

const mk = (kind: EpisodeMessageKind, o: Partial<Omit<MappedKind, 'kind'>> = {}): MappedKind => ({
  kind,
  attachment: o.attachment ?? null,
  retracted: o.retracted ?? false,
  known: o.known ?? true,
});

/**
 * Message kind from ZMESSAGETYPE / ZGROUPEVENTTYPE. Codes: 0 text, 1 image, 2 video, 3 audio, 4 contact card,
 * 5 location, 6 system (group events, security notices), 7 link, 8 document, 11 GIF, 14 deleted, 15 sticker.
 * Published exporters disagree on 14/15 (one table lists 14 as poll and 15 as system), so a group-event type always
 * wins, and a 14 that still carries text is treated as a poll. Unknown codes are text when they carry text and
 * system otherwise, so they never invent activity.
 */
export function messageKind(type: number | null, groupEventType: number | null, hasText: boolean): MappedKind {
  if (groupEventType !== null && groupEventType > 0) return mk('system');
  if (type === null) return mk(hasText ? 'text' : 'system', { known: false });
  const media = MEDIA[type];
  if (media) return mk('attachment', { attachment: media });
  switch (type) {
    case 0:
      return mk(hasText ? 'text' : 'system');
    case 6:
      return mk('system');
    case 7:
      return mk('link');
    case 14:
      return hasText ? mk('poll') : mk('text', { retracted: true });
    case 15:
      return mk('sticker');
    default:
      return mk(hasText ? 'text' : 'system', { known: false });
  }
}

/** Text kept for a row: none for system rows; a bare URL in a text row makes it a link. */
export function messageText(kind: EpisodeMessageKind, raw: string | null): { kind: EpisodeMessageKind; text: string | null } {
  if (kind === 'system') return { kind, text: null };
  const text = raw?.trim() ? raw.trim() : null;
  if (kind === 'text' && text !== null && URL_ONLY.test(text)) return { kind: 'link', text };
  return { kind, text };
}

/**
 * messages.source_msg_id: '{chat_jid}:{ZSTANZAID}'. Z_PK is not stable across a re-link, so a row without a stanza
 * id is keyed by a hash of what does survive one (time, type, direction, sender, text).
 */
export function sourceMsgId(
  chatJid: string,
  stanza: string | null,
  row: { sentAt: number; type: number | null; fromMe: boolean; memberJid: string | null; text: string | null },
): string {
  const s = stanza?.trim();
  if (s) return `${chatJid}:${s}`;
  const h = crypto
    .createHash('sha256')
    .update(`${row.sentAt}|${row.type ?? ''}|${row.fromMe ? 1 : 0}|${row.memberJid ?? ''}|${row.text ?? ''}`)
    .digest('base64url')
    .slice(0, 20);
  return `${chatJid}:~${h}`;
}

// ---------- names ----------

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
/** ZWAMESSAGE.ZPUSHNAME / ZWAGROUPMEMBER.ZFIRSTNAME hold base64 protobuf; never take one of those for a name. */
const BASE64ISH = /^[A-Za-z0-9+/]{20,}={0,2}$/;

/** A usable display name, or null for blanks, phone numbers, JIDs and base64 blobs. */
export function cleanWaName(raw: string | null | undefined): string | null {
  const t = raw?.normalize('NFKC').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (looksLikePhone(t) || t.includes('@')) return null;
  if (BASE64ISH.test(t) && /[0-9+/]/.test(t)) return null;
  return t.slice(0, 200);
}

/** Where a WhatsApp name came from, best first: the phone's address book, the chat title, the self-chosen pushname. */
export const NAME_KINDS = ['contact', 'partner', 'push'] as const;
export type NameKind = (typeof NAME_KINDS)[number];

/**
 * All three rank as NAME_PRECEDENCE 'whatsapp'; within it the newest observation wins, so a pass stamps them a
 * millisecond apart (contact newest) to keep that order without a schema change.
 */
export const nameAt = (now: number, kind: NameKind): number => now - NAME_KINDS.indexOf(kind);
