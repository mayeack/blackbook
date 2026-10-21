/**
 * Tickets, Gmail and Google Photos (design docs/design/tickets-met-at.md "Web and API" + "Review amendments").
 *
 *   GET  /api/v1/tickets?when=upcoming|past&cursor=&limit=   TicketsQuery → TicketList     (agent loop, routes/tickets.ts)
 *   GET  /api/v1/gmail/status                                → GmailStatus                   (routes/gmail.ts)
 *   POST /api/v1/gmail/disconnect      GoogleProductDisconnect → GmailDisconnectResult
 *   GET  /api/v1/gphotos/status                              → GphotosStatus                 (routes/gphotos.ts)
 *   POST /api/v1/gphotos/session       {}                    → GphotosSessionStart
 *   GET  /api/v1/gphotos/session/:id                         → GphotosSessionView
 *   POST /api/v1/gphotos/disconnect    GoogleProductDisconnect → GphotosDisconnectResult
 *
 * The Gmail and Photos paths answer 503 GOOGLE_NOT_CONFIGURED until the OAuth client exists, like /google/*.
 * Disconnecting one product never revokes the shared Google grant while another product still holds a token
 * (Google revokes the whole grant); when it does revoke, every product is disconnected.
 *
 * Nothing here carries an email address, a subject line, OCR text or a transfer counterparty's name: tickets show
 * the parsed event (title, performers, venue) and "met here" people come through person_visible as PersonChips.
 */
import { z } from 'zod';
import { Cursor, LocalDate, Ms, PersonChip } from './common';

// ------------------------------------------------------------------------------------------------ tickets

