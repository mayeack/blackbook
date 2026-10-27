/**
 * Weekly event picks on the web (design docs/design/event-picks.md §7; DTOs in @yb/shared api/eventPicks.ts):
 *
 *   GET  /event-picks                   → EventPicksResponse   the latest sent (or ready) week and its picks
 *   POST /event-picks/:id/feedback      ← EventPickFeedback    the owner's answer ("going", "not for me", undo)
 *   GET  /event-picks/email             → EventPicksEmailStatus  "Email me" (Google product gmail_send): connected?,
 *                                         the address it sends to (his own), the last email, its problem
 *   POST /event-picks/email/test        → EventPicksEmailTest  a short test email to that address (delivery/email.ts)
 *   POST /event-picks/email/disconnect  → EventPicksEmailDisconnect  drops the gmail_send token and address; revokes
 *                                         the shared Google grant only when nothing else is connected
 *                                         (routes/googleProducts.ts)
 *   GET  /go/:id   (outside /api, still behind Cloudflare Access; http/app.ts)  the link in the texts: counts the tap,
 *        then 302 to the pick's checked ticket page (else the page it came from); an unknown id goes to /picks.
 *
 * The redirect target is only ever a URL the run stored after checking it against the web_search results
 * (intel/eventPicks/links.ts), re-normalized here (https, a named host): never anything from the request.
 */
import type { RequestHandler } from 'express';
import { Router } from 'express';
import { localDate } from '@yb/shared';
import { EventPickFeedback, type EventPickItem, type EventPicksEmailDisconnect, type EventPicksEmailStatus, type EventPicksEmailTest, type EventPicksResponse } from '@yb/shared';
import { connectedAt, isConnected, type FetchLike } from '../adapters/calendar/google';
import { GoogleOAuthFlow } from '../adapters/calendar/oauth';
import type { DB } from '../db/connection';
import { createEmailSender, EMAIL_SOURCE, sendAddress, type EmailSender } from '../delivery/email';
import { badRequest, notFound } from '../http/errors';
import { normalizeUrl } from '../intel/eventPicks/links';
import * as store from '../intel/eventPicks/store';
import { readSetting, settingTimeZone } from '../settings/registry';
import { resolveServices } from '../services';
import { disconnectGoogleProduct, googleNotConfigured, healthProblemText, healthView } from './googleProducts';
import type { RouteDeps } from './index';

const PICK_ID = /^[A-Za-z0-9_-]{8,40}$/;

const list = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function pickItem(p: store.PickRow): EventPickItem {
  return {
    id: p.id,
    ordinal: p.ordinal ?? 0,
    title: p.title,
    performers: list(p.performers),
    venue: p.venue,
    localDate: p.local_date,
    startTime: p.start_time,
    category: p.category,
    genres: list(p.genres),
    linkKind: p.link_kind,
    ticketHost: p.ticket_url ? p.ticket_host : null,
    why: p.why,
    wildcard: p.wildcard === 1,
    source: p.source,
    status: p.status === 'found' ? 'picked' : p.status,
    outcomeSource: (p.outcome_source as EventPickItem['outcomeSource']) ?? null,
    clicks: p.clicks,
  };
}

export function eventPicksResponse(db: DB): EventPicksResponse {
  const run = store.latestSentRun(db);
  const counts = db
    .prepare(`SELECT status, count(*) AS n FROM event_picks WHERE ordinal IS NOT NULL GROUP BY status`)
    .all() as { status: string; n: number }[];
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return {
    week: run
      ? {
          weekStart: run.week_start,
          windowEnd: run.window_end,
          status: run.status === 'sent' ? 'sent' : 'ready',
          city: run.city,
          freeNights: list(run.free_nights),
          sentAt: run.sent_at,
          found: run.found,
          searches: run.searches,
          newsletters: run.newsletters,
          channel: run.status === 'sent' ? (run.channel ?? 'text') : null,
          picks: store.picksOfRun(db, run.id, { pickedOnly: true }).map(pickItem),
        }
      : null,
    history: { going: n('going'), notForMe: n('not_for_me'), passed: n('passed'), open: n('picked') },
    enabled: readSetting(db, 'events.enabled'),
  };
}

