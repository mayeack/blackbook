/**
 * Alerts (source health, pipeline failures, budget caps, contract breaks). Messages never contain personal data.
 *
 *   GET  /api/v1/alerts?status=open|all     → AlertList
 *   POST /api/v1/alerts/:id/dismiss         {} → OkResult   (resolves it; it reopens if the condition recurs)
 */
import { z } from 'zod';
import { Ms } from './common';

export const AlertSeverity = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const Alert = z.object({
  id: z.string(),
  /** 'whatsapp', 'beeper', 'partiful', 'collector', 'pipeline', 'llm', 'delivery', … */
  source: z.string(),
  severity: AlertSeverity,
  message: z.string(),
  openedAt: Ms,
  lastNotifiedAt: Ms.nullable(),
  resolvedAt: Ms.nullable(),
  /** Web path of the screen that fixes it (usually /sources); null when no screen can (the web shows only Dismiss). */
  href: z.string().nullable(),
});
export type Alert = z.infer<typeof Alert>;

export const AlertListQuery = z.object({ status: z.enum(['open', 'all']).default('open') });
export type AlertListQuery = z.infer<typeof AlertListQuery>;

export const AlertList = z.object({ alerts: z.array(Alert) });
export type AlertList = z.infer<typeof AlertList>;
