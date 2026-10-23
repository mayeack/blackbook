/**
 * Contract for the signed collector's loopback API v1 (127.0.0.1:4321, Bearer token). See
 * docs/design/architecture.md §1a "Loopback API v1". The collector is Swift; these schemas are what Node
 * accepts, so they are deliberately tolerant where Swift encoders differ:
 *  - optional values may be omitted or null (both parse to null),
 *  - booleans may arrive as 0/1,
 *  - timestamps may be Unix ms (preferred), Unix seconds, or ISO-8601; they always parse to Unix ms.
 * Phone/email normalization is NOT the collector's job: handles arrive raw and are normalized in Node.
 * There is no calendar route (Google Calendar is read through its own API).
 * GET /v1/calls serves the Mac's call log (CallHistory.storedata): only calls that rang or were placed on this Mac.
 */
import { z } from 'zod';

export const COLLECTOR_API_VERSION = 'v1';
export const COLLECTOR_DEFAULT_URL = 'http://127.0.0.1:4321';

export const COLLECTOR_ROUTES = {
  health: '/v1/health',
  imessageMessages: '/v1/imessage/messages',
  imessageMessagesByDate: '/v1/imessage/messages/by-date',
  imessageEdited: '/v1/imessage/edited',
  imessageChats: '/v1/imessage/chats',
  imessageHandles: '/v1/imessage/handles',
  imessageSend: '/v1/imessage/send',
  imessageAttachment: '/v1/imessage/attachment',
  whatsappSnapshot: '/v1/whatsapp/snapshot',
  contacts: '/v1/contacts',
  visionOcr: '/v1/vision/ocr',
  calls: '/v1/calls',
} as const;

// ---------- primitives ----------

/** Unix ms, Unix seconds (< 1e11) or an ISO-8601 string → Unix ms. */
export function timestampToMs(v: number | string): number {
  if (typeof v === 'number') return Math.round(Math.abs(v) < 1e11 ? v * 1000 : v);
  return Date.parse(v);
}

export const Timestamp = z
  .union([z.number().finite(), z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp')])
  .transform(timestampToMs);

export const Flag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => v === true || v === 1);

/** Omitted or null → null. */
const opt = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => (v ?? null) as z.output<T> | null);
const optFlag = Flag.nullish().transform((v) => v ?? false);
const RowId = z.number().int().nonnegative();

export const CollectorErrorCode = z.enum([
  'fda_missing',
  'contacts_denied',
  'calendar_denied',
  'automation_denied',
  'recipient_not_allowed',
  'whatsapp_not_installed',
  'snapshot_inconsistent',
  'chatdb_unavailable',
  'attachment_not_found',
  'attachment_not_allowed',
  'attachment_unreadable',
  'image_unreadable',
  'payload_too_large',
  'callhistory_unavailable',
]);
export type CollectorErrorCode = z.infer<typeof CollectorErrorCode>;

/** `{error:{code,message}}`. Codes outside the documented list (e.g. "unauthorized") still parse. */
export const CollectorError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type CollectorError = z.infer<typeof CollectorError>;

/** `{api:"v1", generated_at, items:[…], next_after_rowid?, has_more?, max_rowid?}` */
export function envelope<T extends z.ZodType>(item: T) {
  return z.object({
    api: z.literal(COLLECTOR_API_VERSION),
    generated_at: Timestamp,
    items: z.array(item),
    next_after_rowid: opt(RowId),
    has_more: optFlag,
    max_rowid: opt(RowId),
  });
}

// ---------- GET /v1/health ----------

export const PermissionState = z
  .union([z.enum(['granted', 'denied', 'not_determined', 'restricted', 'unknown']), z.boolean()])
  .transform((v) => (v === true ? 'granted' : v === false ? 'denied' : v));
export type PermissionState = z.output<typeof PermissionState>;

