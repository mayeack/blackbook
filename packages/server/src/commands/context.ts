/**
 * What a self-thread row is answering: its inline-reply target, the latest digest it can bind to (≤36 h), and
 * when the bot last texted (the 12 h free-text window). Plus the item list of a digest (digest_items and the
 * extra items `more` added), with the names a reply shows.
 */
import { stripPartPrefix, outboundTextHash } from '../adapters/imessage/mapping';
import type { DB } from '../db/connection';
import { shortName } from './text';

const HOUR = 3_600_000;
/** Bare numbers and commands bind to the most recent digest sent this long before the command. */
export const DIGEST_BIND_MS = 36 * HOUR;
/** Other free text counts only this soon after a bot message (or with a "yb" prefix). */
export const FREE_TEXT_WINDOW_MS = 12 * HOUR;
/** Rows older than this when processed are "seen late" (never executed). */
export const COMMAND_STALE_MS = 6 * HOUR;
/** Clock skew between the digest's recorded send time and the rows chat.db stamps. */
const SKEW_MS = 5 * 60_000;

const SENT = `('sent','fallback_sent')`;
const LIVE_OUTBOUND = `('queued','sending','delivered','sent','unverified')`;

export interface MessageInfo {
  id: number;
  sentAt: number;
  conversationId: string;
  replyToMsgId: number | null;
  threadRootSourceId: string | null;
}

export interface DigestRef {
  id: string;
  sentAt: number;
  localDate: string;
}

export interface CommandContext {
  msg: MessageInfo;
  /** Inline reply (thread originator) to a bot row, and the digest that row belongs to. */
  inline: { toBot: boolean; digest: DigestRef | null };
  /** The most recent digest sent in the 36 h before the row. */
  latestDigest: DigestRef | null;
  lastBotAt: number | null;
  /** A bot message went out in the 12 h before the row. */
  recentBot: boolean;
}

export function loadMessage(db: DB, messageId: number): MessageInfo | null {
  const r = db
    .prepare('SELECT id, sent_at, conversation_id, reply_to_msg_id, thread_root_source_id FROM messages WHERE id = ?')
    .get(messageId) as
    | { id: number; sent_at: number; conversation_id: string; reply_to_msg_id: number | null; thread_root_source_id: string | null }
    | undefined;
  return r
    ? { id: r.id, sentAt: r.sent_at, conversationId: r.conversation_id, replyToMsgId: r.reply_to_msg_id, threadRootSourceId: r.thread_root_source_id }
    : null;
}

const digestById = (db: DB, id: string | null | undefined): DigestRef | null => {
  if (!id) return null;
  const r = db.prepare(`SELECT id, sent_at, local_date FROM digests WHERE id = ? AND status IN ${SENT} AND sent_at IS NOT NULL`).get(id) as
    | { id: string; sent_at: number; local_date: string }
    | undefined;
  return r ? { id: r.id, sentAt: r.sent_at, localDate: r.local_date } : null;
};

/** The digest a bot row (a message the bot sent) belongs to: by its GUID, its text hash, or its send time. */
export function digestForBotMessage(db: DB, messageId: number): DigestRef | null {
  const m = db.prepare('SELECT source_msg_id, sent_at, text, is_bot FROM messages WHERE id = ?').get(messageId) as
    | { source_msg_id: string; sent_at: number; text: string | null; is_bot: number }
    | undefined;
  if (!m) return null;
  const guids = [...new Set([m.source_msg_id, stripPartPrefix(m.source_msg_id)])];
  for (const g of guids) {
    const viaGuid = db
      .prepare(
        `SELECT coalesce(om.digest_id, (SELECT d.id FROM digests d WHERE d.outbound_id = om.id)) FROM outbound_guids og
         JOIN outbound_messages om ON om.id = og.outbound_id WHERE og.guid = ?`,
      )
      .pluck()
      .get(g) as string | null | undefined;
    if (viaGuid) return digestById(db, viaGuid);
    if (viaGuid === null) return null; // a known bot send that isn't a digest (an ack, an answer)
  }
  if (m.text) {
    const viaHash = db
      .prepare(
        `SELECT digest_id FROM outbound_messages WHERE text_hash = ? AND digest_id IS NOT NULL AND created_at BETWEEN ? AND ?
         ORDER BY abs(created_at - ?) LIMIT 1`,
      )
      .pluck()
      .get(outboundTextHash(m.text), m.sent_at - SKEW_MS, m.sent_at + SKEW_MS, m.sent_at) as string | undefined;
    if (viaHash) return digestById(db, viaHash);
  }
  if (!m.is_bot) return null;
  const near = db
    .prepare(`SELECT id FROM digests WHERE status IN ${SENT} AND sent_at BETWEEN ? AND ? ORDER BY abs(sent_at - ?) LIMIT 1`)
    .pluck()
    .get(m.sent_at - SKEW_MS, m.sent_at + SKEW_MS, m.sent_at) as string | undefined;
  return digestById(db, near);
}

