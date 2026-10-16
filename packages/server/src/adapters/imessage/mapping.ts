/**
 * Pure chat.db → episode mapping rules (no I/O): conversation kind, message kind, tapbacks, group events, the bot
 * marker and the cross-ingester content key.
 */
import crypto from 'node:crypto';
import { BOT_MARKER, type Msg } from '@yb/shared/collector/v1';

/** Every bot message starts with BOT_MARKER (U+1F168), checked on the RAW text before any NFKC or trim. */
export { BOT_MARKER };

/**
 * outbound_messages.text_hash: sha256 (base64url) of the exact raw text sent, marker included, no normalization.
 * The ingester recomputes it on chat.db's raw text to spot a bot row before its GUIDs are recorded.
 */
export const outboundTextHash = (raw: string): string => crypto.createHash('sha256').update(raw, 'utf8').digest('base64url');

/** chat.style for group chats (45 = 1:1). */
export const GROUP_STYLE = 43;

export type ConversationKind = 'direct' | 'group' | 'self' | 'business';
export type MessageKind = 'text' | 'attachment' | 'system' | 'group_event' | 'poll' | 'sticker' | 'link';

export const URL_ONLY = /^\s*(?:https?:\/\/|www\.)\S+\s*$/i;

const OBJECT_REPLACEMENT = /\uFFFC/g;

/** Text with attachment placeholders (U+FFFC) removed; null when nothing is left. */
export function cleanText(text: string | null): string | null {
  const t = text?.replace(OBJECT_REPLACEMENT, '').trim();
  return t ? t : null;
}

export const isBotText = (raw: string | null): boolean => raw?.startsWith(BOT_MARKER) ?? false;

/** Group if chat.style says so (or the identifier is chat.db's "chatNNN" group id); 1:1 otherwise. */
export function isGroupChat(style: number | null, identifier: string | null): boolean {
  return style === GROUP_STYLE || /^chat\d+$/i.test(identifier ?? '');
}

/** item_type 1/2/3 are group membership / rename / leave-or-photo events; other non-zero types are system rows. */
export function messageKind(m: Pick<Msg, 'item_type' | 'balloon_bundle_id' | 'attachments'>, text: string | null): MessageKind {
  if (m.item_type !== 0) return m.item_type >= 1 && m.item_type <= 3 ? 'group_event' : 'system';
  const balloon = m.balloon_bundle_id ?? '';
  if (/URLBalloonProvider/i.test(balloon) || (text !== null && URL_ONLY.test(text))) return 'link';
  if (/poll/i.test(balloon)) return 'poll';
  if (text === null && m.attachments.length) return m.attachments.every((a) => a.is_sticker) ? 'sticker' : 'attachment';
  return 'text';
}

export type MembershipAction = 'add' | 'remove' | 'leave' | 'rename';

/** (item_type, group_action_type): (1,0) add, (1,1) remove, (2,·) rename, (3,0) leave; (3,1+) photo changes → none. */
export function membershipAction(itemType: number, groupActionType: number): MembershipAction | null {
  if (itemType === 1) return groupActionType === 0 ? 'add' : groupActionType === 1 ? 'remove' : null;
  if (itemType === 2) return 'rename';
  if (itemType === 3 && groupActionType === 0) return 'leave';
  return null;
}

const REACTIONS: Record<number, string> = {
  2000: 'love',
  2001: 'like',
  2002: 'dislike',
  2003: 'laugh',
  2004: 'emphasize',
  2005: 'question',
  2006: 'emoji',
  2007: 'sticker',
};

/** Tapbacks (2000–2007) and their removals (3000–3007); anything else is not a reaction. */
export function reactionInfo(assocType: number): { type: string; removal: boolean } | null {
  const removal = assocType >= 3000 && assocType <= 3007;
  const base = removal ? assocType - 1000 : assocType;
  const type = REACTIONS[base];
  return type ? { type, removal } : null;
}

/** associated_message_guid carries a part prefix ("p:0/GUID", "bp:GUID"); messages are keyed by the bare guid. */
export const stripPartPrefix = (guid: string): string => guid.replace(/^(?:p:\d+\/|bp:)/, '');

/**
 * hash(conversation, sender, second, normalized text): lets another ingester (legacy import, a re-linked device)
 * recognise the same message. Null for rows without text.
 */
export function contentKey(conversationId: string, senderRef: string, sentAtMs: number, text: string | null): string | null {
  if (text === null) return null;
  const norm = text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${conversationId}|${senderRef}|${Math.floor(sentAtMs / 1000)}|${norm}`)
    .digest('base64url')
    .slice(0, 22);
}
