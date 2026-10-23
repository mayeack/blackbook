/**
 * The Gmail ticket source (job `gmail`, every 30 min while connected; design §1 "Sync"): list → triage → fetch →
 * clean → refs → counterparties. No LLM here: candidates wait in gmail_messages as 'pending' with their masked
 * clean_text for the ticket-parse job (parse.ts).
 *
 *   list       messages.list with the vendor / ticket-word / pass query (triage.ts listQuery) and the attachment
 *              query (passQuery: an .ics / .pkpass part AND a ticket subject), newest first. Messages already in
 *              gmail_messages are skipped. Cursor source_cursors('gmail','list'):
 *                - high_water_at = the newest internalDate seen; each run re-lists from high_water_at − 2 days (it
 *                  only advances once a whole steady listing was looked at; until the first one, the steady range
 *                  starts where the backfill started, so the two walks never leave a gap);
 *                - a steady range with more than one run's pages (a grant that lapsed for months, a server that was
 *                  off) is caught up like the backfill: meta.steadyBefore walks from where the listing stopped down
 *                  to the range's start, one page of each query per run, and meta.steadyTop (the newest mail when
 *                  the walk started) becomes the mark once it gets there — never earlier, so nothing in the range is
 *                  skipped;
 *                - meta.backfill_before walks back towards now − gmail.backfill_days (default 1095), one page of
 *                  each query per run, the next page re-including the boundary second (`before:` is in whole
 *                  seconds); meta.backfill_from is where it started (older mail parses on the backfill budget pool
 *                  while the walk runs).
 *   triage     format=metadata (From, Subject, labels), deterministic (triage.ts). Every looked-at message gets a
 *              row: sender domain and vendor (never the address), the verdict; the subject only for vendor mail and
 *              candidates (local only).
 *   fetch      candidates only, format=full, newest first.
 *   clean      clean.ts: the masked excerpt (clean_text), refs, counterparties (ticket_parties, person resolved by the
 *              ledger later). Bodies are never stored.
 * Caps per run: ≤ 300 metadata and ≤ 100 full fetches, sequential. A message that fails to fetch stays for the next
 * run; three failures in a row stop the pass; one Gmail answers in an unexpected shape three runs running is given
 * up ('failed', error_class 'contract'). Auth failures (and 403 insufficientPermissions) propagate to the job,
 * which marks the source auth_required. Logs and stats carry counts only.
 */
import { emailMatchKey } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { ownerNames, type OwnerName } from '../../identity/ownerNames';
import { selfRefs, type SelfRefs } from '../../identity/self';
import { nullLogger, type Logger } from '../../ops/logger';
import { readSetting } from '../../settings/registry';
import { GoogleApiError, GoogleAuthError, GoogleContractError, GoogleEgressRefusedError } from '../calendar/google';
import { cursorMeta, readCursor, writeCursor } from '../common/cursors';
import { headerOf, type GmailApi } from './api';
import { cleanMessage } from './clean';
import { listQuery, passQuery, triage } from './triage';
import { senderAddress, senderDomain, vendorOf } from './vendors';

export const GMAIL_SOURCE = 'gmail';
export const LIST_SCOPE = 'list';
const DAY = 86_400_000;

export const GMAIL_LIMITS = {
  metadataPerRun: 300,
  fullPerRun: 100,
  pageSize: 100,
  /** Pages of the steady listing per query per run. */
  steadyPages: 5,
  /** Pages of the backfill listing per query per run. */
  backfillPages: 1,
  overlapMs: 2 * DAY,
  /** Consecutive per-message failures that stop a pass. */
  maxFailuresInARow: 3,
  /** Full fetches of one message answered in an unexpected shape before it is given up ('failed'). */
  maxContractAttempts: 3,
} as const;

export interface GmailSyncStats {
  listed: number;
  known: number;
  metadata: number;
  candidates: number;
  marketing: number;
  ignored: number;
  fetched: number;
  parties: number;
  fetch_failed: number;
  gone: number;
  budget_cut: number;
  steady_pages: number;
  backfill_pages: number;
  backfill_done: number;
}

