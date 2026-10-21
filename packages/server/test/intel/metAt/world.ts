/**
 * Synthetic met-at fixtures on top of the intel world (test/intel/world.ts): Instagram follows, address-book cards,
 * contact screenshots, Instagram DMs, ticket occasions and Partiful events. Every name, handle, venue and id is
 * invented; phones are 555-01xx, emails example.com.
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../../src/db/canon';
import type { DB } from '../../../src/db/connection';
import { seedIdentity } from '../../helpers';
import { DAY, HOUR, intelWorld, MIN, NOW, occasion, type IntelWorld } from '../world';

export { DAY, HOUR, MIN, NOW };

/** `h:00` UTC, `days` from 2026-10-14 (negative = the past). */
export const on = (days: number, h = 20, m = 0) => Date.UTC(2026, 9, 14 + days, h, m, 0);

let seq = 0;
const next = () => ++seq;

export interface MetWorld extends IntelWorld {
  /** A roster-only person (a DYI follow, a Partiful guest nobody knows yet). */
  stranger(first: string, last: string): string;
  /** An instagram_username identity on the person (returns the identity id). */
  handle(personId: string, username: string): string;
  follow(personId: string, at: number, o?: { direction?: 'following' | 'follower'; username?: string }): string;
  card(personId: string, o: { createdAt?: number | null; firstSeenAt?: number; given?: string | null; family?: string | null; removed?: boolean }): string;
  shot(personId: string, takenAt: number, o?: { followers?: number; status?: string }): string;
  /** A direct Instagram chat (Beeper) with the person: messages at the given times, the first one theirs. */
  igDm(personId: string, o: { firstAt: number; createdAt?: number; complete?: boolean; ownerReplyAfter?: number | null; dyi?: boolean; source?: 'instagram' | 'instagram_dyi' }): string;
  /** A social occasion carrying a ticket source (ticket_events + occasion_sources 'ticket'). */
  ticketShow(o: { title: string; start: number; end?: number | null; performers?: string[]; category?: string; venue?: string | null }): { occasionId: string; ticketId: string };
  social(o: { title: string; start: number; end?: number; venue?: string | null; eventId?: string | null }): string;
  merge(loser: string, survivor: string): void;
  status(personId: string): string;
}

