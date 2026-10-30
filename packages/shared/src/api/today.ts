/**
 * Today screen: GET /api/v1/today?date=YYYY-MM-DD (default: today in the `tz` setting).
 *
 * Order on screen: header (date + delivery status) → alerts banner → digest cards → Open loops strip →
 * "Check these" → "What the agent did" (the existing GET /activity feed, grouped by run).
 */
import { z } from 'zod';
import { ActivityBatch } from './activity';
import { LocalDate, Ms } from './common';
import { Alert } from './alerts';
import { OpenLoop, OpenLoopCounts } from './loops';
import { DigestItem } from './suggestions';

export const DigestStatus = z.enum(['composing', 'ready', 'sent', 'fallback_sent', 'skipped', 'failed']);
export type DigestStatus = z.infer<typeof DigestStatus>;

/** Per-channel delivery state for the header ("Sent 8:00 via iMessage ✓ · email ✓"). */
export const ChannelDelivery = z.enum(['sent', 'pending', 'skipped', 'failed', 'disabled', 'not_configured']);
export type ChannelDelivery = z.infer<typeof ChannelDelivery>;

export const TodayDigest = z.object({
  id: z.string(),
  localDate: LocalDate,
  status: DigestStatus,
  itemCap: z.number().int().nullable(),
  composedAt: Ms.nullable(),
  sentAt: Ms.nullable(),
  pushSentAt: Ms.nullable(),
  imessage: ChannelDelivery,
  push: ChannelDelivery,
  /** The brief emailed to the owner's own Gmail (settings digest.email). */
  email: ChannelDelivery,
  emailSentAt: Ms.nullable(),
  /** Why nothing went out ('disabled', 'paused', 'empty', 'quiet_hours', 'catch_up_passed', 'llm_unavailable', …). */
  skipReason: z.string().nullable(),
});
export type TodayDigest = z.infer<typeof TodayDigest>;

/** An auto-applied, lower-confidence action from the last 7 days, pinned above the feed. */
export const CheckThisItem = z.object({
  batch: ActivityBatch,
  /** "Merged on name + 2 shared groups (p 0.91)". */
  reason: z.string(),
});
export type CheckThisItem = z.infer<typeof CheckThisItem>;

export const ActivityCounts = z.object({
  merges: z.number().int(),
  links: z.number().int(),
  facts: z.number().int(),
  edges: z.number().int(),
  circles: z.number().int(),
  other: z.number().int(),
});
export type ActivityCounts = z.infer<typeof ActivityCounts>;

export const ActivitySummary = z.object({
  lastRun: z
    .object({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      startedAt: Ms,
      finishedAt: Ms.nullable(),
      changeCount: z.number().int(),
    })
    .nullable(),
  /** Agent changes over the last 24 h, by family. */
  last24h: ActivityCounts,
  /** "Last night: 2 merges · 4 IG links · 11 facts" (null when nothing happened). */
  line: z.string().nullable(),
});
export type ActivitySummary = z.infer<typeof ActivitySummary>;

export const TodayResponse = z.object({
  date: LocalDate,
  generatedAt: Ms,
  digest: TodayDigest.nullable(),
  items: z.array(DigestItem),
  /** Nothing worth sending today ("Nothing needs you today"). */
  allClear: z.boolean(),
  openLoops: z.object({ counts: OpenLoopCounts, preview: z.array(OpenLoop) }),
  checkThese: z.array(CheckThisItem),
  alerts: z.array(Alert),
  activity: ActivitySummary,
});
export type TodayResponse = z.infer<typeof TodayResponse>;

export const TodayQuery = z.object({ date: LocalDate.optional() });
export type TodayQuery = z.infer<typeof TodayQuery>;