const emptyStats = (): GmailSyncStats => ({
  listed: 0,
  known: 0,
  metadata: 0,
  candidates: 0,
  marketing: 0,
  ignored: 0,
  fetched: 0,
  parties: 0,
  fetch_failed: 0,
  gone: 0,
  budget_cut: 0,
  steady_pages: 0,
  backfill_pages: 0,
  backfill_done: 0,
});

interface ListMeta {
  /** The backfill has looked at everything newer than this (ms). */
  backfillBefore: number;
  /** Where the backfill started. */
  backfillFrom: number;
  /** A steady catch-up walk (see the header) has looked at everything in [steadyBefore, steadyTop] (ms). */
  steadyBefore?: number;
  steadyTop?: number;
}

export interface GmailSyncOptions {
  now?: number;
  signal?: AbortSignal;
  log?: Logger;
  /** Tests shrink the caps and page sizes. */
  limits?: Partial<Record<keyof typeof GMAIL_LIMITS, number>>;
}

/** The backfill floor for the current setting. */
const floorOf = (db: DB, now: number) => now - readSetting(db, 'gmail.backfill_days') * DAY;

/**
 * Where the backfill started, while it still runs (mail older than this parses on the backfill pool); null once it
 * reached the floor or before the first pass.
 */
export function backfillFrom(db: DB, now: number): number | null {
  const cur = readCursor(db, GMAIL_SOURCE, LIST_SCOPE);
  if (!cur) return null;
  const m = cursorMeta<ListMeta>(cur);
  if (typeof m.backfillBefore !== 'number' || typeof m.backfillFrom !== 'number') return null;
  return m.backfillBefore > floorOf(db, now) ? m.backfillFrom : null;
}

/** Whether the backfill walk still has older mail to look at. */
export const isBackfilling = (db: DB, now: number): boolean => backfillFrom(db, now) !== null;

interface Listing {
  /** id → thread id, in listing order (newest first). */
  ids: Map<string, string>;
  /** Ids the attachment query returned (they carry an .ics / .pkpass). */
  withPass: Set<string>;
  /** Each query reached its last page. */
  mainComplete: boolean;
  passComplete: boolean;
  mainIds: string[];
  passIds: string[];
}

async function list(
  api: GmailApi,
  range: { from: number; to: number | null },
  extra: readonly string[],
  pages: number,
  pageSize: number,
  stats: GmailSyncStats,
  signal?: AbortSignal,
): Promise<Listing> {
  const out: Listing = { ids: new Map(), withPass: new Set(), mainComplete: false, passComplete: false, mainIds: [], passIds: [] };
  const run = async (q: string, into: string[]): Promise<boolean> => {
    let pageToken: string | null = null;
    for (let n = 0; n < pages; n++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const page = await api.listMessages({ q, maxResults: pageSize, pageToken }, signal);
      for (const m of page.messages) {
        into.push(m.id);
        if (!out.ids.has(m.id)) out.ids.set(m.id, m.threadId);
      }
      stats.listed += page.messages.length;
      if (!page.nextPageToken) return true;
      pageToken = page.nextPageToken;
    }
    return false;
  };
  out.mainComplete = await run(listQuery(range, extra), out.mainIds);
  out.passComplete = await run(passQuery(range), out.passIds);
  for (const id of out.passIds) out.withPass.add(id);
  return out;
}

interface Budget {
  metadata: number;
  full: number;
}