/** The most recent digest sent in the 36 h before `at`. */
export function latestDigestBefore(db: DB, at: number): DigestRef | null {
  const r = db
    .prepare(
      `SELECT id, sent_at, local_date FROM digests WHERE status IN ${SENT} AND sent_at BETWEEN ? AND ? ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(at - DIGEST_BIND_MS, at + SKEW_MS) as { id: string; sent_at: number; local_date: string } | undefined;
  return r ? { id: r.id, sentAt: r.sent_at, localDate: r.local_date } : null;
}

/** When the bot last texted before `at` (outbound ledger or a recognized bot row in a self thread). */
export function lastBotMessageBefore(db: DB, at: number): number | null {
  const out = db
    .prepare(`SELECT max(coalesce(sent_at, created_at)) FROM outbound_messages WHERE status IN ${LIVE_OUTBOUND} AND created_at <= ?`)
    .pluck()
    .get(at + SKEW_MS) as number | null;
  const row = db
    .prepare(
      `SELECT max(m.sent_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.kind = 'self' AND m.is_bot = 1 AND m.sent_at <= ?`,
    )
    .pluck()
    .get(at + SKEW_MS) as number | null;
  const best = Math.max(out ?? -Infinity, row ?? -Infinity);
  return Number.isFinite(best) ? Math.min(best, at) : null;
}

export function loadContext(db: DB, msg: MessageInfo): CommandContext {
  let toBot = false;
  let inlineDigest: DigestRef | null = null;
  const target =
    msg.replyToMsgId ??
    (msg.threadRootSourceId
      ? ((db
          .prepare(`SELECT id FROM messages WHERE source = 'imessage' AND source_msg_id IN (?, ?)`)
          .pluck()
          .get(msg.threadRootSourceId, stripPartPrefix(msg.threadRootSourceId)) as number | undefined) ?? null)
      : null);
  if (target !== null) {
    const t = db.prepare('SELECT is_bot, source_msg_id FROM messages WHERE id = ?').get(target) as { is_bot: number; source_msg_id: string } | undefined;
    const known = t ? db.prepare('SELECT 1 FROM outbound_guids WHERE guid IN (?, ?)').get(t.source_msg_id, stripPartPrefix(t.source_msg_id)) : undefined;
    toBot = !!t && (t.is_bot === 1 || known !== undefined);
    if (toBot) inlineDigest = digestForBotMessage(db, target);
  }
  const lastBotAt = lastBotMessageBefore(db, msg.sentAt);
  return {
    msg,
    inline: { toBot, digest: inlineDigest },
    latestDigest: latestDigestBefore(db, msg.sentAt),
    lastBotAt,
    recentBot: lastBotAt !== null && msg.sentAt - lastBotAt <= FREE_TEXT_WINDOW_MS,
  };
}

// ---------------------------------------------------------------------------------------------- digest items

export interface ItemRow {
  ordinal: number;
  suggestionId: string;
  kind: string;
  status: string;
  personId: string | null;
  relatedPersonId: string | null;
  circleId: string | null;
  title: string | null;
  sensitive: boolean;
  isWildcard: boolean;
  snoozedUntil: number | null;
  score: number;
  /** "Sam R.", "Sam R. & Priya S.", a circle name, or a kind label. */
  label: string;
  /** The label of the main person, if any. */
  personLabel: string | null;
}

export const OPEN_STATUSES = new Set(['candidate', 'selected', 'delivered', 'snoozed']);

const KIND_LABEL: Record<string, string> = {
  reply_debt: 'reply owed',
  pre_event_brief: 'event brief',
  pre_event: 'event brief',
  commitment_due: 'a promise',
  event_followup: 'follow-up',
  fading: 'quiet a while',
  travel_overlap: 'same city soon',
  travel: 'trip',
  cooling: 'cooling off',
  intro: 'intro',
  circle_neglect: 'circle check-in',
  circle: 'circle check-in',
  dormant: 'long time',
  memory: 'on this day',
  wildcard: 'wildcard',
  review: 'review',
};
export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k.replaceAll('_', ' ');

interface RawItem {
  ordinal: number;
  suggestion_id: string;
  kind: string;
  status: string;
  person_id: string | null;
  related_person_id: string | null;
  circle_id: string | null;
  title: string | null;
  sensitive: number;
  is_wildcard: number;
  snoozed_until: number | null;
  score: number;
}

const ITEM_COLS = `s.id AS suggestion_id, s.kind, s.status, s.person_id, s.related_person_id, s.circle_id, s.title, s.sensitive,
  s.is_wildcard, s.snoozed_until, s.score`;

export function personLabel(db: DB, personId: string | null): string | null {
  if (!personId) return null;
  const p = db
    .prepare(
      `SELECT p.first_name, p.last_name, p.display_name FROM people p
       WHERE p.id = coalesce((SELECT canonical_id FROM person_canon WHERE person_id = ?), ?)`,
    )
    .get(personId, personId) as { first_name: string | null; last_name: string | null; display_name: string } | undefined;
  return p ? shortName(p) : null;
}

function toItem(db: DB, r: RawItem): ItemRow {
  const a = personLabel(db, r.person_id);
  const b = personLabel(db, r.related_person_id);
  const circle = r.circle_id ? ((db.prepare('SELECT name FROM circles WHERE id = ?').pluck().get(r.circle_id) as string | undefined) ?? null) : null;
  return {
    ordinal: r.ordinal,
    suggestionId: r.suggestion_id,
    kind: r.kind,
    status: r.status,
    personId: r.person_id,
    relatedPersonId: r.related_person_id,
    circleId: r.circle_id,
    title: r.title,
    sensitive: r.sensitive === 1,
    isWildcard: r.is_wildcard === 1,
    snoozedUntil: r.snoozed_until,
    score: r.score,
    label: a && b ? `${a} & ${b}` : (a ?? circle ?? kindLabel(r.kind)),
    personLabel: a,
  };
}

/** A digest's items by ordinal: digest_items plus what `more` added. */
export function digestItems(db: DB, digestId: string): ItemRow[] {
  const rows = db
    .prepare(
      `SELECT di.ordinal, ${ITEM_COLS} FROM digest_items di JOIN suggestions s ON s.id = di.suggestion_id WHERE di.digest_id = @d
       UNION ALL
       SELECT mi.ordinal, ${ITEM_COLS} FROM command_more_items mi JOIN suggestions s ON s.id = mi.suggestion_id WHERE mi.digest_id = @d
       ORDER BY 1`,
    )
    .all({ d: digestId }) as RawItem[];
  return rows.map((r) => toItem(db, r));
}

const hasTable = (db: DB, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/**
 * Open suggestions not yet in this digest (for `more`), best first. Never a muted kind ("never suggest X"), a
 * muted or resting person, or a subject on cooldown (the suggestions stage's cooldown table, when present).
 */
export function moreCandidates(db: DB, digestId: string, now: number, limit: number, mutedKinds: readonly string[] = []): Omit<ItemRow, 'ordinal'>[] {
  const cooldowns = hasTable(db, 'suggestion_cooldowns')
    ? `AND NOT EXISTS (SELECT 1 FROM suggestion_cooldowns sc WHERE sc.until > @now AND sc.reason <> 'shown' AND (sc.scope = 'subject:' || s.dedupe_key
         OR (s.person_id IS NOT NULL AND sc.scope = 'pk:' || coalesce((SELECT canonical_id FROM person_canon WHERE person_id = s.person_id), s.person_id) || '|' || s.kind)))`
    : '';
  const rows = db
    .prepare(
      `SELECT 0 AS ordinal, ${ITEM_COLS} FROM suggestions s
       WHERE s.status IN ('candidate','selected')
         AND s.kind NOT IN (SELECT value FROM json_each(@muted))
         AND (s.person_id IS NULL OR NOT EXISTS (SELECT 1 FROM learner_person_state lp
               WHERE lp.person_id = coalesce((SELECT canonical_id FROM person_canon WHERE person_id = s.person_id), s.person_id)
                 AND (lp.muted = 1 OR lp.cooldown_until > @now OR EXISTS (SELECT 1 FROM json_each(lp.muted_kinds) mk WHERE mk.value = s.kind))))
         ${cooldowns}
         AND (s.snoozed_until IS NULL OR s.snoozed_until <= @now)
         AND (s.cooldown_until IS NULL OR s.cooldown_until <= @now)
         AND (s.expires_at IS NULL OR s.expires_at > @now)
         AND s.id NOT IN (SELECT suggestion_id FROM digest_items WHERE digest_id = @d)
         AND s.id NOT IN (SELECT suggestion_id FROM command_more_items WHERE digest_id = @d)
         AND (s.person_id IS NULL OR EXISTS (SELECT 1 FROM person_visible pv
               WHERE pv.id = coalesce((SELECT canonical_id FROM person_canon WHERE person_id = s.person_id), s.person_id)))
       ORDER BY s.score DESC, s.created_at
       LIMIT @limit`,
    )
    .all({ d: digestId, now, limit, muted: JSON.stringify(mutedKinds) }) as RawItem[];
  return rows.map((r) => toItem(db, r));
}
