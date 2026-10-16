/**
 * Building blocks shared by every agent-loop DTO (today, suggestions, person extras, network, ask, …).
 *
 * Conventions (all routes under /api/v1, behind Cloudflare Access):
 *   - times are Unix ms (`Ms`); calendar days are local `YYYY-MM-DD` strings in the `tz` setting;
 *   - ids are the server's own: people/circles/notes are UUIDv7, messages are INTEGER (`m:<id>` in citations);
 *   - every person in a response came through person_visible (never hidden, merged-away or roster-only people);
 *   - phones and emails never appear in any of these shapes (Person → Linked accounts masks them separately);
 *   - mutating routes take JSON + `X-YB: 1` and answer the journal batch they wrote (`batchId`, undoable from Today).
 */
import { z } from 'zod';

export const Ms = z.number().int();
export type Ms = z.infer<typeof Ms>;

/** Local calendar day, `YYYY-MM-DD`. */
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type LocalDate = z.infer<typeof LocalDate>;

/** `HH:MM`, 24 h. */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type HHMM = z.infer<typeof HHMM>;

/** A UUID path/body id (people, circles, tags, locations, notes, suggestions, digests, batches, …). */
export const UuidId = z.string().regex(/^[0-9a-f-]{36}$/i);

/** Cadence state labels (person_stats.state); intelligence §3 "UI labels". */
export const TieState = z.enum(['strong', 'steady', 'cooling', 'fading', 'dormant', 'new']);
export type TieState = z.infer<typeof TieState>;

/** Pair strength tiers (edge_stats.tier): close ≥0.75, know 0.40–0.75, acquainted 0.15–0.40, faint <0.15. */
export const EdgeTier = z.enum(['close', 'know', 'acquainted', 'faint']);
export type EdgeTier = z.infer<typeof EdgeTier>;

/** A person as a tappable chip (the web wraps every chip/avatar in a <PersonLink> to /p/:id). */
export const PersonChip = z.object({
  id: z.string(),
  displayName: z.string(),
  firstName: z.string().nullable(),
  state: TieState.nullable(),
});
export type PersonChip = z.infer<typeof PersonChip>;

/** What a piece of evidence points at. */
export const EvidenceKind = z.enum(['message', 'fact', 'event', 'occasion', 'conversation', 'person', 'commitment', 'reply_debt', 'edge', 'note']);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * One cited piece of evidence. `ref` is the stable citation id: `m:8812` (message), `F<id>` (fact), `E<id>` (event or
 * occasion), `P<id>` (person), `K<id>` (commitment), `conv:<id>`, `occ:<id>`. Quotes are short (≤200 chars) and
 * never contain phone numbers or emails; sensitive evidence is never quoted.
 */
export const EvidenceRef = z.object({
  kind: EvidenceKind,
  ref: z.string(),
  /** Short human label: "iMessage · Oct 3", "Ski Trip 2026", "Friendsgiving". */
  label: z.string().nullable(),
  at: Ms.nullable(),
  quote: z.string().nullable(),
  /** Raw source of a message/event ('imessage', 'whatsapp', 'beeper', 'partiful', 'calendar', …). */
  source: z.string().nullable(),
  /** Web deep link (relative: `/p/<id>?m=8812`, `/e/<id>`, `/c/<id>`), or null. */
  href: z.string().nullable(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** Answer of a journaled write: the change_batches id (null when nothing changed). */
export const BatchRef = z.object({ batchId: z.string().nullable() });
export type BatchRef = z.infer<typeof BatchRef>;

export const OkResult = z.object({ ok: z.literal(true) });
export type OkResult = z.infer<typeof OkResult>;

/** A due date as extracted (commitments.due_*). */
export const DueWindow = z.object({
  precision: z.enum(['date', 'range', 'vague', 'none']),
  start: Ms.nullable(),
  end: Ms.nullable(),
});
export type DueWindow = z.infer<typeof DueWindow>;

/** Collections (Circles | Tags | Locations). */
export const CollectionType = z.enum(['circle', 'tag', 'location']);
export type CollectionType = z.infer<typeof CollectionType>;

export const CollectionChip = z.object({
  type: CollectionType,
  id: z.string(),
  name: z.string(),
  /** Circles only: 'auto' (agent-maintained) or 'user'. */
  kind: z.enum(['auto', 'user']).nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
});
export type CollectionChip = z.infer<typeof CollectionChip>;

/** Query-string booleans ("1"/"true"/"0"/"false"). */
export const QueryBool = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === '1' || v === 'true'));

/** Opaque pagination cursor (server-defined). */
export const Cursor = z.string().min(1).max(200);