export const Health = z.object({
  api: z.literal(COLLECTOR_API_VERSION).optional(),
  generated_at: Timestamp.optional(),
  version: z.string(),
  build: z.union([z.string(), z.number()]).transform(String),
  macos: z.string(),
  uptime_s: z.number().nonnegative(),
  permissions: z.object({
    fda: PermissionState,
    contacts: PermissionState,
    calendars: PermissionState.optional(),
    automation_messages: PermissionState,
  }),
  chatdb: z.object({ max_rowid: opt(RowId), newest_at: opt(Timestamp) }),
  whatsapp: z.object({ installed: Flag, running: Flag, container_mtime: opt(Timestamp) }),
  messages_app_running: Flag,
});
export type Health = z.output<typeof Health>;

// ---------- iMessage ----------

export const TextSource = z.enum(['text', 'attributedBody', 'none']);

export const Attachment = z.object({
  mime: opt(z.string()),
  uti: opt(z.string()),
  name: opt(z.string()),
  bytes: opt(z.number().int().nonnegative()),
  is_sticker: optFlag,
});

/**
 * GET /v1/imessage/attachment: one image attachment of a NOTE-TO-SELF message (the collector refuses any other
 * chat, stickers and non-images) as a JPEG downscaled to `max_edge` on the long side. `index` is the position in
 * Msg.attachments.
 */
export const AttachmentQuery = z.object({
  message_guid: z.string().min(1).max(128),
  index: z.coerce.number().int().min(0).max(9).default(0),
  max_edge: z.coerce.number().int().min(256).max(2576).default(1568),
});
export type AttachmentQuery = z.input<typeof AttachmentQuery>;