export function metWorld(): MetWorld {
  const w = intelWorld();
  const db = w.db;
  const igIdentity = new Map<string, string>();
  const handle = (personId: string, username: string) => {
    const id = seedIdentity(db, personId, 'instagram_username', username);
    igIdentity.set(personId, id);
    return id;
  };
  return {
    ...w,
    stranger(first, last) {
      const id = w.person(first, last);
      db.prepare(`UPDATE people SET status = 'roster_only' WHERE id = ?`).run(id);
      return id;
    },
    handle,
    follow(personId, at, o = {}) {
      const ident = o.username ? handle(personId, o.username) : (igIdentity.get(personId) ?? handle(personId, `sample.user${next()}`));
      db.prepare(
        `INSERT INTO instagram_follows (identity_id, direction, followed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(ident, o.direction ?? 'following', at, NOW, NOW);
      return ident;
    },
    card(personId, o) {
      const ident = seedIdentity(db, personId, 'addressbook_id', `card-${next()}`, o.removed ? { status: 'detached' } : {});
      const cardId = `C${next()}`;
      db.prepare(
        `INSERT INTO addressbook_cards (card_id, identity_id, content_hash, fields, modified_at, first_seen_at, last_seen_at, removed_at, created_at)
         VALUES (?, ?, 'h', ?, NULL, ?, ?, ?, ?)`,
      ).run(
        cardId,
        ident,
        JSON.stringify({ displayName: null, given: o.given === undefined ? 'Given' : o.given, family: o.family === undefined ? 'Family' : o.family, nickname: null, org: null, job: null, birthday: null }),
        o.firstSeenAt ?? NOW - DAY,
        NOW,
        o.removed ? NOW : null,
        o.createdAt === undefined ? null : o.createdAt,
      );
      return cardId;
    },
    shot(personId, takenAt, o = {}) {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO contact_screenshots (id, source, source_ref, taken_at, status, kind, person_id, found, created_at, updated_at)
         VALUES (?, 'gphotos', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        `item-${next()}`,
        takenAt,
        o.status ?? 'linked',
        o.followers === undefined ? 'contact_card' : 'instagram_profile',
        personId,
        JSON.stringify(o.followers === undefined ? {} : { followers: o.followers }),
        NOW,
        NOW,
      );
      return id;
    },
    igDm(personId, o) {
      const n = next();
      const ident = seedIdentity(db, personId, 'instagram_id', `igid${n}`);
      const conv = uuidv7();
      const source = o.source ?? 'instagram';
      const scope = `!chat${n}:beeper.local`;
      db.prepare(
        `INSERT INTO conversations (id, source, source_conv_id, kind, member_count, first_message_at, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, 'direct', 2, ?, ?, ?, ?)`,
      ).run(conv, source, scope, o.firstAt, o.firstAt + HOUR, o.createdAt ?? o.firstAt + 5 * MIN, NOW);
      db.prepare(`INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`).run(
        conv,
        ident,
        o.firstAt,
        NOW,
      );
      const say = (at: number, fromMe: boolean) =>
        db
          .prepare(
            `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'text', 'hey', ?, ?)`,
          )
          .run(source, uuidv7(), conv, fromMe ? null : ident, fromMe ? 1 : 0, at, NOW, NOW);
      say(o.firstAt, false);
      const reply = o.ownerReplyAfter === undefined ? 10 * MIN : o.ownerReplyAfter;
      if (reply !== null) say(o.firstAt + reply, true);
      if (source === 'instagram') {
        db.prepare(`INSERT INTO source_cursors (source, scope, cursor, high_water_at, meta, updated_at) VALUES ('instagram', ?, '', ?, ?, ?)`).run(
          scope,
          o.firstAt,
          JSON.stringify({ initialized: true, complete: o.complete ?? true }),
          NOW,
        );
      }
      if (o.dyi || source === 'instagram_dyi') {
        db.prepare(`INSERT INTO ig_dyi_threads (thread_key, conversation_id, matched, votes, created_at, updated_at) VALUES (?, ?, ?, 3, ?, ?)`).run(
          `t${n}`,
          conv,
          source === 'instagram' ? 1 : 0,
          NOW,
          NOW,
        );
      }
      return conv;
    },
    ticketShow(o) {
      const ticketId = uuidv7();
      const end = o.end === undefined ? o.start + 4 * HOUR : o.end;
      db.prepare(
        `INSERT INTO ticket_events (id, title, title_key, performers, category, venue, venue_key, starts_at, ends_at, tz, local_date, qty_bought, held, status,
           emails, first_email_at, last_email_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UTC', ?, 2, 2, 'holding', 1, ?, ?, ?, ?)`,
      ).run(
        ticketId,
        o.title,
        o.title.toLowerCase(),
        JSON.stringify(o.performers ?? []),
        o.category ?? 'concert',
        o.venue ?? null,
        o.venue ? o.venue.toLowerCase() : null,
        o.start,
        end,
        new Date(o.start).toISOString().slice(0, 10),
        o.start - 30 * DAY,
        o.start - 30 * DAY,
        NOW,
        NOW,
      );
      const occasionId = occasion(db, { title: o.title, start: o.start, end: end ?? undefined, venue: o.venue ?? null });
      if (end === null) db.prepare('UPDATE occasions SET ends_at = NULL WHERE id = ?').run(occasionId);
      if (o.venue) db.prepare('UPDATE occasions SET venue_key = ? WHERE id = ?').run(o.venue.toLowerCase(), occasionId);
      db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, 'ticket', ?, 'primary', ?)`).run(occasionId, ticketId, NOW);
      return { occasionId, ticketId };
    },
    social(o) {
      const id = occasion(db, { title: o.title, start: o.start, end: o.end, venue: o.venue ?? null, eventId: o.eventId ?? null });
      if (o.venue) db.prepare('UPDATE occasions SET venue_key = ? WHERE id = ?').run(o.venue.toLowerCase(), id);
      return id;
    },
    merge(loser, survivor) {
      db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(survivor, loser);
      rebuildPersonCanon(db);
    },
    status: (id) => db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(id) as string,
  };
}
