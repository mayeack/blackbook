/**
 * What the obligations passes read about the world, all through canon (merges are pointers) and the visibility
 * chokepoint (person_visible: never hidden, merged-away, roster-only, service or "me"):
 *   - the owner's names (for "addresses me");
 *   - the canonical, visible person behind a sender identity (service identities never count);
 *   - the direct conversations with a person on every channel (iMessage, WhatsApp, Instagram via Beeper, …);
 *   - my first outbound to them after a time (any channel), optionally one carrying an attachment or a link;
 *   - their first inbound attachment/link after a time (owner=them "send" items);
 *   - time together: logged / derived interactions (log:, calls, Partiful co-attendance, calendar occasions);
 *   - scheduled time together: counted occasion attendees and Partiful co-RSVPs, past or upcoming.
 * Bot rows (the digest and acks, is_bot = 1) and retracted messages never count as outbound.
 */
import type { DB } from '../../db/connection';
import { COMMITMENT } from './constants';
import { hasLink, meNames, type MeNames } from './text';

export interface OwnerProfile {
  meId: string | null;
  names: MeNames;
}

export function ownerProfile(db: DB): OwnerProfile {
  const me = db
    .prepare(`SELECT id, first_name, nickname, display_name FROM people WHERE kind = 'me' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`)
    .get() as { id: string; first_name: string | null; nickname: string | null; display_name: string } | undefined;
  if (!me) return { meId: null, names: { names: [] } };
  return { meId: me.id, names: meNames(me.first_name ?? me.display_name.split(' ')[0] ?? null, me.nickname) };
}

/** Canonical id of a person (follows person_canon; the id itself when it has no canon row). */
export function canonical(db: DB, personId: string): string {
  return (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(personId) as string | undefined) ?? personId;
}

export function isVisible(db: DB, personId: string): boolean {
  return db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck().get(personId) !== undefined;
}

/** Canonical visible person behind a sender identity, or null (services, suppressed, hidden, roster-only, me). */
export function senderPerson(db: DB, identityId: string | null): string | null {
  if (!identityId) return null;
  return (
    (db
      .prepare(
        `SELECT pc.canonical_id FROM identities i
         JOIN people p0 ON p0.id = i.person_id
         JOIN person_canon pc ON pc.person_id = i.person_id
         JOIN person_visible pv ON pv.id = pc.canonical_id
         WHERE i.id = ? AND i.status = 'active' AND p0.status NOT IN ('service','suppressed','roster_only') AND p0.kind = 'person'`,
      )
      .pluck()
      .get(identityId) as string | undefined) ?? null
  );
}