/** Where /go/<id> sends the owner: the checked ticket page, else the page the event came from. */
export function goTarget(p: store.PickRow): string | null {
  for (const raw of [p.ticket_url, p.source_url]) {
    const n = raw ? normalizeUrl(raw) : null;
    if (n) return n;
  }
  return null;
}

export function goRedirect(db: DB): RequestHandler {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const id = String(req.params.id ?? '');
    const pick = PICK_ID.test(id) ? store.pickById(db, id) : null;
    const target = pick && pick.ordinal !== null ? goTarget(pick) : null;
    if (!pick || !target) return void res.redirect(302, '/picks');
    store.recordClick(db, pick.id, Date.now());
    res.redirect(302, target);
  };
}

export function emailStatus(db: DB, secretsKey: Buffer | null): EventPicksEmailStatus {
  const connected = isConnected(db, 'gmail_send');
  const health = healthView(db, EMAIL_SOURCE);
  return {
    configured: true,
    secretsAvailable: secretsKey !== null,
    connected,
    address: sendAddress(db, secretsKey),
    connectedAt: connectedAt(db, 'gmail_send'),
    needsReconnect: connected && health?.status === 'auth_required',
    lastSentAt: health?.lastOkAt ?? null,
    problem: connected ? healthProblemText(health) : null,
  };
}

export const TEST_EMAIL = {
  subject: 'yeackbot can email you',
  text: 'This is a test from yeackbot. Your weekly event picks will arrive like this on Sunday evenings.\n\n— yeackbot',
  html: '<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px">This is a test from yeackbot. Your weekly event picks will arrive like this on Sunday evenings.</p><p style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#6e6e73">— yeackbot</p>',
  tag: 'test',
} as const;

export interface EventPicksRouterOptions {
  /** Tests pass a fetch bound to an undici MockAgent (the revoke call) and a fake sender. */
  fetch?: FetchLike;
  email?: EmailSender;
}

export function createEventPicksRouter(deps: RouteDeps, o: EventPicksRouterOptions = {}): Router {
  const { db, log, config } = deps;
  const r = Router();
  const google = config?.google ?? null;
  const secretsKey = config?.secretsKey ?? null;
  const flow = google ? new GoogleOAuthFlow({ config: google, fetch: o.fetch }) : null;
  const email = (): EmailSender => o.email ?? resolveServices(deps).email ?? createEmailSender({ db, secretsKey, google, log });

  r.use('/event-picks/email', (_req, res, next) => {
    if (!flow) return googleNotConfigured(res);
    next();
  });
  r.get('/event-picks/email', (_req, res) => {
    res.json(emailStatus(db, secretsKey) satisfies EventPicksEmailStatus);
  });
  r.post('/event-picks/email/test', async (_req, res) => {
    const out = await email().sendToSelf({ ...TEST_EMAIL }, { now: Date.now() });
    res.json({ sent: out.status === 'sent', reason: out.status === 'sent' ? null : out.reason } satisfies EventPicksEmailTest);
  });
  r.post('/event-picks/email/disconnect', async (_req, res) => {
    const out = await disconnectGoogleProduct(db, 'gmail_send', { flow, secretsKey, log, now: Date.now() });
    if (out.had) log.info('gmail_send.disconnected', { counts: { revoked: out.revoked ? 1 : 0, all: out.all ? 1 : 0 } });
    res.json({ connected: false, revoked: out.revoked } satisfies EventPicksEmailDisconnect);
  });

  r.get('/event-picks', (_req, res) => {
    res.json(eventPicksResponse(db) satisfies EventPicksResponse);
  });
  r.post('/event-picks/:id/feedback', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!PICK_ID.test(id)) throw badRequest('bad pick id');
    const body = EventPickFeedback.safeParse(req.body);
    if (!body.success) throw badRequest('verdict must be going, not_for_me or undo');
    const now = Date.now();
    const status = store.setVerdict(db, id, body.data.verdict, { now, today: localDate(now, settingTimeZone(db)) });
    if (!status) throw notFound('pick');
    res.json(pickItem(store.pickById(db, id)!) satisfies EventPickItem);
  });
  return r;
}

export function eventPicksRoutes(deps: RouteDeps): Router {
  return createEventPicksRouter(deps);
}