export const AttachmentImageResponse = z.object({
  api: z.literal(COLLECTOR_API_VERSION),
  generated_at: Timestamp,
  mime: z.literal('image/jpeg'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  data_base64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type AttachmentImageResponse = z.output<typeof AttachmentImageResponse>;

/** Tapback / sticker association (chat.db associated_message_*). */
export const Assoc = z.object({
  type: z.number().int(),
  target_guid: opt(z.string()),
  emoji: opt(z.string()),
});

export const Msg = z.object({
  rowid: RowId,
  guid: z.string().min(1),
  chat_guid: opt(z.string()),
  /** chat.style: 43 = group, 45 = 1:1 */
  chat_style: opt(z.number().int()),
  chat_identifier: opt(z.string()),
  chat_display_name: opt(z.string()),
  service: opt(z.string()),
  /** Raw handle id; null when the message is mine. */
  sender_handle: opt(z.string()),
  is_from_me: Flag,
  date: Timestamp,
  date_edited: opt(Timestamp),
  date_retracted: opt(Timestamp),
  text: opt(z.string()),
  text_source: TextSource,
  item_type: z.number().int().default(0),
  group_action_type: z.number().int().default(0),
  /** Handle ROWID or handle id of the member a group event refers to. */
  other_handle: opt(z.union([z.number().int(), z.string()])),
  group_title: opt(z.string()),
  assoc: opt(Assoc),
  reply_to_guid: opt(z.string()),
  thread_originator_guid: opt(z.string()),
  balloon_bundle_id: opt(z.string()),
  is_spam: optFlag,
  is_delivered: optFlag,
  error: z.number().int().default(0),
  attachments: z.array(Attachment).nullish().transform((v) => v ?? []),
});
export type Msg = z.output<typeof Msg>;

/** GET /v1/imessage/edited items: a Msg plus retracted part indexes from message_summary_info. */
export const EditedMsg = Msg.extend({
  retracted_parts: z.array(z.number().int()).nullish().transform((v) => v ?? []),
});
export type EditedMsg = z.output<typeof EditedMsg>;

const limit = (max: number, dflt: number) => z.coerce.number().int().min(1).max(max).default(dflt);

export const MessagesQuery = z.object({
  after_rowid: z.coerce.number().int().nonnegative(),
  limit: limit(1000, 500),
  chat_guid: z.string().optional(),
});
export type MessagesQuery = z.input<typeof MessagesQuery>;

export const MessagesByDateQuery = z.object({
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  after_rowid: z.coerce.number().int().nonnegative().default(0),
  limit: limit(1000, 500),
});
export type MessagesByDateQuery = z.input<typeof MessagesByDateQuery>;

export const EditedQuery = z.object({
  since: z.iso.datetime({ offset: true }),
  after_rowid: z.coerce.number().int().nonnegative().default(0),
  limit: limit(1000, 500),
});
export type EditedQuery = z.input<typeof EditedQuery>;

export const ChatsQuery = z.object({
  after_rowid: z.coerce.number().int().nonnegative().default(0),
  limit: limit(500, 500),
});
export type ChatsQuery = z.input<typeof ChatsQuery>;

export const MessagesResponse = envelope(Msg);
export type MessagesResponse = z.output<typeof MessagesResponse>;
export const EditedResponse = envelope(EditedMsg);
export type EditedResponse = z.output<typeof EditedResponse>;

export const Chat = z.object({
  chat_rowid: RowId,
  chat_guid: z.string().min(1),
  style: opt(z.number().int()),
  chat_identifier: opt(z.string()),
  display_name: opt(z.string()),
  service: opt(z.string()),
  /** Raw handle ids of current members (excluding me). */
  members: z.array(z.string()).nullish().transform((v) => v ?? []),
  last_message_at: opt(Timestamp),
});
export type Chat = z.output<typeof Chat>;
export const ChatsResponse = envelope(Chat);
export type ChatsResponse = z.output<typeof ChatsResponse>;

export const Handle = z.object({ rowid: RowId, id: z.string(), service: opt(z.string()) });
export type Handle = z.output<typeof Handle>;
export const HandlesResponse = envelope(Handle);
export type HandlesResponse = z.output<typeof HandlesResponse>;

// ---------- POST /v1/imessage/send ----------

/** Every bot message starts with this marker (U+1F168); the collector refuses a send without it. */
export const BOT_MARKER = '\u{1F168}';

export const SendRequest = z.object({
  to: z.string().min(1),
  text: z
    .string()
    .min(1)
    .max(10_000)
    .refine((t) => t.startsWith(BOT_MARKER), 'text must start with the bot marker U+1F168'),
  client_ref: z.uuid(),
  verify_timeout_ms: z.number().int().min(0).max(60_000).default(8000),
});
export type SendRequest = z.input<typeof SendRequest>;

export const SendStatus = z.enum(['delivered', 'sent', 'unverified', 'ghost', 'failed']);
export type SendStatus = z.infer<typeof SendStatus>;

export const SendResponse = z.object({
  api: z.literal(COLLECTOR_API_VERSION).optional(),
  generated_at: Timestamp.optional(),
  status: SendStatus,
  message_guids: z.array(z.string()).nullish().transform((v) => v ?? []),
  rowids: z.array(RowId).nullish().transform((v) => v ?? []),
  error_code: opt(z.string()),
});
export type SendResponse = z.output<typeof SendResponse>;

// ---------- POST /v1/whatsapp/snapshot ----------

export const WhatsAppSnapshotRequest = z.object({ force: z.boolean().optional() });
export type WhatsAppSnapshotRequest = z.input<typeof WhatsAppSnapshotRequest>;

export const WhatsAppSnapshotResponse = z.object({
  api: z.literal(COLLECTOR_API_VERSION).optional(),
  generated_at: Timestamp.optional(),
  unchanged: Flag,
  snapshot_dir: z.string(),
  files: z.object({ chat: z.string(), contacts: opt(z.string()), lid: opt(z.string()) }),
  source_mtime: opt(Timestamp),
  max_pk: opt(z.number().int()),
  bytes: opt(z.number().int().nonnegative()),
});
export type WhatsAppSnapshotResponse = z.output<typeof WhatsAppSnapshotResponse>;

// ---------- GET /v1/contacts ----------

const Labeled = z.object({ label: opt(z.string()), value: z.string() });

export const PostalAddress = z.object({
  label: opt(z.string()),
  street: opt(z.string()),
  city: opt(z.string()),
  state: opt(z.string()),
  postal_code: opt(z.string()),
  country: opt(z.string()),
  iso_country_code: opt(z.string()),
});

export const SocialProfile = z.object({
  /** CNSocialProfile.service (e.g. "Instagram"); the label is NOT the service. */
  service: opt(z.string()),
  username: opt(z.string()),
  url: opt(z.string()),
});

export const ContactCard = z.object({
  id: z.string().min(1),
  given: opt(z.string()),
  family: opt(z.string()),
  nickname: opt(z.string()),
  org: opt(z.string()),
  job: opt(z.string()),
  phones: z.array(Labeled).nullish().transform((v) => v ?? []),
  emails: z.array(Labeled).nullish().transform((v) => v ?? []),
  postal: z.array(PostalAddress).nullish().transform((v) => v ?? []),
  birthday: opt(z.object({ y: opt(z.number().int()), m: z.number().int().min(1).max(12), d: z.number().int().min(1).max(31) })),
  social: z.array(SocialProfile).nullish().transform((v) => v ?? []),
  urls: z
    .array(z.union([z.string().transform((value) => ({ label: null, value })), Labeled]))
    .nullish()
    .transform((v) => v ?? []),
  modified_at: opt(Timestamp),
  /** When the card was created in the AddressBook store (ZCREATIONDATE, read with FDA); absent on older collectors. */
  created_at: opt(Timestamp),
});
export type ContactCard = z.output<typeof ContactCard>;

export const ContactsResponse = z.object({
  api: z.literal(COLLECTOR_API_VERSION).optional(),
  generated_at: Timestamp.optional(),
  hash: z.string(),
  items: z.array(ContactCard),
});
export type ContactsResponse = z.output<typeof ContactsResponse>;

// ---------- POST /v1/vision/ocr ----------

/**
 * POST /v1/vision/ocr: on-device text recognition (Apple Vision, accurate level, language correction on) of one
 * image the caller already holds (a Google Photos screenshot the owner picked). JPEG/PNG/HEIC/WebP; data_base64 may
 * be up to 6 MiB of characters and the HTTP body up to 8 MiB (the collector's per-route cap; every other route: 1 MiB). The collector keeps nothing: no file is written, the text is never logged. Lines come top to
 * bottom; coordinates are normalized to 0–1 with the origin at the TOP-left (Vision's bottom-left origin flipped).
 */
export const OcrRequest = z.object({
  data_base64: z.string().min(1).max(6 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  max_lines: z.number().int().min(1).max(400).optional(),
});
export type OcrRequest = z.input<typeof OcrRequest>;

export const OcrLine = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type OcrLine = z.output<typeof OcrLine>;

export const OcrResponse = z.object({
  api: z.literal(COLLECTOR_API_VERSION),
  generated_at: Timestamp,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  lines: z.array(OcrLine),
});
export type OcrResponse = z.output<typeof OcrResponse>;

// ---------- GET /v1/calls ----------

export const CallsQuery = z.object({
  after_rowid: z.coerce.number().int().nonnegative().default(0),
  limit: limit(1000, 500),
});
export type CallsQuery = z.input<typeof CallsQuery>;

/** One CallHistory ZCALLRECORD row, raw: Node maps call_type/provider and normalizes the handles. */
export const CallRecord = z.object({
  rowid: RowId,
  unique_id: z.string().min(1),
  date: Timestamp,
  duration_s: z.number().nonnegative(),
  /** ZCALLTYPE: 1 phone, 8 FaceTime video, 16 FaceTime audio. */
  call_type: opt(z.number().int()),
  /** ZSERVICE_PROVIDER, e.g. com.apple.Telephony / com.apple.FaceTime. */
  provider: opt(z.string()),
  originated: Flag,
  answered: Flag,
  /** The remote party first, then any other participants of a group call (raw phone numbers / emails). */
  handles: z.array(z.string()),
});
export type CallRecord = z.output<typeof CallRecord>;

export const CallsResponse = envelope(CallRecord);
export type CallsResponse = z.output<typeof CallsResponse>;
