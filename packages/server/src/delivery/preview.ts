/**
 * Read-side views of the digest: the preview (exact text that would be sent; never sends, never spends, never
 * writes), the Today header state, the digest cards and the history list. Today's route module and the digest
 * routes both use these.
 */
import { localDate as toLocalDate, type ChannelDelivery, type DigestItem, type DigestPreview, type DigestSummary, type TodayDigest } from '@yb/shared';
import type { DB } from '../db/connection';
import type { AgentServices } from '../services';
import { settingsSnapshot } from '../settings/registry';
import { allClearText, composeSelection, compositionCurrent, storedComposition, toDigestItems, type ComposedDigest } from './compose';
import { readDigestSelection, getDigestRow, type DigestRow, type SelectDigestItems } from './selection';
import { whyNotSent } from './send';

export interface PreviewOptions {
  date?: string;
  now: number;
  select?: SelectDigestItems;
}

/** GET /digest/preview: the stored composition when it is current, else a fresh template composition. */
export async function digestPreview(db: DB, services: Pick<AgentServices, 'llm' | 'egress' | 'outbound'>, o: PreviewOptions): Promise<DigestPreview> {
  const s = settingsSnapshot(db);
  const date = o.date ?? toLocalDate(o.now, s.tz);
  const sel = (o.select ?? readDigestSelection)(db, { localDate: date, now: o.now });
  let composed: ComposedDigest | null = null;
  if (sel && sel.items.length) {
    composed = (compositionCurrent(sel) || sel.digest.sent_at ? storedComposition(sel) : null) ?? (await composeSelection(db, services, sel, { localDate: date, now: o.now, useLlm: false, settings: s }));
  }
  const items = composed?.items ?? [];
  const reason = whyNotSent(db, services.outbound.configured, { localDate: date, now: o.now, itemCount: items.length, digest: sel?.digest ?? null });
  const text = composed?.text ?? allClearText(date);
  return {
    date,
    text,
    pushBody: composed?.pushBody ?? 'Your brief is ready · 0 things',
    items: toDigestItems(db, items),
    composer: composed?.composer ?? 'template',
    wouldSend: reason === null,
    reasonNotSent: reason,
    charCount: [...text].length,
  };
}

const CHANNEL: ReadonlySet<string> = new Set(['sent', 'pending', 'skipped', 'failed', 'disabled', 'not_configured']);
const channel = (v: string | null, fallback: ChannelDelivery): ChannelDelivery => (v && CHANNEL.has(v) ? (v as ChannelDelivery) : fallback);

/** Today's header state for a digest row ("Sent 8:00 via iMessage ✓ · push ✓", or why not). */
export function todayDigestOf(d: DigestRow): TodayDigest {
  const final = ['sent', 'fallback_sent', 'failed', 'skipped'].includes(d.status);
  return {
    id: d.id,
    localDate: d.local_date,
    status: d.status,
    itemCap: d.item_cap,
    composedAt: d.composed_at,
    sentAt: d.sent_at,
    pushSentAt: d.push_sent_at,
    imessage: d.sent_at ? 'sent' : channel(d.imessage_status, final ? 'skipped' : 'pending'),
    push: d.push_sent_at ? 'sent' : channel(d.push_status, final ? 'skipped' : 'pending'),
    skipReason: d.skip_reason,
  };
}

/** Today's digest header for a date (null = no digest row yet). */
export function todayDigest(db: DB, localDate: string): TodayDigest | null {
  const d = getDigestRow(db, localDate);
  return d ? todayDigestOf(d) : null;
}

/** The composed digest cards for a date (stored copy; template copy if not composed yet). Never spends. */
export async function digestCards(db: DB, services: Pick<AgentServices, 'llm' | 'egress'>, o: { localDate: string; now: number; select?: SelectDigestItems }): Promise<DigestItem[]> {
  const sel = (o.select ?? readDigestSelection)(db, { localDate: o.localDate, now: o.now });
  if (!sel || !sel.items.length) return [];
  const composed = storedComposition(sel) ?? (await composeSelection(db, services, sel, { localDate: o.localDate, now: o.now, useLlm: false }));
  return toDigestItems(db, composed.items);
}

/** GET /digest/history */
export function digestHistory(db: DB, limit: number): DigestSummary[] {
  const rows = db
    .prepare(
      `SELECT d.*, (SELECT count(*) FROM digest_items di WHERE di.digest_id = d.id) AS item_count,
         EXISTS (SELECT 1 FROM digest_items di JOIN suggestions s ON s.id = di.suggestion_id WHERE di.digest_id = d.id AND s.is_wildcard = 1) AS had_wildcard
       FROM digests d ORDER BY d.local_date DESC LIMIT ?`,
    )
    .all(limit) as (DigestRow & { item_count: number; had_wildcard: number })[];
  return rows.map((r) => ({
    id: r.id,
    localDate: r.local_date,
    status: r.status,
    itemCount: r.item_count,
    sentAt: r.sent_at,
    pushSentAt: r.push_sent_at,
    hadWildcard: r.had_wildcard === 1,
  }));
}
