/**
 * Synthetic ticket fixtures for the event_invite and similarity tests: ticket_events rows as the Gmail ledger leaves
 * them, ticket occasions (occasion_sources 'ticket'), met-at links, contact screenshots and ticket counterparties.
 * Every name, performer, venue and id is invented; emails use example.com.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import { DAY, NOW, occasion } from './world';

/** A ticket_events row (the ledger's shape; only what similarity reads matters). */
export function ticketEvent(
  db: DB,
  o: {
    title: string;
    start: number;
    performers?: string[];
    genres?: string[];
    category?: string;
    venue?: string | null;
    venueKey?: string | null;
    localDate?: string;
    status?: string;
    partifulIds?: string[];
    mergedInto?: string | null;
  },
): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO ticket_events (id, title, title_key, performers, genres, category, venue, venue_key, starts_at, local_date, partiful_ids, held, status,
       first_email_at, last_email_at, merged_into_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.title,
    o.title.toLowerCase(),
    JSON.stringify(o.performers ?? []),
    JSON.stringify(o.genres ?? []),
    o.category ?? 'concert',
    o.venue ?? null,
    o.venueKey ?? null,
    o.start,
    o.localDate ?? new Date(o.start).toISOString().slice(0, 10),
    JSON.stringify(o.partifulIds ?? []),
    o.status ?? 'holding',
    NOW - 30 * DAY,
    NOW - 30 * DAY,
    o.mergedInto ?? null,
    NOW,
    NOW,
  );
  return id;
}

/** An occasion with a ticket source (occasion_sources.source 'ticket', source_ref = the ticket event). */
export function ticketOccasion(db: DB, ticketId: string, o: { title: string; start: number; venue?: string | null; eventId?: string | null; sensitive?: boolean }): string {
  const id = occasion(db, { title: o.title, start: o.start, end: o.start + 4 * 3_600_000, venue: o.venue ?? null, eventId: o.eventId ?? null, sensitive: o.sensitive });
  db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, 'ticket', ?, 'primary', ?)`).run(id, ticketId, NOW);
  return id;
}

/** A person_met_at row as intel/metAt writes it (target an occasion or a Partiful event). */
export function metAt(
  db: DB,
  personId: string,
  target: { occasionId?: string; eventId?: string },
  o: { confidence?: number; signal?: string; status?: string; at?: number } = {},
): string {
  const id = uuidv7();
  const key = target.occasionId ? `o:${target.occasionId}` : `e:${target.eventId}`;
  db.prepare(
    `INSERT INTO person_met_at (id, person_id, occasion_id, event_id, target_key, signal, signal_at, confidence, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inferred', ?, ?)`,
  ).run(id, personId, target.occasionId ?? null, target.eventId ?? null, key, o.signal ?? 'contact_added', o.at ?? NOW - 20 * DAY, o.confidence ?? 0.8, o.status ?? 'active', NOW, NOW);
  return id;
}

/** A linked contact screenshot of the person (the screenshot-people flag). */
export function screenshotOf(db: DB, personId: string, o: { followers?: number } = {}): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO contact_screenshots (id, source, source_ref, taken_at, status, kind, person_id, found, created_at, updated_at)
     VALUES (?, 'gphotos', ?, ?, 'linked', 'contact_card', ?, ?, ?, ?)`,
  ).run(id, `item-${id.slice(-6)}`, NOW - 25 * DAY, personId, JSON.stringify(o.followers !== undefined ? { followers: o.followers } : {}), NOW, NOW);
  return id;
}

/** A ticket counterparty on a ticket email (sent_to: the owner transferred tickets to them). */
export function ticketParty(
  db: DB,
  ticketEventId: string,
  o: { name?: string | null; emailKey?: string | null; personId?: string | null; direction?: 'sent_to' | 'received_from'; viaMessageOnly?: boolean },
): string {
  const gmailId = `msg${uuidv7().replace(/-/g, '').slice(-12)}`;
  db.prepare(
    `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, from_domain, triage, parse_status, ticket_event_id, created_at, updated_at)
     VALUES (?, ?, ?, 'tickets.example', 'candidate', 'parsed', ?, ?, ?)`,
  ).run(gmailId, `thr-${gmailId.slice(-6)}`, NOW - 3 * DAY, ticketEventId, NOW, NOW);
  db.prepare(
    `INSERT INTO ticket_parties (gmail_id, direction, name, email_key, quantity, person_id, ticket_event_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(gmailId, o.direction ?? 'sent_to', o.name ?? null, o.emailKey ?? null, o.personId ?? null, o.viaMessageOnly ? null : ticketEventId, NOW, NOW);
  return gmailId;
}
