/**
 * Thresholds of the obligations passes (intelligence §5 "Reply debt", "Commitments"). Learning never changes
 * these (PLAN "Scope limit"); they move only through `npm run eval` plus a code change.
 */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const REPLY_DEBT = {
  /** A DM's last inbound message must be at least this old. */
  dmMinAgeMs: 4 * HOUR,
  /** A small group's (n ≤ groupMaxSize, me included) last inbound message must be at least this old. */
  groupMinAgeMs: 12 * HOUR,
  groupMaxSize: 8,
  /** No new debts on messages older than this; open ones become 'dropped' this long after they were asked. */
  expiryMs: 30 * DAY,
  /** Heuristic-only debts need h ≥ this (shown as "likely"). */
  heuristicMin: 0.6,
  /** The extraction says needs_reply with conf ≥ this → debt. */
  llmNeedsReplyMin: 0.6,
  /** The extraction says no_reply_needed / already_replied with conf ≥ this → suppressed / closed. */
  llmSuppressMin: 0.7,
  /** Messages of the unanswered run that are scored (newest first). */
  maxRunMessages: 12,
  /** Priority: age_w = min(1, age_h / 48); × 0.5 after 14 days. */
  ageFullH: 48,
  staleAfterMs: 14 * DAY,
  staleFactor: 0.5,
  urgency: { high: 1.5, normal: 1.0, low: 0.6 } as const,
} as const;

export const COMMITMENT = {
  /** Extraction gate (intelligence §4.5 table). */
  gate: 0.7,
  /** A vague / undated commitment becomes 'due' this long after it was made. */
  vagueDueMs: 21 * DAY,
  /** 'lapsed' this long after the (effective) due end with no signal. */
  lapseMs: 30 * DAY,
  /** meet / plan / call close on a co-attendance, calendar event, log or call in [made_at, due_end + this]. */
  closeGraceMs: 7 * DAY,
  /** reply_later (owner me) closes on an outbound to them at least this long after it was made. */
  replyLaterMinMs: 2 * HOUR,
  /** Counted attendee confidence (PLAN "Calendar attendee inference": ≥ 0.75 is an attendee). */
  attendeeMin: 0.75,
  /** "Did this happen?" is asked once, for commitments whose natural lapse time is this recent. */
  lapseAskWindowMs: 7 * DAY,
  /** Open commitments due within this are surfaced as coming up. */
  upcomingMs: 24 * HOUR,
  /** Dedup of repeated extractions: token Jaccard of `what`. */
  similarWhat: 0.5,
  /** Waiting-on (owner them) items surface only for priority people or T ≥ this, at rank weight × waitingWeight. */
  waitingMinTie: 60,
  waitingWeight: 0.5,
  /** chrono wins over the LLM's due date when they disagree by more than this. */
  chronoToleranceMs: 2 * DAY,
  /** Rank weight by stakes (stakes.ts): low-stakes promises never reach the digest or Today's preview. */
  stakesWeight: { high: 1, normal: 0.8, low: 0 } as const,
} as const;

/** Statuses an open loop can still change from. */
export const LIVE_DEBT = ['open', 'snoozed'] as const;
export const LIVE_COMMITMENT = ['open', 'due', 'snoozed'] as const;

/** Slice length of the async passes before the event loop gets a turn (the 10 s iMessage tail stays responsive). */
export const SLICE_MS = 25;
