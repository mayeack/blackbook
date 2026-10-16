/**
 * Pure Beeper → episode mapping rules (no I/O): which accounts are Instagram, the Instagram id inside a Beeper user
 * id, message kinds and attachment metadata, and the natural keys of messages and reactions.
 */
import type { EpisodeMessageKind } from '../common/episodes';
import { URL_ONLY } from '../imessage/mapping';
import type { BeeperAccount, BeeperMessage } from './schemas';

/** messages.source / conversations.source / identities.source for everything this adapter writes. */
export const SOURCE = 'instagram';

/**
 * Instagram accounts only. The owner's Beeper also carries iMessage (read from chat.db instead) and may carry
 * WhatsApp (read from the official app instead): neither, nor any other network, is ever ingested here.
 */
export function isInstagramAccount(a: Pick<BeeperAccount, 'accountID' | 'network' | 'bridge'>): boolean {
  const network = (a.network ?? '').trim().toLowerCase();
  const type = (a.bridge?.type ?? '').trim().toLowerCase();
  if (/whatsapp|imessage|sms/.test(`${network} ${type} ${a.accountID.toLowerCase()}`)) return false;
  return network === 'instagram' || type === 'instagram' || type === 'instagramgo' || /^(local-)?instagram(go)?[._-]/i.test(a.accountID);
}

/**
 * The numeric Instagram user id inside a Beeper user id ("@instagramgo_<digits>:<server>", or the account's bare
 * "<digits>"); null when the id doesn't embed one (then the identity is a beeper_user keyed on the full id).
 */
export function instagramIdOf(beeperUserId: string): string | null {
  const s = beeperUserId.trim();
  if (/^\d{1,30}$/.test(s)) return s;
  const m = /^@(?:local-)?instagram(?:go)?_(\d{1,30}):[^\s]+$/i.exec(s);
  return m ? m[1]! : null;
}

export const chatKind = (type: string): 'direct' | 'group' => (type.toLowerCase() === 'group' ? 'group' : 'direct');

/** messages.source_msg_id: Beeper message ids are local to the Desktop install, so they are scoped by chat. */
export const messageKey = (chatId: string, messageId: string): string => `${chatId}|${messageId}`;

/** Reaction natural key (before reactionKey() namespacing): one reaction slot per Beeper reaction id per message. */
export const reactionSourceId = (msgKey: string, reactionId: string): string => `${msgKey}|${reactionId}`;

export const isReactionEvent = (m: Pick<BeeperMessage, 'type'>): boolean => (m.type ?? '').toUpperCase() === 'REACTION';

const ATTACHMENT_TYPES = new Set(['IMAGE', 'VIDEO', 'VOICE', 'AUDIO', 'FILE', 'LOCATION']);

export const blankToNull = (s: string | null | undefined): string | null => (s?.trim() ? s : null);

export function messageKind(m: Pick<BeeperMessage, 'type' | 'text' | 'isHidden' | 'attachments'>): EpisodeMessageKind {
  const text = blankToNull(m.text);
  const atts = m.attachments ?? [];
  if (m.isHidden) return 'system';
  const type = (m.type ?? 'TEXT').toUpperCase();
  if (type === 'NOTICE') return 'system';
  if (type === 'STICKER') return 'sticker';
  if (ATTACHMENT_TYPES.has(type)) return 'attachment';
  if (text === null) {
    if (!atts.length) return 'system';
    return atts.every((a) => a.isSticker) ? 'sticker' : 'attachment';
  }
  return URL_ONLY.test(text) ? 'link' : 'text';
}

/** Attachment metadata worth keeping: type, MIME, size, flags. Never URLs, local paths or file names. */
export function attachmentMeta(m: Pick<BeeperMessage, 'attachments'>): Record<string, unknown>[] {
  return (m.attachments ?? []).map((a) =>
    Object.fromEntries(
      Object.entries({
        type: a.type ?? null,
        mime: a.mimeType ?? null,
        bytes: a.fileSize ?? null,
        duration: a.duration ?? null,
        is_gif: a.isGif ? true : null,
        is_sticker: a.isSticker ? true : null,
        is_voice_note: a.isVoiceNote ? true : null,
      }).filter(([, v]) => v !== null),
    ),
  );
}

/** ISO timestamp → Unix ms (null when absent or unparseable). */
export function isoToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