/** ticket_events.status: the quantity state machine's verdict ('unconfirmed' = mail about it, no proof of a ticket). */
export const TicketStatus = z.enum(['holding', 'unconfirmed', 'gave_away', 'sold', 'refunded', 'cancelled']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketCategory = z.enum(['concert', 'club', 'festival', 'comedy', 'theater', 'sports', 'party', 'talk', 'member_event', 'other']);
export type TicketCategory = z.infer<typeof TicketCategory>;

export const TicketsQuery = z.object({
  when: z.enum(['upcoming', 'past']).default('upcoming'),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type TicketsQuery = z.infer<typeof TicketsQuery>;

/** Ticket counts from the ledger; `held` = bought + received − sent − sold − refunded, null when a quantity was unknown. */
export const TicketQuantities = z.object({
  bought: z.number().int(),
  received: z.number().int(),
  sent: z.number().int(),
  sold: z.number().int(),
  refunded: z.number().int(),
});
export type TicketQuantities = z.infer<typeof TicketQuantities>;

export const TicketItem = z.object({
  /** ticket_events.id (a merged-away row is never listed). */
  id: z.string(),
  title: z.string(),
  performers: z.array(z.string()),
  category: TicketCategory,
  /** ≤3 broad tags the model inferred for the performers; may be empty. */
  genres: z.array(z.string()),
  venue: z.string().nullable(),
  city: z.string().nullable(),
  startsAt: Ms,
  endsAt: Ms.nullable(),
  /** The venue's local date. */
  localDate: LocalDate,
  status: TicketStatus,
  held: z.number().int().nullable(),
  quantities: TicketQuantities,
  /** Ticket vendors the emails came from ('ticketmaster', 'dice', …). */
  vendors: z.array(z.string()),
  /** The live get-together this ticket feeds (web: /e/:id), or null (not holding, or not built yet). */
  occasionId: z.string().nullable(),
  /** People the owner met there (active met-at links, visible people only), last name A–Z; at most 12 (metHereCount has all). */
  metHere: z.array(PersonChip),
  metHereCount: z.number().int(),
});
export type TicketItem = z.infer<typeof TicketItem>;

/**
 * Upcoming soonest first, past most recent first. A ticket feeding a sensitive get-together is never listed, so a page
 * can come back shorter than `limit` (even empty) while `nextCursor` still points on.
 */
export const TicketList = z.object({
  items: z.array(TicketItem),
  nextCursor: z.string().nullable(),
});
export type TicketList = z.infer<typeof TicketList>;

// ------------------------------------------------------------------------------------------------ Google products

/** The product's source_health row (error text redacted). */
export const SourceHealthView = z.object({
  status: z.string(),
  lastOkAt: Ms.nullable(),
  lastError: z.string().nullable(),
  checkedAt: Ms,
});
export type SourceHealthView = z.infer<typeof SourceHealthView>;

/** POST /gmail/disconnect, /gphotos/disconnect. */
export const GoogleProductDisconnect = z.object({ deleteData: z.boolean().optional() });
export type GoogleProductDisconnect = z.infer<typeof GoogleProductDisconnect>;

// ------------------------------------------------------------------------------------------------ Gmail

export const GmailCounts = z.object({
  /** Messages the ticket source looked at (any verdict). */
  scanned: z.number().int(),
  /** Messages triaged as ticket mail. */
  ticketEmails: z.number().int(),
  /** Ticket mail read by the model. */
  parsed: z.number().int(),
  /** Ticket mail waiting for the next ticket-parse batch. */
  pending: z.number().int(),
  /** Ticketed events in the ledger (merged rows excluded). */
  events: z.number().int(),
  /** Of those, still held and not over. */
  upcoming: z.number().int(),
});
export type GmailCounts = z.infer<typeof GmailCounts>;

export const GmailStatus = z.object({
  /** The Google OAuth client exists (the route answers 503 GOOGLE_NOT_CONFIGURED otherwise). */
  configured: z.boolean(),
  /** SECRETS_KEY is set (needed to store the refresh token). */
  secretsAvailable: z.boolean(),
  connected: z.boolean(),
  connectedAt: Ms.nullable(),
  /** Connected, but Google refused the stored grant (revoked, expired, or a password change): connect again. */
  needsReconnect: z.boolean(),
  lastSyncAt: Ms.nullable(),
  health: SourceHealthView.nullable(),
  counts: GmailCounts,
});
export type GmailStatus = z.infer<typeof GmailStatus>;

export const GmailDisconnectResult = z.object({
  connected: z.literal(false),
  /** The shared Google grant was revoked (only when no other Google product was still connected). */
  revoked: z.boolean(),
  /** With deleteData: rows deleted (ticketed get-togethers retire on the next occasions pass). */
  deleted: z.object({ messages: z.number().int(), tickets: z.number().int(), parties: z.number().int() }).optional(),
});
export type GmailDisconnectResult = z.infer<typeof GmailDisconnectResult>;

// ------------------------------------------------------------------------------------------------ Google Photos

export const GphotosSessionStatus = z.enum(['open', 'picked', 'done', 'expired', 'failed', 'cancelled']);
export type GphotosSessionStatus = z.infer<typeof GphotosSessionStatus>;

/** One Picker session's progress: picked → downloaded → read on the Mac → linked to a person. */
export const GphotosSessionView = z.object({
  id: z.string(),
  status: GphotosSessionStatus,
  itemsTotal: z.number().int(),
  /** Picked items not seen before. */
  itemsNew: z.number().int(),
  /** Screenshots read (OCR done, any outcome). */
  processed: z.number().int(),
  linked: z.number().int(),
  createdAt: Ms,
  expiresAt: Ms.nullable(),
});
export type GphotosSessionView = z.infer<typeof GphotosSessionView>;

export const GphotosSessionStart = z.object({
  sessionId: z.string(),
  /** Google's picker page; the web opens `pickerUri + '/autoclose'` in a new tab. */
  pickerUri: z.string(),
  expiresAt: Ms.nullable(),
});
export type GphotosSessionStart = z.infer<typeof GphotosSessionStart>;

export const GphotosStatus = z.object({
  configured: z.boolean(),
  secretsAvailable: z.boolean(),
  connected: z.boolean(),
  connectedAt: Ms.nullable(),
  needsReconnect: z.boolean(),
  health: SourceHealthView.nullable(),
  lastPickAt: Ms.nullable(),
  counts: z.object({
    screenshots: z.number().int(),
    /** Screenshots linked to a person. */
    linked: z.number().int(),
    /** Downloaded, waiting for the Mac helper to read them. */
    pendingOcr: z.number().int(),
  }),
  /**
   * The newest session still open or downloading, or one that changed within the last hour (so Settings can resume its
   * progress, or show how it ended, after a reload).
   */
  session: GphotosSessionView.nullable(),
});
export type GphotosStatus = z.infer<typeof GphotosStatus>;

export const GphotosDisconnectResult = z.object({
  connected: z.literal(false),
  revoked: z.boolean(),
  /** Downloaded screenshots deleted from disk (always). */
  filesDeleted: z.number().int(),
  /** Open picker sessions cancelled (always). */
  sessionsCancelled: z.number().int(),
  /** With deleteData: screenshot records deleted (the people they linked stay). */
  deleted: z.object({ screenshots: z.number().int() }).optional(),
});
export type GphotosDisconnectResult = z.infer<typeof GphotosDisconnectResult>;