/** Direct conversations (any source) whose counterpart is one of `personIds` (canonical). */
export function dmConversationsOf(db: DB, personIds: readonly string[]): string[] {
  if (!personIds.length) return [];
  return db
    .prepare(
      `SELECT DISTINCT c.id FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN identities i ON i.id = cm.identity_id
       JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE c.kind = 'direct' AND pc.canonical_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(JSON.stringify(personIds)) as string[];
}

/** The canonical, visible counterpart of a direct conversation (null when none or ambiguous). */
export function dmCounterpart(db: DB, conversationId: string): string | null {
  const ids = db
    .prepare(
      `SELECT DISTINCT pc.canonical_id FROM conversation_members cm
       JOIN identities i ON i.id = cm.identity_id
       JOIN people p0 ON p0.id = i.person_id
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE cm.conversation_id = ? AND i.status = 'active' AND p0.status NOT IN ('service','suppressed','roster_only')`,
    )
    .pluck()
    .all(conversationId) as string[];
  return ids.length === 1 ? ids[0]! : null;
}

export interface MessageHit {
  id: number;
  at: number;
  conversationId: string;
}

interface MsgRow {
  id: number;
  sent_at: number;
  conversation_id: string;
  kind: string;
  text: string | null;
  attachments: string | null;
}

const carriesFile = (r: MsgRow): boolean =>
  r.kind === 'attachment' || r.kind === 'link' || hasLink(r.text) || (r.attachments !== null && r.attachments !== '[]' && r.attachments !== 'null');

const MESSAGE_OK = `retracted_at IS NULL AND is_bot = 0 AND is_spam = 0 AND dup_of IS NULL AND kind NOT IN ('system','group_event')`;

/**
 * My first message after `after` (exclusive) in any of `conversationIds`, ≤ `until`. With `withFile`, only one
 * carrying an attachment or a link counts.
 */
export function firstOutbound(
  db: DB,
  conversationIds: readonly string[],
  after: number,
  o: { until?: number; withFile?: boolean } = {},
): MessageHit | null {
  if (!conversationIds.length) return null;
  const rows = db
    .prepare(
      `SELECT id, sent_at, conversation_id, kind, text, attachments FROM messages
       WHERE conversation_id IN (SELECT value FROM json_each(@convs)) AND is_from_me = 1 AND ${MESSAGE_OK}
         AND sent_at > @after AND sent_at <= @until
       ORDER BY sent_at, id LIMIT @limit`,
    )
    .all({ convs: JSON.stringify(conversationIds), after, until: o.until ?? Number.MAX_SAFE_INTEGER, limit: o.withFile ? 500 : 1 }) as MsgRow[];
  const hit = o.withFile ? rows.find(carriesFile) : rows[0];
  return hit ? { id: hit.id, at: hit.sent_at, conversationId: hit.conversation_id } : null;
}

/** Their first inbound attachment/link after `after` in any of `conversationIds` from one of `personIds`. */
export function firstInboundFile(db: DB, conversationIds: readonly string[], personIds: readonly string[], after: number, until: number): MessageHit | null {
  if (!conversationIds.length || !personIds.length) return null;
  const rows = db
    .prepare(
      `SELECT m.id, m.sent_at, m.conversation_id, m.kind, m.text, m.attachments FROM messages m
       JOIN identities i ON i.id = m.sender_identity_id
       JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE m.conversation_id IN (SELECT value FROM json_each(@convs)) AND m.is_from_me = 0
         AND pc.canonical_id IN (SELECT value FROM json_each(@people))
         AND m.retracted_at IS NULL AND m.is_bot = 0 AND m.is_spam = 0 AND m.dup_of IS NULL AND m.kind NOT IN ('system','group_event')
         AND m.sent_at > @after AND m.sent_at <= @until
       ORDER BY m.sent_at, m.id LIMIT 500`,
    )
    .all({ convs: JSON.stringify(conversationIds), people: JSON.stringify(personIds), after, until }) as MsgRow[];
  const hit = rows.find(carriesFile);
  return hit ? { id: hit.id, at: hit.sent_at, conversationId: hit.conversation_id } : null;
}

export interface TogetherHit {
  /** interaction kind ('event', 'occasion', 'call', 'meeting', 'manual', 'text_log') or 'rsvp' / 'scheduled' */
  kind: string;
  /** Citation: 'i:<interaction id>', 'occ:<id>', 'event:<id>'. */
  ref: string;
  at: number;
}

/** Interaction kinds that mean "we were in touch outside the chat" (log:, calls, events, occasions). */
const TOGETHER_KINDS = `('event','occasion','call','meeting','manual','text_log')`;

/** First logged / derived time together with any of `personIds` in (after, until]. */
export function firstTogether(db: DB, personIds: readonly string[], after: number, until: number, kinds?: readonly string[]): TogetherHit | null {
  if (!personIds.length) return null;
  const r = db
    .prepare(
      `SELECT i.id, i.kind, i.started_at FROM interactions i
       JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(@people)) AND i.retracted_at IS NULL
         AND i.kind IN ${TOGETHER_KINDS} AND (@kinds IS NULL OR i.kind IN (SELECT value FROM json_each(@kinds)))
         AND i.started_at > @after AND i.started_at <= @until
       ORDER BY i.started_at, i.id LIMIT 1`,
    )
    .get({ people: JSON.stringify(personIds), after, until, kinds: kinds ? JSON.stringify(kinds) : null }) as
    | { id: string; kind: string; started_at: number }
    | undefined;
  return r ? { kind: r.kind, ref: `i:${r.id}`, at: r.started_at } : null;
}

const GOING = JSON.stringify(['going', 'attended', 'approved', 'checked_in', 'host']);

/**
 * First occasion (counted attendee, conf ≥ 0.75, social or unclassified, active) or Partiful event both of us
 * RSVP'd to, starting in (after, until] — upcoming ones included (the plan is on the calendar).
 */
export function firstScheduled(db: DB, personIds: readonly string[], after: number, until: number): TogetherHit | null {
  if (!personIds.length) return null;
  const people = JSON.stringify(personIds);
  const occ = db
    .prepare(
      `SELECT o.id, o.starts_at FROM event_attendees a
       JOIN occasions o ON o.id = a.occasion_id
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(@people)) AND a.occasion_id IS NOT NULL
         AND a.confidence >= @min AND a.status IN (SELECT value FROM json_each(@going))
         AND o.merged_into_id IS NULL AND o.status = 'active' AND coalesce(o.is_social, 1) = 1 AND o.sensitive = 0
         AND o.starts_at > @after AND o.starts_at <= @until
       ORDER BY o.starts_at LIMIT 1`,
    )
    .get({ people, min: COMMITMENT.attendeeMin, going: GOING, after, until }) as { id: string; starts_at: number } | undefined;
  const ev = db
    .prepare(
      `SELECT e.id, e.starts_at FROM event_attendees a
       JOIN events e ON e.id = a.event_id
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(@people)) AND a.event_id IS NOT NULL
         AND a.status IN (SELECT value FROM json_each(@going))
         AND (e.my_role = 'host' OR e.my_rsvp IN ('going','approved','checked_in','attended'))
         AND coalesce(e.status, '') NOT LIKE '%cancel%' AND e.starts_at > @after AND e.starts_at <= @until
       ORDER BY e.starts_at LIMIT 1`,
    )
    .get({ people, going: GOING, after, until }) as { id: string; starts_at: number } | undefined;
  const hits: TogetherHit[] = [];
  if (occ) hits.push({ kind: 'scheduled', ref: `occ:${occ.id}`, at: occ.starts_at });
  if (ev) hits.push({ kind: 'rsvp', ref: `event:${ev.id}`, at: ev.starts_at });
  hits.sort((a, b) => a.at - b.at);
  return hits[0] ?? null;
}

/** Tie strength T (0–100) and the priority flag of a canonical person. */
export function tieOf(db: DB, personId: string): { tie: number | null; priority: boolean } {
  const r = db
    .prepare(`SELECT p.is_priority, s.tie_strength FROM people p LEFT JOIN person_stats s ON s.person_id = p.id WHERE p.id = ?`)
    .get(personId) as { is_priority: number; tie_strength: number | null } | undefined;
  return { tie: r?.tie_strength ?? null, priority: r?.is_priority === 1 };
}

/** created_at of the latest change to a journaled row when that change was an undo (else null). */
export function undoneAt(db: DB, table: 'reply_debts' | 'commitments', id: string): number | null {
  const r = db
    .prepare(
      `SELECT cb.kind, cb.created_at FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
       WHERE cl.entity = ? AND cl.entity_key = ? ORDER BY cl.seq DESC LIMIT 1`,
    )
    .get(table, id) as { kind: string; created_at: number } | undefined;
  return r?.kind === 'undo' ? r.created_at : null;
}
