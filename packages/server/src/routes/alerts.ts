/**
 * Alerts (source health, pipeline failures, budget caps, held identity links; DTOs in @yb/shared api/alerts.ts):
 *
 *   GET  /alerts?status=open|all     → AlertList   open first, newest first (all: the last 200)
 *   POST /alerts/:id/dismiss         {} → OkResult  resolves it (its writer reopens a new one if the condition recurs)
 *
 * Alert messages are written without personal data; they are masked here anyway (phones, emails).
 */
import { Router } from 'express';
import { z } from 'zod';
import { AlertListQuery, type Alert, type AlertList, type AlertSeverity, type OkResult } from '@yb/shared';
import type { DB } from '../db/connection';
import { notFound } from '../http/errors';
import type { RouteDeps } from './index';
import { maskText } from './people';

const IdParam = z.object({ id: z.string().min(1).max(64) });

interface AlertRow {
  id: string;
  source: string;
  severity: AlertSeverity;
  message: string;
  opened_at: number;
  last_notified_at: number | null;
  resolved_at: number | null;
}

/** Web path of the screen that fixes it. */
export function alertHref(source: string): string {
  if (source === 'llm') return '/settings/privacy';
  if (source === 'delivery' || source === 'digest') return '/settings/digest';
  if (source === 'push') return '/settings/push';
  if (source.startsWith('identity')) return '/people';
  return '/sources';
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function listAlerts(db: DB, status: 'open' | 'all'): Alert[] {
  const rows = db
    .prepare(
      status === 'open'
        ? 'SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC LIMIT 200'
        : 'SELECT * FROM alerts ORDER BY resolved_at IS NOT NULL, opened_at DESC LIMIT 200',
    )
    .all() as AlertRow[];
  return rows
    .map((a) => ({
      id: a.id,
      source: a.source,
      severity: a.severity,
      message: maskText(a.message),
      openedAt: a.opened_at,
      lastNotifiedAt: a.last_notified_at,
      resolvedAt: a.resolved_at,
      href: alertHref(a.source),
    }))
    .sort((x, y) => Number(x.resolvedAt !== null) - Number(y.resolvedAt !== null) || SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.openedAt - x.openedAt);
}

/** Resolves an alert. 404 when it doesn't exist; dismissing a resolved one is a no-op. */
export function dismissAlert(db: DB, id: string, now = Date.now()): void {
  const row = db.prepare('SELECT resolved_at FROM alerts WHERE id = ?').get(id) as { resolved_at: number | null } | undefined;
  if (!row) throw notFound('Alert');
  if (row.resolved_at === null) db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now, id);
}

export function alertsRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/alerts', (req, res) => {
    const q = AlertListQuery.parse(req.query);
    res.json({ alerts: listAlerts(db, q.status) } satisfies AlertList);
  });
  r.post('/alerts/:id/dismiss', (req, res) => {
    const { id } = IdParam.parse(req.params);
    dismissAlert(db, id);
    res.json({ ok: true } satisfies OkResult);
  });
  return r;
}