class Processor {
  private readonly known;
  private readonly insert;
  private readonly setClean;
  private readonly upsertParty;
  private readonly markGone;
  private readonly markBroken;
  private readonly extra: readonly string[];
  private readonly owner: OwnerName[];
  private readonly self: SelfRefs;
  private failuresInARow = 0;
  /** Listed ids Gmail no longer has (deleted between the listing and the fetch). */
  readonly gone = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly api: GmailApi,
    private readonly stats: GmailSyncStats,
    private readonly budget: Budget,
    private readonly now: number,
    private readonly maxFailures: number,
    private readonly signal?: AbortSignal,
  ) {
    this.extra = readSetting(db, 'gmail.extra_senders');
    this.owner = ownerNames(db);
    this.self = selfRefs(db);
    this.known = db.prepare('SELECT 1 FROM gmail_messages WHERE gmail_id = ?').pluck();
    this.insert = db.prepare(
      `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, from_domain, vendor, subject, triage, parse_status, refs, created_at, updated_at)
       VALUES (@id, @thread, @at, @domain, @vendor, @subject, @triage, @status, @refs, @now, @now)
       ON CONFLICT (gmail_id) DO NOTHING`,
    );
    this.setClean = db.prepare(`UPDATE gmail_messages SET clean_text = ?, refs = ?, updated_at = ? WHERE gmail_id = ? AND parse_status = 'pending'`);
    this.upsertParty = db.prepare(
      `INSERT INTO ticket_parties (gmail_id, direction, name, email_key, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gmail_id, direction) DO UPDATE SET name = excluded.name, email_key = excluded.email_key, quantity = excluded.quantity,
         updated_at = excluded.updated_at`,
    );
    this.markGone = db.prepare(`UPDATE gmail_messages SET parse_status = 'skipped', error_class = 'gone', updated_at = ? WHERE gmail_id = ?`);
    this.markBroken = db.prepare(
      `UPDATE gmail_messages SET attempts = attempts + 1, error_class = 'contract',
         parse_status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE parse_status END, updated_at = ?
       WHERE gmail_id = ?`,
    );
  }

  private isMine = (emailKey: string) => this.self.isMine('email', emailKey);

  /** A per-message failure: counted; the pass stops after a few in a row (something systemic). */
  private failed(e: unknown): void {
    if (e instanceof GoogleAuthError || e instanceof GoogleEgressRefusedError || this.signal?.aborted) throw e;
    if (e instanceof GoogleApiError && e.status === 403) throw e;
    this.stats.fetch_failed++;
    if (++this.failuresInARow >= this.maxFailures) throw e;
  }

  /** Metadata + triage for every new listed id. Returns false when the metadata budget ran out first. */
  async triageAll(listing: Listing): Promise<boolean> {
    for (const [id, threadId] of listing.ids) {
      if (this.signal?.aborted) throw this.signal.reason ?? new Error('aborted');
      if (this.known.get(id)) {
        this.stats.known++;
        continue;
      }
      if (this.budget.metadata <= 0) {
        this.stats.budget_cut++;
        return false;
      }
      this.budget.metadata--;
      let msg;
      try {
        msg = await this.api.getMessage(id, 'metadata', this.signal);
        this.failuresInARow = 0;
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 404) {
          this.gone.add(id);
          this.stats.gone++;
          continue;
        }
        this.failed(e);
        continue;
      }
      this.stats.metadata++;
      const from = headerOf(msg.payload, 'From');
      const subject = headerOf(msg.payload, 'Subject');
      const domain = senderDomain(from);
      const addr = senderAddress(from);
      const t = triage(
        { from, subject, labelIds: msg.labelIds, fromDomain: domain, hasPass: listing.withPass.has(id), fromOwner: !!addr && this.self.isMine('email', addr) },
        this.extra,
      );
      this.stats[t.verdict === 'candidate' ? 'candidates' : t.verdict]++;
      this.insert.run({
        id,
        thread: msg.threadId || threadId,
        at: msg.internalAt,
        domain,
        vendor: t.vendor?.name ?? null,
        // Subjects are kept (locally) for vendor mail and candidates only.
        subject: t.verdict === 'ignored' ? null : (subject ?? '').slice(0, 500),
        triage: t.verdict,
        status: t.verdict === 'candidate' ? 'pending' : 'skipped',
        refs: JSON.stringify(t.forwarded ? { forwarded: true } : {}),
        now: this.now,
      });
    }
    return true;
  }

  /** format=full + clean for candidates that have no clean_text yet (newest first, within the budget). */
  async fetchPending(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT gmail_id, vendor, refs FROM gmail_messages
         WHERE triage = 'candidate' AND parse_status = 'pending' AND clean_text IS NULL AND parsed IS NULL
         ORDER BY internal_at DESC, gmail_id LIMIT ?`,
      )
      .all(Math.max(0, this.budget.full)) as { gmail_id: string; vendor: string | null; refs: string }[];
    for (const r of rows) {
      if (this.signal?.aborted) throw this.signal.reason ?? new Error('aborted');
      this.budget.full--;
      let msg;
      try {
        msg = await this.api.getMessage(r.gmail_id, 'full', this.signal);
        this.failuresInARow = 0;
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 404) {
          this.markGone.run(this.now, r.gmail_id);
          this.stats.gone++;
          continue;
        }
        if (e instanceof GoogleContractError) {
          // One message Gmail answers in an unexpected shape: retried a few runs, then final (never a loop).
          this.markBroken.run(GMAIL_LIMITS.maxContractAttempts, this.now, r.gmail_id);
          this.stats.fetch_failed++;
          continue;
        }
        this.failed(e);
        continue;
      }
      const subject = headerOf(msg.payload, 'Subject');
      const forwarded = (JSON.parse(r.refs) as { forwarded?: boolean }).forwarded === true;
      const vendor = vendorOf(senderDomain(headerOf(msg.payload, 'From')), this.extra);
      const cleaned = cleanMessage({ subject, payload: msg.payload, vendor, forwarded, ownerNames: this.owner, isOwnerEmail: this.isMine });
      tx(this.db, () => {
        this.setClean.run(JSON.stringify({ s: cleaned.subject, t: cleaned.text }), JSON.stringify(cleaned.refs), this.now, r.gmail_id);
        for (const p of cleaned.parties) {
          const key = p.emailKey ? emailMatchKey(p.emailKey) : null;
          this.upsertParty.run(r.gmail_id, p.direction, p.name, key, p.quantity, this.now, this.now);
          this.stats.parties++;
        }
      });
      this.stats.fetched++;
    }
  }
}

/** Newest / oldest internalDate among `ids` that have rows (null when none has). */
function timesOf(db: DB, ids: readonly string[]): { newest: number | null; oldest: number | null; missing: number } {
  if (!ids.length) return { newest: null, oldest: null, missing: 0 };
  const r = db
    .prepare(`SELECT max(internal_at) AS newest, min(internal_at) AS oldest, count(*) AS n FROM gmail_messages WHERE gmail_id IN (SELECT value FROM json_each(?))`)
    .get(JSON.stringify([...new Set(ids)])) as { newest: number | null; oldest: number | null; n: number };
  return { newest: r.newest, oldest: r.oldest, missing: new Set(ids).size - r.n };
}

/**
 * Where a downward walk (the backfill, the steady catch-up) stands after a listing looked at in full: each query
 * that has more pages bounds it — never past what it has not shown yet. `before:` has whole-second resolution, so
 * the next page re-includes the oldest message's second (mails of one order often share a second; a page boundary
 * between them must not drop the rest). `from` once both queries are complete; null while any listed message has
 * no row yet.
 */
function walkBound(db: DB, page: Listing, from: number, live: (ids: Iterable<string>) => string[]): number | null {
  const main = timesOf(db, live(page.mainIds));
  const pass = timesOf(db, live(page.passIds));
  const a = page.mainComplete ? from : main.oldest === null ? null : main.oldest + 1000;
  const b = page.passComplete ? from : pass.oldest === null ? null : pass.oldest + 1000;
  if (main.missing !== 0 || pass.missing !== 0 || a === null || b === null) return null;
  return Math.max(a, b);
}

/** One pass (see the header). Throws GoogleAuthError / GoogleApiError(403) / contract and network errors on a listing. */
export async function syncGmail(db: DB, api: GmailApi, o: GmailSyncOptions = {}): Promise<GmailSyncStats> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const stats = emptyStats();
  const extra = readSetting(db, 'gmail.extra_senders');
  const cursor = readCursor(db, GMAIL_SOURCE, LIST_SCOPE);
  const hw = cursor?.high_water_at ?? null;
  const stored = cursorMeta<ListMeta>(cursor);
  const overlap = o.limits?.overlapMs ?? GMAIL_LIMITS.overlapMs;
  // Until a whole steady listing was looked at (no mark yet), the steady range keeps starting where the backfill
  // started: a range that slid forward with `now` would leave a gap between the two walks.
  const steadyFrom = hw !== null ? hw - overlap : typeof stored.backfillFrom === 'number' ? Math.min(stored.backfillFrom, now - overlap) : now - overlap;
  const meta: ListMeta = {
    backfillBefore: typeof stored.backfillBefore === 'number' ? stored.backfillBefore : steadyFrom,
    backfillFrom: typeof stored.backfillFrom === 'number' ? stored.backfillFrom : steadyFrom,
  };
  if (typeof stored.steadyBefore === 'number' && typeof stored.steadyTop === 'number') Object.assign(meta, { steadyBefore: stored.steadyBefore, steadyTop: stored.steadyTop });
  const floor = floorOf(db, now);
  const L: Record<keyof typeof GMAIL_LIMITS, number> = { ...GMAIL_LIMITS, ...o.limits };
  const budget: Budget = { metadata: L.metadataPerRun, full: L.fullPerRun };
  const p = new Processor(db, api, stats, budget, now, L.maxFailuresInARow, o.signal);

  // 1. Steady: everything since the high-water mark (minus the overlap).
  const steady = await list(api, { from: steadyFrom, to: null }, extra, L.steadyPages, L.pageSize, stats, o.signal);
  const steadyTriaged = await p.triageAll(steady);
  const steadyDone = steadyTriaged && steady.mainComplete && steady.passComplete;
  const live = (ids: Iterable<string>) => [...ids].filter((id) => !p.gone.has(id));
  const seen = timesOf(db, live(steady.ids.keys()));
  // The mark moves only past a listing looked at in full (and never backwards; writeCursor keeps the max).
  let newHw = steadyDone && seen.missing === 0 ? seen.newest : null;

  // 1b. Steady catch-up: a listing longer than one run's pages is walked down to its start (see the header).
  if (newHw !== null) {
    delete meta.steadyBefore;
    delete meta.steadyTop;
  } else if (meta.steadyBefore === undefined && steadyTriaged && seen.missing === 0 && seen.newest !== null) {
    const next = walkBound(db, steady, steadyFrom, live);
    if (next !== null) Object.assign(meta, { steadyBefore: next, steadyTop: seen.newest });
  }
  if (meta.steadyBefore !== undefined && meta.steadyTop !== undefined && budget.metadata > 0 && !o.signal?.aborted) {
    const page = await list(api, { from: steadyFrom, to: meta.steadyBefore }, extra, L.backfillPages, L.pageSize, stats, o.signal);
    stats.steady_pages++;
    if (await p.triageAll(page)) {
      const next = walkBound(db, page, steadyFrom, live);
      if (next !== null) meta.steadyBefore = Math.max(steadyFrom, next >= meta.steadyBefore ? meta.steadyBefore - 1000 : next);
      if (meta.steadyBefore <= steadyFrom) {
        // The whole range up to where the walk started has been looked at.
        newHw = meta.steadyTop;
        delete meta.steadyBefore;
        delete meta.steadyTop;
      }
    }
  }

  // 2. Backfill: one page of each query, older than where the walk stands.
  if (meta.backfillBefore > floor && budget.metadata > 0 && !o.signal?.aborted) {
    const page = await list(api, { from: floor, to: meta.backfillBefore }, extra, L.backfillPages, L.pageSize, stats, o.signal);
    stats.backfill_pages++;
    if (await p.triageAll(page)) {
      const next = walkBound(db, page, floor, live);
      if (next !== null) {
        meta.backfillBefore = Math.max(floor, next >= meta.backfillBefore ? meta.backfillBefore - 1000 : next);
        if (meta.backfillBefore <= floor) stats.backfill_done = 1;
      }
    }
  }

  // 3. Bodies for the candidates (this run's and any left over).
  if (!o.signal?.aborted) await p.fetchPending();

  writeCursor(db, GMAIL_SOURCE, LIST_SCOPE, 'v1', now, { highWaterAt: newHw, meta: { ...meta } });
  log.info('gmail.sync', { counts: nonZero(stats) });
  return stats;
}

const nonZero = (s: object): Record<string, number> =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number' && v !== 0)) as Record<string, number>;

/** Counts for the Sources card (no names, subjects or ids). */
export function gmailCounts(db: DB): Record<string, number> {
  const r = db
    .prepare(
      `SELECT count(*) AS messages, coalesce(sum(triage = 'candidate'), 0) AS candidates, coalesce(sum(parse_status = 'pending' AND triage = 'candidate'), 0) AS pending,
         coalesce(sum(parse_status = 'parsed'), 0) AS parsed FROM gmail_messages`,
    )
    .get() as Record<string, number>;
  const events = db.prepare(`SELECT count(*) FROM ticket_events WHERE merged_into_id IS NULL AND status = 'holding'`).pluck().get() as number;
  return { ...r, holding: events };
}
