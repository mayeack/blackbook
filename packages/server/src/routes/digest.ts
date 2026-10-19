/**
 * Digest API (owner only, behind Cloudflare Access; mutating routes need JSON + X-YB: 1):
 *
 *   GET  /digest/preview?date=YYYY-MM-DD  → DigestPreview   exact text that would be sent; never sends, never spends
 *   POST /digest/send-test                DigestSendTest (+ force) → DigestSendTestResult
 *        403 SEND_DISABLED unless settings delivery.allow_test_send or digest.enabled is on, or the owner passes
 *        {force: true}. The recipient is always the owner's own handle (sendToSelf has no `to`), the text starts
 *        with the 🅨 marker, and at most 15 test texts go out per hour (a test brief is one text per suggestion).
 *   GET  /digest/history?limit=            → DigestHistory
 */
import { Router } from 'express';
import { z } from 'zod';
import { DigestPreviewQuery, DigestSendTest, uuidv7, type DigestHistory, type DigestSendTestResult } from '@yb/shared';
import { digestHistory, digestPreview } from '../delivery/preview';
import { BOT_MARKER } from '../delivery/text';
import { HttpError } from '../http/errors';
import { resolveServices } from '../services';
import { settingsSnapshot } from '../settings/registry';
import type { RouteDeps } from './index';

/** The shared DTO plus the owner's explicit override (the UI asks first). */
const SendTestBody = DigestSendTest.extend({ force: z.boolean().optional() });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(90).default(14) });

/** Test texts per hour (a test brief is one text per suggestion, so this is texts, not tests). */
export const MAX_TEST_SENDS_PER_HOUR = 15;
export const HELLO_TEXT = `${BOT_MARKER} Hi, it's yeackbot! This is how your brief will show up.`;

export function digestRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const r = Router();

  r.get('/digest/preview', async (req, res) => {
    const q = DigestPreviewQuery.parse(req.query);
    res.json(await digestPreview(db, resolveServices(deps), { date: q.date, now: Date.now() }));
  });

  r.post('/digest/send-test', async (req, res) => {
    const body = SendTestBody.parse(req.body);
    const s = settingsSnapshot(db);
    if (!s['delivery.allow_test_send'] && !s['digest.enabled'] && body.force !== true) {
      throw new HttpError(403, 'SEND_DISABLED', 'Test sends are off. Turn on "Allow test sends" (or the daily brief) in Settings first.');
    }
    const services = resolveServices(deps);
    if (!services.outbound.configured) {
      throw new HttpError(409, 'DELIVERY_NOT_CONFIGURED', 'Sending isn’t set up yet: install the collector and run npm run setup:self.');
    }
    const now = Date.now();
    const recent = db.prepare(`SELECT count(*) FROM outbound_messages WHERE purpose = 'test' AND created_at > ?`).pluck().get(now - 3_600_000) as number;
    const texts = body.mode === 'digest' ? (await digestPreview(db, services, { now })).texts : [HELLO_TEXT];
    if (recent + texts.length > MAX_TEST_SENDS_PER_HOUR) throw new HttpError(429, 'TOO_MANY_TEST_SENDS', 'That’s enough test sends for this hour.');
    // The owner asked for it just now: like a reply to their own command, it isn't held for quiet hours.
    // One text per suggestion, in order; stop at the first one that doesn't go.
    let first: Awaited<ReturnType<typeof services.outbound.sendToSelf>> | null = null;
    let out: Awaited<ReturnType<typeof services.outbound.sendToSelf>> | null = null;
    for (const text of texts) {
      out = await services.outbound.sendToSelf(text, 'test', uuidv7(Date.now()), { bypassQuietHours: true });
      first ??= out;
      if (!['delivered', 'sent', 'unverified', 'duplicate'].includes(out.status)) break;
    }
    if (out!.status === 'disabled') {
      throw new HttpError(409, 'DELIVERY_NOT_CONFIGURED', 'Sending isn’t set up yet: install the collector and run npm run setup:self.', { reason: out!.reason ?? null });
    }
    const status: DigestSendTestResult['status'] = out!.status === 'duplicate' ? 'sent' : out!.status;
    deps.log.info('digest.send_test', { counts: { [status]: 1, texts: texts.length } });
    res.json({ outboundId: first!.outboundId ?? '', status } satisfies DigestSendTestResult);
  });

  r.get('/digest/history', (req, res) => {
    const q = HistoryQuery.parse(req.query);
    res.json({ digests: digestHistory(db, q.limit) } satisfies DigestHistory);
  });

  return r;
}
