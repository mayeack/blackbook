/**
 * Digest preview and test send.
 *
 *   GET  /api/v1/digest/preview?date=     → DigestPreview   (exact text; never sends)
 *   POST /api/v1/digest/send-test         DigestSendTest → DigestSendTestResult
 *        403 SEND_DISABLED unless settings delivery.allow_test_send is true. Recipient is always the configured
 *        self handle (the collector refuses anything else); the text starts with the 🅨 marker.
 *   GET  /api/v1/digest/history?limit=    → DigestHistory
 */
import { z } from 'zod';
import { LocalDate, Ms } from './common';
import { DigestItem } from './suggestions';
import { DigestStatus } from './today';

export const DigestPreviewQuery = z.object({ date: LocalDate.optional() });
export type DigestPreviewQuery = z.infer<typeof DigestPreviewQuery>;

export const DigestNotSentReason = z.enum([
  'disabled',
  'paused',
  'empty',
  'quiet_hours',
  'catch_up_passed',
  'already_sent',
  'no_self_handle',
  'collector_unavailable',
]);
export type DigestNotSentReason = z.infer<typeof DigestNotSentReason>;

export const DigestPreview = z.object({
  date: LocalDate,
  /** The iMessage text exactly as it would be sent (first character U+1F168). */
  text: z.string(),
  /** Push notification body ("Your brief is ready · 4 things"). */
  pushBody: z.string(),
  items: z.array(DigestItem),
  composer: z.enum(['llm', 'template']),
  wouldSend: z.boolean(),
  reasonNotSent: DigestNotSentReason.nullable(),
  charCount: z.number().int(),
});
export type DigestPreview = z.infer<typeof DigestPreview>;

export const DigestSendTest = z.object({
  /** Must be true: the UI asks first. */
  confirm: z.literal(true),
  /** 'hello' sends one short line; 'digest' sends today's preview text. */
  mode: z.enum(['hello', 'digest']).default('hello'),
});
export type DigestSendTest = z.infer<typeof DigestSendTest>;

export const DigestSendTestResult = z.object({
  outboundId: z.string(),
  status: z.enum(['delivered', 'sent', 'unverified', 'ghost', 'failed', 'blocked']),
});
export type DigestSendTestResult = z.infer<typeof DigestSendTestResult>;

export const DigestSummary = z.object({
  id: z.string(),
  localDate: LocalDate,
  status: DigestStatus,
  itemCount: z.number().int(),
  sentAt: Ms.nullable(),
  pushSentAt: Ms.nullable(),
  hadWildcard: z.boolean(),
});
export type DigestSummary = z.infer<typeof DigestSummary>;

export const DigestHistory = z.object({ digests: z.array(DigestSummary) });
export type DigestHistory = z.infer<typeof DigestHistory>;
