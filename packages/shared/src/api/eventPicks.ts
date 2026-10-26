/**
 * Weekly event picks (design docs/design/event-picks.md; server intel/eventPicks, routes/eventPicks.ts):
 *
 *   GET  /event-picks                  → EventPicksResponse   the latest week's picks (sent or ready) + what was learned
 *   POST /event-picks/:id/feedback     ← EventPickFeedback    → EventPickItem   the owner's own answer on one pick
 *
 * Ticket links are not in the DTO: the web opens /go/<id> like the texts do (the server counts the tap and redirects
 * to the checked ticket page).
 */
import { z } from 'zod';
import { Ms } from './common';

export const EventPickStatus = z.enum(['picked', 'going', 'not_for_me', 'passed']);
export type EventPickStatus = z.infer<typeof EventPickStatus>;

export const EventPickItem = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  title: z.string(),
  performers: z.array(z.string()),
  venue: z.string(),
  /** YYYY-MM-DD, the event's local date. */
  localDate: z.string(),
  /** HH:MM or null when the page didn't say. */
  startTime: z.string().nullable(),
  category: z.string(),
  genres: z.array(z.string()),
  /** 'ticket' = the event's own ticket page; 'resale'; 'listing' = a page listing many events. */
  linkKind: z.enum(['ticket', 'resale', 'listing']).nullable(),
  /** The ticket page's site ("dice.fm"), for the button label. */
  ticketHost: z.string().nullable(),
  why: z.string().nullable(),
  wildcard: z.boolean(),
  status: EventPickStatus,
  /** Who decided the status: the owner, a ticket / calendar / Partiful entry yeackbot found, or the date passing. */
  outcomeSource: z.enum(['owner', 'ticket', 'calendar', 'partiful', 'date']).nullable(),
  clicks: z.number().int(),
});
export type EventPickItem = z.infer<typeof EventPickItem>;

export const EventPicksWeek = z.object({
  weekStart: z.string(),
  windowEnd: z.string(),
  status: z.enum(['ready', 'sent']),
  city: z.string().nullable(),
  freeNights: z.array(z.string()),
  sentAt: Ms.nullable(),
  /** Events the web search found that week (picked or not). */
  found: z.number().int(),
  searches: z.number().int(),
  picks: z.array(EventPickItem),
});
export type EventPicksWeek = z.infer<typeof EventPicksWeek>;

export const EventPicksResponse = z.object({
  week: EventPicksWeek.nullable(),
  /** Answers over all sent picks, the ranker's learning signal. */
  history: z.object({ going: z.number().int(), notForMe: z.number().int(), passed: z.number().int(), open: z.number().int() }),
  enabled: z.boolean(),
});
export type EventPicksResponse = z.infer<typeof EventPicksResponse>;

export const EventPickFeedback = z.object({ verdict: z.enum(['going', 'not_for_me', 'undo']) });
export type EventPickFeedback = z.infer<typeof EventPickFeedback>;
