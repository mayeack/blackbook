/**
 * The Partiful passes (PLAN "Ingestion → Partiful"; read-only, ≤300 calls and ≤1 call/s per run):
 *   syncPartiful (daily 02:00)       event lists → events; getEventInfo probes for ids known only from texts;
 *                                    trickled getGuests → identities + event_attendees; getUsers for unseen
 *                                    ids → names + the Partiful↔Instagram link; Partiful edge evidence and
 *                                    'event' interactions rebuilt; source_health (ok / stale = texts name events
 *                                    the API never returned / contract_broken / auth_required).
 *   syncPartifulContacts (weekly)    getContacts + getMutuals → identities + sharedEventCount (tie seeding).
 *   refreshHostedGuests (30 min)     getGuests for events I host in the next 15 days, so "Who to invite" is checked
 *                                    against who is invited right now (no hosted events → no calls).
 * Every journaled write (people, identities, merges, event_attendees) shares one run per pass (undo per run).
 * A spent budget, a 429 or a scheduler stop ends the pass early as 'partial': the next run continues where this
 * one stopped. Logs and stats carry counts only.
 */
import type { DB } from '../../db/connection';
import { attachExternalIdentity } from '../../identity/external';
import type { ResolveContext } from '../../identity/resolver';
import type { Logger } from '../../ops/logger';
import { sourceRun } from '../common/context';
import { cursorMeta, readCursor, recordSourceHealth, writeCursor, type SourceHealthStatus } from '../common/cursors';
import { nonZeroStats } from '../common/episodes';
import type { PartifulClient } from './client';
import { probeCandidates, recordProbe, textEventGaps, unexplainedGaps } from './contract';
import { rebuildPartifulEdges } from './edges';
import {
  PartifulAuthRequiredError,
  PartifulBudgetError,
  PartifulCallError,
  PartifulContractError,
  PartifulHttpError,
  PartifulRateLimitedError,
  SIGN_IN_MESSAGE,
} from './errors';
import { isHost, mergeFound, storedEvents, upsertEvents, type EventOrigin, type FoundEvent } from './events';
import { rebuildPartifulInteractions } from './interactions';
import { applyGuestList, DEFAULT_GUEST_LIMITS, isCanceled, markGuestState, planGuestFetches, type GuestLimits } from './guests';
import { parseContacts, parseEventInfo, parseEventList, parseGuestPage, parseUsers, type ParsedGuest } from './schemas';
import type { RunScope } from './scope';
import { applyContacts, applyProfiles, countPendingProfiles, pendingProfiles } from './users';

export const SOURCE = 'partiful';
/** source_cursors scope where the weekly contacts pass leaves its outcome for the daily health verdict. */
export const CONTACTS_SCOPE = 'contacts';

export const LIST_FUNCTIONS = ['getMyUpcomingEventsForHomePage', 'getMyPastEventsForHomePage', 'getMyRsvps', 'getPublishedEvents'] as const;
export type ListFunction = (typeof LIST_FUNCTIONS)[number];

const LIST_STAT: Record<ListFunction, 'upcoming' | 'past' | 'rsvps' | 'published'> = {
  getMyUpcomingEventsForHomePage: 'upcoming',
  getMyPastEventsForHomePage: 'past',
  getMyRsvps: 'rsvps',
  getPublishedEvents: 'published',
};

/**
 * getUsers params as Partiful's web app sends them: with includePartyStats false the live API answered [] for
 * every id (2026-10-16), so party stats are requested even though only names and socials are used.
 */
export const USERS_PARAMS = (ids: readonly string[]) => ({ ids: [...ids], excludePartyStats: false, includePartyStats: true });

export interface SyncLimits extends GuestLimits {
  guestPagesPerEvent: number;
  userBatchSize: number;
  userCallsPerRun: number;
  probesPerRun: number;
  contactPagesPerList: number;
}

export const DEFAULT_LIMITS: SyncLimits = {
  ...DEFAULT_GUEST_LIMITS,
  guestPagesPerEvent: 10,
  userBatchSize: 50,
  userCallsPerRun: 40,
  probesPerRun: 5,
  contactPagesPerList: 20,
};

export interface SyncOptions {
  now?: number;
  jobRunId?: number | null;
  signal?: AbortSignal;
  log?: Logger;
  limits?: Partial<SyncLimits>;
  /** Event lists to read (default all four). */
  lists?: readonly ListFunction[];
}

export interface SyncResult {
  stats: Record<string, number>;
  partial: boolean;
  health: SourceHealthStatus;
}

