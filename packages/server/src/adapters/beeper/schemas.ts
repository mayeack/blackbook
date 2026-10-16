/**
 * Beeper Desktop API v1 response shapes (https://developers.beeper.com/desktop-api-reference/), validated
 * tolerantly: objects are loose (unknown fields kept), optional fields may be missing or null, and list items are
 * parsed one by one so a single odd item is dropped and counted instead of failing the whole page.
 */
import { z } from 'zod';

const str = z.string();
const optStr = str.nullish();
const optBool = z.boolean().nullish();

export const BeeperUser = z.looseObject({
  /** Stable Beeper user id, e.g. "@instagramgo_<digits>:beeper.local" for an Instagram contact. */
  id: str,
  fullName: optStr,
  /** Network handle (Instagram username, without '@'). */
  username: optStr,
  phoneNumber: optStr,
  email: optStr,
  isSelf: optBool,
  cannotMessage: optBool,
});
export type BeeperUser = z.output<typeof BeeperUser>;

export const BeeperParticipant = BeeperUser.extend({
  isAdmin: optBool,
  isNetworkBot: optBool,
  isPending: optBool,
});
export type BeeperParticipant = z.output<typeof BeeperParticipant>;

export const BeeperAccount = z.looseObject({
  accountID: str,
  /** Human-friendly network name ("Instagram", "iMessage", "WhatsApp", …); omitted when unknown. */
  network: optStr,
  status: optStr,
  statusText: optStr,
  bridge: z.looseObject({ id: optStr, type: optStr, provider: optStr }).nullish(),
  user: BeeperUser.nullish(),
});
export type BeeperAccount = z.output<typeof BeeperAccount>;

export const BeeperChat = z.looseObject({
  id: str,
  accountID: str,
  network: optStr,
  title: optStr,
  type: str,
  participants: z
    .looseObject({
      items: z.array(z.unknown()).nullish(),
      hasMore: optBool,
      total: z.number().nullish(),
    })
    .nullish(),
  lastActivity: optStr,
  isArchived: optBool,
  /** Present on a merged chat (one person across networks): it holds no messages of its own. */
  merge: z.unknown().optional(),
  mergedIntoChatID: optStr,
});
export type BeeperChat = z.output<typeof BeeperChat>;

export const BeeperAttachment = z.looseObject({
  type: optStr,
  mimeType: optStr,
  fileSize: z.number().nullish(),
  duration: z.number().nullish(),
  isGif: optBool,
  isSticker: optBool,
  isVoiceNote: optBool,
});

export const BeeperReaction = z.looseObject({
  /** The participant id, or participant id + reaction key when one person can react several times. */
  id: str,
  participantID: str,
  reactionKey: str,
  emoji: optBool,
});
export type BeeperReaction = z.output<typeof BeeperReaction>;

const idLike = z.union([str, z.number()]).transform(String);

export const BeeperMessage = z.looseObject({
  id: idLike,
  chatID: str,
  accountID: optStr,
  senderID: str,
  senderName: optStr,
  sortKey: idLike.nullish(),
  timestamp: str.refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp'),
  text: optStr,
  /** TEXT, NOTICE, IMAGE, VIDEO, VOICE, AUDIO, FILE, STICKER, LOCATION, REACTION (a hidden reaction event). */
  type: optStr,
  isSender: optBool,
  isDeleted: optBool,
  isHidden: optBool,
  editedTimestamp: optStr,
  /** The quoted message (a reply) or, on a REACTION item, the message reacted to. */
  linkedMessageID: idLike.nullish(),
  attachments: z.array(BeeperAttachment).nullish(),
  reactions: z.array(BeeperReaction).nullish(),
  links: z.array(z.unknown()).nullish(),
});
export type BeeperMessage = z.output<typeof BeeperMessage>;

/** Cursor page (chats, messages, contacts). Items are validated separately (parseItems). */
export const BeeperPage = z.looseObject({
  items: z.array(z.unknown()),
  hasMore: optBool,
  oldestCursor: optStr,
  newestCursor: optStr,
});

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** Use with direction 'before' (older). */
  oldestCursor: string | null;
  /** Use with direction 'after' (newer). Beeper returns null on an empty 'after' page. */
  newestCursor: string | null;
  /** Items that failed validation and were dropped. */
  invalid: number;
}

export interface ParsedItems<T> {
  items: T[];
  invalid: number;
  /** Validation paths of the dropped items (for a contract alert; no values). */
  paths: string[];
}

export function parseItems<S extends z.ZodType>(schema: S, raw: readonly unknown[]): ParsedItems<z.output<S>> {
  const items: z.output<S>[] = [];
  const paths = new Set<string>();
  let invalid = 0;
  for (const r of raw) {
    const p = schema.safeParse(r);
    if (p.success) items.push(p.data);
    else {
      invalid++;
      for (const i of p.error.issues) paths.add(i.path.map((x) => (typeof x === 'number' ? '#' : String(x))).join('.'));
    }
  }
  return { items, invalid, paths: [...paths] };
}
