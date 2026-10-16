/**
 * Event and travel intel (intelligence §5 "Travel intel", "Event intel").
 *
 *   GET /api/v1/events/:id/brief       → EventBrief   (an occasion id or a Partiful event id, like GET /events/:id)
 *   GET /api/v1/trips?when=upcoming|past|all   → TripsResponse
 *
 * Sensitive occasions (medical) and non-social kinds never get a brief.
 */
import { z } from 'zod';
import { LocalDate, Ms, PersonChip } from './common';
import { OpenLoop } from './loops';

export const BriefAttendee = z.object({
  person: PersonChip,
  tieStrength: z.number().nullable(),
  lastContactAt: Ms.nullable(),
  /** going / maybe / possible / companion …, as on the event page. */
  status: z.string(),
  confidence: z.number(),
  openLoops: z.array(OpenLoop),
  /** One recent, non-sensitive fact. */
  recentFact: z.object({ id: z.string(), type: z.string(), value: z.string() }).nullable(),
});
export type BriefAttendee = z.infer<typeof BriefAttendee>;

export const EventBrief = z.object({
  id: z.string(),
  type: z.enum(['occasion', 'event']),
  title: z.string().nullable(),
  kind: z.string(),
  startsAt: Ms,
  endsAt: Ms.nullable(),
  venue: z.string().nullable(),
  /** Top known attendees by tie strength (≤5 in the digest, all here). */
  attendees: z.array(BriefAttendee),
  /** Guest names with no matching person (Partiful list), as shown by Partiful. */
  unknownGuests: z.array(z.string()),
  /** Mutual connectors: known people who link you to several attendees. */
  connectors: z.array(z.object({ person: PersonChip, knows: z.array(PersonChip) })),
  followUp: z
    .object({
      status: z.enum(['none', 'pending', 'suggested', 'done']),
      suggestionId: z.string().nullable(),
    })
    .nullable(),
  composer: z.enum(['llm', 'template']),
  generatedAt: Ms,
});
export type EventBrief = z.infer<typeof EventBrief>;

/** Why a person matched a trip destination. */
export const TripMatchReason = z.enum(['location_current', 'location_next', 'travel_plan', 'addressbook', 'partiful', 'legacy_location']);
export type TripMatchReason = z.infer<typeof TripMatchReason>;

export const TripPerson = z.object({
  person: PersonChip,
  reason: TripMatchReason,
  /** "lives there since Mar". */
  detail: z.string().nullable(),
  score: z.number(),
  factId: z.string().nullable(),
});
export type TripPerson = z.infer<typeof TripPerson>;

export const Trip = z.object({
  id: z.string(),
  /** Destination metro label ("Austin"). */
  label: z.string().nullable(),
  geoKey: z.string(),
  startsOn: LocalDate,
  endsOn: LocalDate,
  sourceEventIds: z.array(z.string()),
  people: z.array(TripPerson),
  suggestionId: z.string().nullable(),
});
export type Trip = z.infer<typeof Trip>;

/** Inverse case: people coming to the owner's metro (travel_plan facts). */
export const Visitor = z.object({
  person: PersonChip,
  startsOn: LocalDate,
  endsOn: LocalDate.nullable(),
  factId: z.string(),
  suggestionId: z.string().nullable(),
});
export type Visitor = z.infer<typeof Visitor>;

export const TripsQuery = z.object({ when: z.enum(['upcoming', 'past', 'all']).default('upcoming') });
export type TripsQuery = z.infer<typeof TripsQuery>;

export const TripsResponse = z.object({
  trips: z.array(Trip),
  visitors: z.array(Visitor),
  /** Home metro used for "away" detection (null = unknown: set Settings → travel.home_city). */
  home: z.string().nullable(),
});
export type TripsResponse = z.infer<typeof TripsResponse>;