type StopReason = 'budget' | 'rate_limited' | 'aborted' | 'server_errors';

/** Consecutive 5xx answers after which a pass stops asking (Partiful is having trouble; the next run retries). */
const MAX_SERVER_ERRORS = 3;
const isServerError = (e: unknown) => e instanceof PartifulHttpError && e.status !== null && e.status >= 500;

function stopReason(e: unknown, signal?: AbortSignal): StopReason | null {
  if (e instanceof PartifulBudgetError) return 'budget';
  if (e instanceof PartifulRateLimitedError) return 'rate_limited';
  if (signal?.aborted) return 'aborted';
  return null;
}

const emptyStats = () => ({
  calls: 0,
  lists_ok: 0,
  lists_failed: 0,
  upcoming: 0,
  past: 0,
  rsvps: 0,
  published: 0,
  items_invalid: 0,
  events_seen: 0,
  events_new: 0,
  events_updated: 0,
  hosted: 0,
  probes: 0,
  probes_found: 0,
  guest_lists: 0,
  guest_lists_hidden: 0,
  guest_lists_failed: 0,
  guest_lists_pending: 0,
  guests: 0,
  without_user: 0,
  unknown_statuses: 0,
  guests_skipped_large: 0,
  embedded_profiles: 0,
  attendees_new: 0,
  attendees_updated: 0,
  attendees_kept: 0,
  users: 0,
  users_pending: 0,
  ig_handles: 0,
  ig_linked: 0,
  ig_attached: 0,
  ig_incompatible: 0,
  edges: 0,
  interactions_upserted: 0,
  interactions_deleted: 0,
  text_events_missing: 0,
});
type Stats = ReturnType<typeof emptyStats>;

const add = (into: Stats, from: object) => {
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number' && k in into) into[k as keyof Stats] += v;
};

