/**
 * Synthetic ticket-ledger rows for the occasions tests (design docs/design/tickets-met-at.md §1): ticket_events as
 * adapters/gmail/ledger.ts would leave them, plus the gmail_messages / ticket_parties a transfer counterparty needs.
 * Every title, performer, venue and name is invented; sender domains are *.example.
 */
import { localDate, uuidv7 } from '@yb/shared';
import type { DB } from '../../../src/db/connection';
import { words } from '../../../src/pipeline/occasions/text';
import { HOUR, NOW } from './world';

export interface TicketInput {
  title: string;
  performers?: string[];
  category?: string;
  venue?: string | null;
  city?: string | null;
  start: number;
  end?: number | null;
  /** The venue's zone; null = guessed (default 'UTC'). */
  tz?: string | null;
  localDate?: string;
  partifulIds?: string[];
  bought?: number;
  received?: number;
  sent?: number;
  sold?: number;
  refunded?: number;
  /** Default: bought + received − sent − sold − refunded. */
  held?: number | null;
  status?: 'holding' | 'unconfirmed' | 'gave_away' | 'sold' | 'refunded' | 'cancelled';
  mergedInto?: string | null;
}

export function ticketEvent(db: DB, t: TicketInput): string {
  const id = uuidv7();
  const tz = t.tz === undefined ? 'UTC' : t.tz;
  const q = { bought: t.bought ?? 2, received: t.received ?? 0, sent: t.sent ?? 0, sold: t.sold ?? 0, refunded: t.refunded ?? 0 };
  db.prepare(
    `INSERT INTO ticket_events (id, title, title_key, performers, genres, category, venue, venue_key, city, starts_at, ends_at, tz, local_date,
       vendors, vendor_event_ids, partiful_ids, qty_bought, qty_received, qty_sold, qty_sent, qty_refunded, held, status, emails,
       first_email_at, last_email_at, merged_into_id, created_at, updated_at)
     VALUES (@id, @title, @title_key, @performers, '[]', @category, @venue, @venue_key, @city, @start, @end, @tz, @local_date,
       '["examplevendor"]', '[]', @partiful, @bought, @received, @sold, @sent, @refunded, @held, @status, 1, @at, @at, @merged, @at, @at)`,
  ).run({
    id,
    title: t.title,
    title_key: words(t.title).join(' '),
    performers: JSON.stringify(t.performers ?? []),
    category: t.category ?? 'concert',
    venue: t.venue === undefined ? null : t.venue,
    venue_key: t.venue ? words(t.venue).join(' ') : null,
    city: t.city === undefined ? null : t.city,
    start: t.start,
    end: t.end === undefined ? t.start + 4 * HOUR : t.end,
    tz,
    local_date: t.localDate ?? localDate(t.start, tz ?? 'UTC'),
    partiful: JSON.stringify(t.partifulIds ?? []),
    ...q,
    held: t.held === undefined ? q.bought + q.received - q.sent - q.sold - q.refunded : t.held,
    status: t.status ?? 'holding',
    merged: t.mergedInto ?? null,
    at: NOW - 40 * 24 * HOUR,
  });
  return id;
}

export function updateTicket(db: DB, id: string, patch: Record<string, unknown>): void {
  const cols = Object.keys(patch);
  db.prepare(`UPDATE ticket_events SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
}

let mail = 0;

/** A transfer counterparty on one of the ticket's emails (a synthetic Gmail message carries it). */
export function ticketParty(db: DB, ticketId: string, p: { direction: 'sent_to' | 'received_from'; personId?: string | null; name?: string; quantity?: number }): void {
  const gmailId = `synthmsg${String(++mail).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, from_domain, vendor, subject, triage, parse_status, ticket_event_id, created_at, updated_at)
     VALUES (?, ?, ?, 'tickets.example', 'examplevendor', 'Your tickets are on their way', 'candidate', 'parsed', ?, ?, ?)`,
  ).run(gmailId, `thread${gmailId}`, NOW - 30 * 24 * HOUR, ticketId, NOW, NOW);
  db.prepare(
    `INSERT INTO ticket_parties (gmail_id, direction, name, email_key, quantity, person_id, ticket_event_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(gmailId, p.direction, p.name ?? 'Synthetic Friend', p.quantity ?? 1, p.personId ?? null, ticketId, NOW, NOW);
}

/** The occasion a ticket event is a source of (by its ref as stored). */
export function occasionOfTicketRef(db: DB, ticketId: string): string | undefined {
  return db.prepare(`SELECT occasion_id FROM occasion_sources WHERE source = 'ticket' AND source_ref = ?`).pluck().get(ticketId) as string | undefined;
}
