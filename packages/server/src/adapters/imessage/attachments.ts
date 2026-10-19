/**
 * Images a self-thread command carries (PLAN "Two-way texting"): the command row's own image attachments, else the
 * attachment-only rows he sent just before it (a screenshot, then "yb this person …"). The bytes come from the
 * collector's GET /v1/imessage/attachment, which serves only the note-to-self thread and returns a JPEG downscaled to
 * COMMAND_IMAGE_EDGE; nothing here reads chat.db or the attachments directory. Logs carry error codes only.
 */
import type { DB } from '../../db/connection';
import type { Logger } from '../../ops/logger';
import type { LlmImage } from '../../llm/types';
import { CollectorClient, CollectorHttpError, CollectorUnavailableError } from './collectorClient';

/** Images one command may send to the intent step (the route allows 2). */
export const COMMAND_IMAGE_MAX = 2;
/** Long edge the collector downscales to: enough to read a username, ~1.5k tokens per screenshot. */
export const COMMAND_IMAGE_EDGE = 1568;
/** Attachment-only self-thread rows sent this long before a command count as its images. */
export const COMMAND_IMAGE_LOOKBACK_MS = 3 * 60_000;
/** Originals above this are never requested (the collector refuses > 50 MB too). */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export interface ImageRef {
  messageGuid: string;
  /** Position in the message's attachments (chat.db order). */
  index: number;
}

export interface AttachmentSource {
  /** A collector is configured. */
  readonly configured: boolean;
  /** The image as a JPEG for the model, or null when it can't be had (refused, unreadable, collector down). */
  image(ref: ImageRef): Promise<LlmImage | null>;
}

export const disabledAttachmentSource: AttachmentSource = { configured: false, image: async () => null };

export function collectorAttachmentSource(o: { url: string; tokenFile: string; log?: Logger; client?: CollectorClient }): AttachmentSource {
  let client: CollectorClient | null = o.client ?? null;
  return {
    configured: true,
    async image(ref) {
      client ??= new CollectorClient({ baseUrl: o.url, tokenFile: o.tokenFile, timeoutMs: 15_000 });
      try {
        const r = await client.attachmentImage({ message_guid: ref.messageGuid, index: ref.index, max_edge: COMMAND_IMAGE_EDGE });
        return { mediaType: 'image/jpeg', data: r.data_base64, width: r.width, height: r.height };
      } catch (e) {
        const code = e instanceof CollectorHttpError ? e.code : e instanceof CollectorUnavailableError ? e.reason : e instanceof Error ? e.name : 'unknown';
        o.log?.warn('commands.image_unavailable', { error_class: code });
        return null;
      }
    },
  };
}

interface AttachmentMeta {
  mime?: string | null;
  uti?: string | null;
  name?: string | null;
  bytes?: number | null;
  is_sticker?: boolean | null;
}

const IMAGE_UTI = /^(public\.(jpeg|png|heic|heif|tiff|webp)|com\.compuserve\.gif|com\.apple\.quicktime-image)$/i;

/** Image (not sticker) attachments of one stored row, with their positions; duplicates (same name and size) once. */
export function imageAttachments(json: string | null): { index: number; key: string }[] {
  let list: AttachmentMeta[];
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    list = Array.isArray(v) ? (v as AttachmentMeta[]) : [];
  } catch {
    return [];
  }
  return list
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !a?.is_sticker && (a?.mime?.toLowerCase().startsWith('image/') || IMAGE_UTI.test(a?.uti ?? '')) && (a?.bytes ?? 0) <= MAX_SOURCE_BYTES)
    .map(({ a, index }) => ({ index, key: `${a.name ?? ''}|${a.bytes ?? ''}` }));
}

interface RowView {
  id: number;
  source_msg_id: string;
  conversation_id: string;
  sent_at: number;
  attachments: string | null;
}

/**
 * The images a command should carry: the command row's own, else up to COMMAND_IMAGE_MAX attachment-only rows of
 * mine in the same thread from the COMMAND_IMAGE_LOOKBACK_MS before it, newest first (bot rows never count). A note-to-self send
 * shows up twice in chat.db (the send and its echo), so the same file is taken once.
 */
export function commandImageRefs(db: DB, messageId: number): ImageRef[] {
  const row = db.prepare('SELECT id, source_msg_id, conversation_id, sent_at, attachments FROM messages WHERE id = ?').get(messageId) as RowView | undefined;
  if (!row) return [];
  const own = imageAttachments(row.attachments).map((a) => ({ messageGuid: row.source_msg_id, index: a.index, key: a.key }));
  const rows = own.length
    ? []
    : (db
        .prepare(
          `SELECT id, source_msg_id, conversation_id, sent_at, attachments FROM messages
           WHERE conversation_id = ? AND kind = 'attachment' AND is_bot = 0 AND is_from_me = 1 AND retracted_at IS NULL
             AND attachments IS NOT NULL AND sent_at BETWEEN ? AND ? AND id <> ?
           ORDER BY sent_at DESC, id DESC LIMIT 6`,
        )
        .all(row.conversation_id, row.sent_at - COMMAND_IMAGE_LOOKBACK_MS, row.sent_at, row.id) as RowView[]);
  const earlier = rows.flatMap((r) => imageAttachments(r.attachments).map((a) => ({ messageGuid: r.source_msg_id, index: a.index, key: a.key })));
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const c of [...own, ...earlier]) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ messageGuid: c.messageGuid, index: c.index });
    if (out.length >= COMMAND_IMAGE_MAX) break;
  }
  return out;
}