/** My Partiful user id on the 'me' person (once self handles exist). Returns the me person id. */
function bindMe(ctx: ResolveContext, uid: string): string | null {
  const me = ctx.db
    .prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`)
    .pluck()
    .get() as string | undefined;
  if (!me) return null;
  attachExternalIdentity({ ...ctx, actor: 'system' }, { kind: 'partiful_user', key: uid, personId: me, at: ctx.now });
  return me;
}

function verdict(failed: readonly string[], missing: number, stop: StopReason | null = null): { status: SourceHealthStatus; error: string | null } {
  if (failed.length) return { status: 'contract_broken', error: `Partiful API changed: ${[...new Set(failed)].join(', ')} could not be read` };
  if (stop === 'server_errors') return { status: 'error', error: 'Partiful kept answering with server errors; the next run retries' };
  if (missing) {
    return { status: 'stale', error: `${missing} event${missing === 1 ? '' : 's'} from Partiful texts not returned by the API within 24 h` };
  }
  return { status: 'ok', error: null };
}

export async function syncPartiful(db: DB, client: PartifulClient, o: SyncOptions = {}): Promise<SyncResult> {
  const now = o.now ?? Date.now();
  const limits: SyncLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const stats = emptyStats();
  const failures = new Set<string>();
  let stop: StopReason | null = null;
  const aborted = () => (o.signal?.aborted ? (stop ??= 'aborted') : stop);
  let serverErrors = 0;
  /** A 5xx for one item: recorded by the caller; true when the pass should stop. */
  const serverTrouble = () => (++serverErrors >= MAX_SERVER_ERRORS ? !!(stop = 'server_errors') : false);
  const run = sourceRun(db, SOURCE, { now, jobRunId: o.jobRunId ?? null });
  try {
    const uid = await client.userId();
    const scope: RunScope = { db, ctx: run.ctx, now, uid, mePersonId: bindMe(run.ctx, uid) };

    // 1. Event lists.
    const found = new Map<string, FoundEvent>();
    for (const fn of o.lists ?? LIST_FUNCTIONS) {
      if (aborted()) break;
      try {
        const r = await client.call(fn, fn === 'getPublishedEvents' ? { userId: uid } : {});
        const { events, invalid } = parseEventList(fn, r.data);
        stats.items_invalid += invalid;
        for (const ev of events) mergeFound(found, ev, fn as EventOrigin);
        stats[LIST_STAT[fn]] = events.length;
        stats.lists_ok++;
      } catch (e) {
        if ((stop = stopReason(e, o.signal))) break;
        if (e instanceof PartifulContractError || e instanceof PartifulCallError) {
          failures.add(fn);
          stats.lists_failed++;
          continue;
        }
        throw e;
      }
    }
    if (stats.lists_ok === 0 && !stop) throw new PartifulContractError([...failures][0] ?? 'lists', 'no event list could be read');
    const up = upsertEvents(db, found.values(), uid, now);
    stats.events_seen = found.size;
    stats.events_new = up.created;
    stats.events_updated = up.updated;
    stats.hosted = [...found.values()].filter((f) => isHost(f.ev, uid, f.origins)).length;

    // 2. Contract probes: ids Partiful texted about that no list returned.
    let gaps = textEventGaps(db, now);
    for (const g of stop ? [] : probeCandidates(gaps, now, limits.probesPerRun)) {
      if (aborted()) break;
      try {
        stats.probes++;
        const r = await client.call('getEventInfo', { eventId: g.eventId });
        const ev = parseEventInfo('getEventInfo', r.data);
        if (ev?.id === g.eventId) {
          upsertEvents(db, [{ ev, origins: new Set<EventOrigin>(['getEventInfo']) }], uid, now);
          recordProbe(db, g.eventId, now, 'found');
          stats.probes_found++;
        } else recordProbe(db, g.eventId, now, 'error');
      } catch (e) {
        if ((stop = stopReason(e, o.signal))) break;
        if (e instanceof PartifulCallError) {
          recordProbe(db, g.eventId, now, e.code === 'NOT_FOUND' ? 'not_found' : e.code === 'PERMISSION_DENIED' ? 'forbidden' : 'error');
        } else if (isServerError(e)) {
          recordProbe(db, g.eventId, now, 'error');
          if (serverTrouble()) break;
        } else if (e instanceof PartifulContractError) {
          recordProbe(db, g.eventId, now, 'error');
          failures.add('getEventInfo');
          break;
        } else throw e;
      }
    }
    gaps = textEventGaps(db, now);

    // 3. Guest lists (trickled).
    const plan = planGuestFetches(db, now, limits);
    for (const q of plan.quiet) markGuestState(db, q.ev, now, q.status);
    stats.guest_lists_hidden = plan.quiet.filter((q) => q.status === 'hidden').length;
    let pending = plan.backfillPending;
    // INVALID_ARGUMENT-style answers for several lists in a row mean the call itself changed.
    let oddCalls = 0;
    for (let i = 0; i < plan.due.length; i++) {
      const e = plan.due[i]!;
      if (aborted()) {
        pending += plan.due.length - i;
        break;
      }
      const guests: ParsedGuest[] = [];
      try {
        await readGuests(client, e.ev.id, limits.guestPagesPerEvent, stats, guests);
      } catch (err) {
        if ((stop = stopReason(err, o.signal))) {
          if (guests.length) {
            add(stats, applyGuestList(scope, e, guests, 'partial'));
            stats.guest_lists++;
          }
          pending += plan.due.length - i - (guests.length ? 1 : 0);
          break;
        }
        if (err instanceof PartifulCallError || isServerError(err)) {
          const hidden = err instanceof PartifulCallError && err.code === 'PERMISSION_DENIED';
          markGuestState(db, e, now, hidden ? 'hidden' : 'error', { fetched: true });
          stats.guest_lists_failed++;
          const odd = err instanceof PartifulCallError && err.code !== 'PERMISSION_DENIED' && err.code !== 'NOT_FOUND';
          oddCalls = odd ? oddCalls + 1 : 0;
          if (oddCalls >= MAX_SERVER_ERRORS) failures.add('getGuests');
          if ((isServerError(err) && serverTrouble()) || oddCalls >= MAX_SERVER_ERRORS) {
            pending += plan.due.length - i - 1;
            break;
          }
          continue;
        }
        if (err instanceof PartifulContractError) {
          failures.add('getGuests');
          stats.guest_lists_failed++;
          pending += plan.due.length - i;
          break;
        }
        throw err;
      }
      add(stats, applyGuestList(scope, e, guests));
      stats.guest_lists++;
      serverErrors = 0;
      oddCalls = 0;
    }
    stats.guest_lists_pending = pending;

    // 4. Profiles for users not read yet (people in my network first). The API may answer fewer than asked
    // (live: one per call), so the batch shrinks to what it returns; every call makes progress (applyProfiles).
    if (!stop) {
      let batch = limits.userBatchSize;
      for (let calls = 0; calls < limits.userCallsPerRun && !aborted(); calls++) {
        const chunk = pendingProfiles(db, uid, now, batch);
        if (!chunk.length) break;
        try {
          const r = await client.call('getUsers', USERS_PARAMS(chunk));
          const { users, invalid } = parseUsers('getUsers', r.data);
          stats.items_invalid += invalid;
          add(stats, applyProfiles(scope, chunk, users));
          if (users.length > 0 && users.length < chunk.length) batch = users.length;
        } catch (e) {
          if ((stop = stopReason(e, o.signal))) break;
          if (e instanceof PartifulContractError || e instanceof PartifulCallError) {
            failures.add('getUsers');
            break;
          }
          if (isServerError(e)) {
            if (serverTrouble()) break;
            continue;
          }
          throw e;
        }
      }
    }
    stats.users_pending = countPendingProfiles(db, uid, now);

    // 5. Derived edges and interactions, then the health verdict.
    stats.edges = rebuildPartifulEdges(db, now).rows;
    const ix = rebuildPartifulInteractions(db, now);
    stats.interactions_upserted = ix.upserted;
    stats.interactions_deleted = ix.deleted;
    const missing = unexplainedGaps(gaps).length;
    stats.text_events_missing = missing;
    stats.calls = client.callCount;
    const weekly = cursorMeta<{ failed: string[] }>(readCursor(db, SOURCE, CONTACTS_SCOPE)).failed ?? [];
    const v = verdict([...failures, ...weekly], missing, stop);
    const events = db.prepare(`SELECT count(*) FROM events WHERE source = 'partiful'`).pluck().get() as number;
    recordSourceHealth(db, SOURCE, now, v.status, {
      error: v.error,
      newestDataAt: now,
      details: {
        events,
        upcoming: stats.upcoming,
        past: stats.past,
        hosted: stats.hosted,
        guest_lists_pending: stats.guest_lists_pending,
        users_pending: stats.users_pending,
        text_events_missing: missing,
        calls: stats.calls,
        ...(failures.size || weekly.length ? { failed: [...new Set([...failures, ...weekly])] } : {}),
        ...(stop ? { stopped: stop } : {}),
      },
    });
    const partial = stop !== null || failures.size > 0;
    run.finish(partial ? 'partial' : 'ok', nonZeroStats(stats));
    o.log?.info('partiful.sync', { counts: nonZeroStats(stats) });
    return { stats: nonZeroStats(stats), partial, health: v.status };
  } catch (e) {
    run.finish('error');
    throw e;
  }
}

/** Every page of one event's guest list, invited guests included, into `into` (kept if a later page throws). */
async function readGuests(client: PartifulClient, eventId: string, maxPages: number, stats: Stats, into: ParsedGuest[]): Promise<void> {
  for await (const page of client.pages('getGuests', { eventId, includeInvitedGuests: true }, { maxResults: 500, maxPages })) {
    const p = parseGuestPage('getGuests', page.data);
    into.push(...p.guests);
    stats.items_invalid += p.invalid;
  }
}

const DAY = 86_400_000;
/** Hosted events this many days ahead get their guest lists refreshed (the 2–14 day invite window, plus slack). */
export const HOSTED_REFRESH_DAYS = 15;

/**
 * Re-reads the guest lists of Partiful events I host that start in the next HOSTED_REFRESH_DAYS days (job
 * 'partiful-hosted-guests', every 30 min), so "Who to invite" never names someone already invited: the generator and
 * the brief only trust a list read 'ok' within the last hour (intel/invites.ts). Only complete lists are applied; one
 * that can't be read is marked 'error', which keeps its invite suggestion out. No hosted events → no calls at all.
 */
export async function refreshHostedGuests(db: DB, client: PartifulClient, o: SyncOptions = {}): Promise<SyncResult> {
  const now = o.now ?? Date.now();
  const limits: SyncLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const due = storedEvents(db).filter((e) => e.myRole === 'host' && e.startsAt !== null && e.startsAt >= now && e.startsAt < now + HOSTED_REFRESH_DAYS * DAY && !isCanceled(e));
  if (!due.length) return { stats: {}, partial: false, health: 'ok' };
  const stats = emptyStats();
  let stop: StopReason | null = null;
  const run = sourceRun(db, SOURCE, { now, jobRunId: o.jobRunId ?? null });
  try {
    const uid = await client.userId();
    const scope: RunScope = { db, ctx: run.ctx, now, uid, mePersonId: bindMe(run.ctx, uid) };
    for (const e of due) {
      if (o.signal?.aborted) {
        stop = 'aborted';
        break;
      }
      const guests: ParsedGuest[] = [];
      try {
        await readGuests(client, e.ev.id, limits.guestPagesPerEvent, stats, guests);
      } catch (err) {
        const hidden = err instanceof PartifulCallError && err.code === 'PERMISSION_DENIED';
        markGuestState(db, e, now, hidden ? 'hidden' : 'error', { fetched: true });
        stats.guest_lists_failed++;
        if ((stop = stopReason(err, o.signal))) break;
        if (err instanceof PartifulCallError || err instanceof PartifulContractError || isServerError(err)) continue;
        throw err;
      }
      add(stats, applyGuestList(scope, e, guests));
      stats.guest_lists++;
    }
    stats.calls = client.callCount;
    const partial = stop !== null || stats.guest_lists_failed > 0;
    run.finish(partial ? 'partial' : 'ok', nonZeroStats(stats));
    o.log?.info('partiful.hosted_guests', { counts: nonZeroStats(stats) });
    return { stats: nonZeroStats(stats), partial, health: 'ok' };
  } catch (e) {
    run.finish('error');
    throw e;
  }
}

export async function syncPartifulContacts(db: DB, client: PartifulClient, o: SyncOptions = {}): Promise<SyncResult> {
  const now = o.now ?? Date.now();
  const limits: SyncLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const stats = { contacts: 0, mutuals: 0, with_counts: 0, skipped: 0, items_invalid: 0, calls: 0 };
  const failures: string[] = [];
  let stop: StopReason | null = null;
  const run = sourceRun(db, SOURCE, { now, jobRunId: o.jobRunId ?? null, kind: 'weekly' });
  try {
    const uid = await client.userId();
    const scope: RunScope = { db, ctx: run.ctx, now, uid, mePersonId: bindMe(run.ctx, uid) };
    for (const [fn, list] of [
      ['getContacts', 'contacts'],
      ['getMutuals', 'mutuals'],
    ] as const) {
      if (stop || o.signal?.aborted) break;
      try {
        for await (const page of client.pages(fn, {}, { maxResults: 500, maxPages: limits.contactPagesPerList })) {
          const p = parseContacts(fn, page.data);
          stats.items_invalid += p.invalid;
          const r = applyContacts(scope, list, p.contacts);
          stats[list] += r.contacts;
          stats.with_counts += r.with_counts;
          stats.skipped += r.skipped;
        }
      } catch (e) {
        if ((stop = stopReason(e, o.signal))) break;
        if (e instanceof PartifulContractError || e instanceof PartifulCallError) {
          failures.push(fn);
          continue;
        }
        throw e;
      }
    }
    stats.calls = client.callCount;
    writeCursor(db, SOURCE, CONTACTS_SCOPE, String(now), now, { meta: { failed: failures, contacts: stats.contacts, mutuals: stats.mutuals } });
    // The daily pass owns the health verdict; a broken contacts contract is reported right away, though.
    if (failures.length) recordSourceHealth(db, SOURCE, now, 'contract_broken', { error: verdict(failures, 0).error, newestDataAt: null });
    const partial = stop !== null || failures.length > 0;
    run.finish(partial ? 'partial' : 'ok', nonZeroStats(stats));
    o.log?.info('partiful.contacts', { counts: nonZeroStats(stats) });
    return { stats: nonZeroStats(stats), partial, health: failures.length ? 'contract_broken' : 'ok' };
  } catch (e) {
    run.finish('error');
    throw e;
  }
}

/** source_health for a pass that threw (the job rethrows so the scheduler backs off and retries). */
export function recordPartifulFailure(db: DB, now: number, e: unknown): void {
  if (e instanceof PartifulAuthRequiredError) {
    recordSourceHealth(db, SOURCE, now, 'auth_required', { error: SIGN_IN_MESSAGE, newestDataAt: null, details: { reason: e.reason } });
  } else if (e instanceof PartifulContractError) {
    recordSourceHealth(db, SOURCE, now, 'contract_broken', { error: e.message, newestDataAt: null });
  } else if (e instanceof PartifulHttpError || e instanceof PartifulRateLimitedError) {
    recordSourceHealth(db, SOURCE, now, 'error', { error: e.message, newestDataAt: null });
  } else {
    // Unknown errors: the class only (a message could carry anything).
    const name = (e as { name?: unknown })?.name;
    recordSourceHealth(db, SOURCE, now, 'error', { error: typeof name === 'string' && /^[A-Za-z]{1,60}$/.test(name) ? name : 'Error', newestDataAt: null });
  }
}
