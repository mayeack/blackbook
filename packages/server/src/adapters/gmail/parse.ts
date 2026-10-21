/**
 * The ticket parse (design §1 "LLM", review amendments "What reaches Anthropic" and "Jobs"): pending candidate mails
 * → one Message Batch on route 'ticket_parse' (Haiku 5.5, effort low, thinking off, the system prompt cached 1 h; no
 * fallbacks), and the batch consumer that applies each answer to the ledger.
 *
 * Submit (job 'ticket-parse', every 30 min; adapters/gmail/jobs.ts):
 *   - queue: gmail_messages with triage 'candidate', parse_status 'pending' and a clean_text (the gmail job fetched
 *     and masked them), newest first, ≤ 500 per run; rows 'queued' for days whose request is no longer open in the
 *     LLM ledger go back to 'pending' first;
 *   - packet: FROM DOMAIN / SUBJECT / EMAIL DATE (local, weekday) / OWNER TZ / STRUCTURED DATA (the allowlisted
 *     JSON-LD fields) / TEXT, through the egress pseudonymizer (identifiers scrubbed; it scans and fails closed).
 *     FROM DOMAIN names only a vendor's domain; any other sender reads NOT_A_VENDOR (a personal domain names its
 *     owner);
 *   - per-item pre-check: the egress scan, then no token of an llm.excluded_person_ids person. A failing item is
 *     marked 'blocked' (egress) or 'skipped' (excluded) with its clean_text cleared; the rest still go out, so one
 *     bad item never fails the batch;
 *   - pool 'backfill' for mail older than where the backfill started while the backfill runs, else 'steady'; a pool
 *     without budget waits (its rows stay pending). Rows are marked 'queued' before the submit and put back if it
 *     doesn't go out. custom_id `g{promptVersion}-{gmail id}-{attempt}`, subject `gmail:<id>`;
 *   - the attempt: past every one the LLM ledger already holds for the subject at this prompt version (a row
 *     re-created by disconnect-with-deleteData and a reconnect, a reclaim landing on the batch layer's re-queue), so
 *     a sent custom_id is never offered again (the client would refuse the whole batch). A failed submit's id (never
 *     sent) is re-used; an id another subject holds is skipped. A row whose earlier request is still open in the
 *     batch layer waits for that answer (it applies to the same message) instead of racing its re-queue.
 * Apply (the llm-collect job hands each result to the 'ticket_parse' consumer):
 *   - the answer is normalized, its dates re-derived deterministically (dates.ts), and stored as
 *     gmail_messages.parsed; marketing / not_ticket → 'not_ticket', anything else → 'parsed' and placed on the
 *     ledger (ledger.ts); clean_text is cleared (a final state). Re-applying an answer is a no-op;
 *   - a refusal, an answer invalid twice or a dead letter → 'failed' (clean_text cleared). EgressBlocked never
 *     reaches the API (the pre-check), so it is never retried.
 * Logs carry counts only.
 */
import { localParts } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { finishRun, startRun } from '../../journal/runs';
import { registerBatchConsumer, type BatchConsumer, type BatchFailure, type StoredBatchItem } from '../../llm/batches';
import { schemaJson } from '../../llm/caching';
import { personIdsIn } from '../../llm/egress';
import { getRequest, llmExclusions } from '../../llm/ledger';
import { estimatePromptTokens, estimateRouteUsd, resolveRoute, type RouteParams } from '../../llm/models';
import { customId, EgressBlocked, type BudgetPool, type Egress, type LlmBatchItem, type LlmClient } from '../../llm/types';
import { nullLogger, type Logger } from '../../ops/logger';
import { settingTimeZone } from '../../settings/registry';
import { isValidTimeZone } from '../calendar/time';
import type { JsonLdEvent, TicketRefs } from './clean';
import { resolveDates } from './dates';
import { isEventKind, placeMessage, unplaceMessage } from './ledger';
import { TICKET_SYSTEM, TICKET_VERSION, TicketEmail, validateTicketEmail, type TicketCategory, type TicketKind } from './prompt';
import { backfillFrom } from './sync';

export const TICKET_PURPOSE = 'ticket_parse';
const HOUR = 3_600_000;
export const TICKET_PARSE = {
  maxPerRun: 500,
  /** A queued row whose request is no longer open after this long goes back to pending. */
  staleQueuedMs: 72 * HOUR,
} as const;

/** gmail_messages.parsed: the model's answer, normalized, plus the deterministic dates. */
export interface ParsedTicket {
  kind: TicketKind;
  title: string | null;
  performers: string[];
  category: TicketCategory;
  genres: string[];
  venue: string | null;
  city: string | null;
  quantity: number | null;
  /** The model's zone, when it named a valid one. */
  timezone: string | null;
  start_local: string | null;
  end_local: string | null;
  starts_at: number | null;
  ends_at: number | null;
  /** The venue's zone when known; null = guessed from the owner's. */
  tz: string | null;
  local_date: string | null;
  year_fixed: boolean;
  date_source: 'json_ld' | 'model' | 'none';
}

/** What gmail_messages.clean_text holds until a final state: the masked subject and excerpt. */
export interface CleanText {
  s: string;
  t: string;
}

export const subjectRefOf = (gmailId: string) => `gmail:${gmailId}`;
export function parseSubjectRef(ref: string): string | null {
  const m = /^gmail:([A-Za-z0-9_-]{1,64})$/.exec(ref);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------------------------- packet

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** FROM DOMAIN for a sender that is not a ticket vendor. */
export const NOT_A_VENDOR = '(not a ticket vendor: a person, a venue or an organizer)';

interface QueueRow {
  gmail_id: string;
  internal_at: number;
  from_domain: string | null;
  /** The ticket vendor the sender belongs to (VENDORS or gmail.extra_senders); null for anyone else. */
  vendor: string | null;
  refs: string;
  clean_text: string;
  attempts: number;
}

/** The allowlisted JSON-LD fields (nothing else of the markup is ever sent). */
function structuredData(ld: JsonLdEvent | undefined): string {
  if (!ld) return 'none';
  const out: Record<string, unknown> = {};
  if (ld.name) out.name = ld.name;
  if (ld.startDate) out.startDate = ld.startDate;
  if (ld.endDate) out.endDate = ld.endDate;
  if (ld.venue) out.venue = ld.venue;
  if (ld.city) out.city = ld.city;
  if (ld.performers.length) out.performers = ld.performers;
  return Object.keys(out).length ? JSON.stringify(out) : 'none';
}

/** The plain packet for one queued message (before pseudonymization). */
export function packetText(row: Pick<QueueRow, 'internal_at' | 'from_domain' | 'vendor' | 'refs' | 'clean_text'>, ownerTz: string): string {
  const clean = JSON.parse(row.clean_text) as CleanText;
  const refs = JSON.parse(row.refs) as TicketRefs;
  const p = localParts(row.internal_at, ownerTz);
  return [
    // Only a vendor's domain: anyone else's (a friend forwarding an order, a personal domain) can name them.
    `FROM DOMAIN: ${row.vendor && row.from_domain ? row.from_domain : NOT_A_VENDOR}`,
    `SUBJECT: ${clean.s || '(none)'}`,
    `EMAIL DATE: ${p.date} (${WEEKDAY[p.dow] ?? ''}) ${p.hhmm}`,
    `OWNER TZ: ${ownerTz}`,
    `STRUCTURED DATA: ${structuredData(refs.jsonLd)}`,
    'TEXT:',
    clean.t || '(empty)',
  ].join('\n');
}

export type RenderOutcome = { ok: true; text: string } | { ok: false; why: 'blocked' | 'excluded' };

/** Pseudonymized user turn for one message, after the per-item pre-check (see the header). */
export function renderTicketPacket(
  egress: Egress,
  row: Pick<QueueRow, 'internal_at' | 'from_domain' | 'vendor' | 'refs' | 'clean_text'>,
  o: { ownerTz: string; excludedPeople: ReadonlySet<string> },
): RenderOutcome {
  let text: string;
  try {
    text = egress.pseudonymize({ purpose: 'ticket', sections: [{ name: 'email', text: packetText(row, o.ownerTz) }] }).text;
    egress.scan(text);
  } catch (e) {
    if (e instanceof EgressBlocked) return { ok: false, why: 'blocked' };
    throw e;
  }
  if (o.excludedPeople.size && personIdsIn(egress, text).some((id) => o.excludedPeople.has(id))) return { ok: false, why: 'excluded' };
  return { ok: true, text };
}

const PREFIX_TOKENS = estimatePromptTokens(TICKET_SYSTEM.length + schemaJson(TicketEmail).length);
export const estimateUsd = (text: string, p: RouteParams = resolveRoute('ticket_parse')): number =>
  estimateRouteUsd(p, { userTokens: estimatePromptTokens(text), systemTokens: PREFIX_TOKENS, mode: 'batch' });

// ---------------------------------------------------------------------------------------------- submit

export interface SubmitResult {
  status: 'ok' | 'skipped' | 'partial';
  reason: string | null;
  stats: Record<string, number>;
}

/** Final parse states clear clean_text. */
function finalize(db: DB, gmailId: string, status: 'blocked' | 'skipped' | 'failed', errorClass: string, now: number): void {
  db.prepare(`UPDATE gmail_messages SET parse_status = ?, error_class = ?, clean_text = NULL, updated_at = ? WHERE gmail_id = ?`).run(status, errorClass, now, gmailId);
}

/** Queued rows whose request is no longer open in the LLM ledger (lost batch) → pending again, next attempt. */
export function reclaimStaleQueued(db: DB, now: number): number {
  return db
    .prepare(
      `UPDATE gmail_messages SET parse_status = 'pending', custom_id = NULL, attempts = attempts + 1, updated_at = @now
       WHERE parse_status = 'queued' AND updated_at < @before AND clean_text IS NOT NULL AND attempts < 90
         AND NOT EXISTS (SELECT 1 FROM llm_requests r WHERE r.subject_ref = 'gmail:' || gmail_messages.gmail_id
                         AND r.applied_at IS NULL AND r.status IN ('pending','submitted','succeeded','errored','expired','max_tokens','schema_invalid'))`,
    )
    .run({ now, before: now - TICKET_PARSE.staleQueuedMs }).changes;
}

/** What the LLM ledger holds for one subject at this prompt version. */
interface PriorAttempts {
  /** The newest attempt that went out or is the batch layer's (a failed submit's, never sent, is re-usable). */
  top: number;
  /** A request still open: in a batch and not handled yet, or a re-queue waiting to go out. */
  open: boolean;
}

/** PriorAttempts per subject. A re-queue whose body was purged never goes out; one older than the stale window is lost. */
function priorAttempts(db: DB, subjectRefs: readonly string[], now: number): Map<string, PriorAttempts> {
  const out = new Map<string, PriorAttempts>();
  if (!subjectRefs.length) return out;
  const rows = db
    .prepare(
      `SELECT subject_ref, max(attempt) AS top,
         max(applied_at IS NULL AND created_at >= @since AND (batch_id IS NOT NULL OR (status = 'pending' AND params IS NOT NULL))) AS open
       FROM llm_requests
       WHERE kind = 'ticket' AND prompt_version = @version AND subject_ref IN (SELECT value FROM json_each(@refs))
         AND NOT (batch_id IS NULL AND status = 'errored')
       GROUP BY subject_ref`,
    )
    .all({ version: TICKET_VERSION, refs: JSON.stringify(subjectRefs), since: now - TICKET_PARSE.staleQueuedMs }) as { subject_ref: string; top: number; open: number }[];
  for (const r of rows) out.set(r.subject_ref, { top: r.top, open: r.open === 1 });
  return out;
}

/** The first custom_id from attempt `from` on that no ledger row or item of this batch holds (a failed submit of this subject is re-used); null past 99. */
function freeCustomId(db: DB, gmailId: string, from: number, taken: ReadonlySet<string>): { customId: string; attempt: number } | null {
  for (let attempt = from; attempt <= 99; attempt++) {
    const id = customId('ticket', TICKET_VERSION, gmailId, attempt);
    if (taken.has(id)) continue;
    const r = getRequest(db, id);
    if (!r || (r.batch_id === null && r.status === 'errored' && r.subject_ref === subjectRefOf(gmailId))) return { customId: id, attempt };
  }
  return null;
}

/** Builds and submits one batch of pending ticket mails. Never throws for LLM outcomes. */
export async function submitTicketParses(
  db: DB,
  services: { llm: LlmClient; egress: Egress },
  o: { now: number; jobRunId?: number | null; log?: Logger; signal?: AbortSignal; limit?: number; timeZone?: string },
): Promise<SubmitResult> {
  const log = o.log ?? nullLogger;
  const stats: Record<string, number> = { pending: 0, rendered: 0, blocked: 0, excluded: 0, in_flight: 0, exhausted: 0, submitted: 0, unavailable: 0, reclaimed: 0 };
  const { llm, egress } = services;
  if (!llm.configured) return { status: 'skipped', reason: 'no_key', stats };
  const steady = llm.canSpend('steady');
  if (!steady.ok && !llm.canSpend('backfill').ok) return { status: 'skipped', reason: steady.reason, stats };
  stats.reclaimed = reclaimStaleQueued(db, o.now);
  const rows = db
    .prepare(
      `SELECT gmail_id, internal_at, from_domain, vendor, refs, clean_text, attempts FROM gmail_messages
       WHERE triage = 'candidate' AND parse_status = 'pending' AND clean_text IS NOT NULL
       ORDER BY internal_at DESC, gmail_id LIMIT ?`,
    )
    .all(o.limit ?? TICKET_PARSE.maxPerRun) as QueueRow[];
  stats.pending = rows.length;
  if (!rows.length) return { status: 'ok', reason: null, stats };

  const ownerTz = o.timeZone ?? settingTimeZone(db);
  const excludedPeople = llmExclusions(db).people;
  const backfillStart = backfillFrom(db, o.now);
  const params = llm.params('ticket_parse');
  const runId = startRun(db, 'ingest', { jobRunId: o.jobRunId ?? null, now: o.now });
  try {
    await submitRows(db, rows, { llm, egress, runId, ownerTz, excludedPeople, backfillStart, params, stats, log, signal: o.signal, now: o.now });
  } catch (e) {
    finishRun(db, runId, 'error', { summary: { stage: 'ticket-parse', ...stats }, now: o.now });
    throw e;
  }
  finishRun(db, runId, 'ok', { summary: { stage: 'ticket-parse', ...stats }, now: o.now });
  log.info('gmail.ticket_parse_submitted', { counts: stats });
  return { status: stats.unavailable && !stats.submitted ? 'partial' : 'ok', reason: null, stats };
}

interface SubmitCtx {
  llm: LlmClient;
  egress: Egress;
  runId: string;
  ownerTz: string;
  excludedPeople: ReadonlySet<string>;
  backfillStart: number | null;
  params: RouteParams;
  stats: Record<string, number>;
  log: Logger;
  signal?: AbortSignal;
  now: number;
}

/** Renders, pre-checks and submits the rows, one batch per budget pool (see the header). */
async function submitRows(db: DB, rows: readonly QueueRow[], c: SubmitCtx): Promise<void> {
  const { llm, egress, runId, ownerTz, excludedPeople, backfillStart, params, stats, log } = c;
  const o = { now: c.now, signal: c.signal };
  const groups = new Map<BudgetPool, { items: LlmBatchItem[]; ids: { gmailId: string; customId: string; attempt: number }[] }>();
  const prior = priorAttempts(db, rows.map((r) => subjectRefOf(r.gmail_id)), o.now);
  const taken = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (o.signal?.aborted) break;
    const before = prior.get(subjectRefOf(row.gmail_id));
    if (before?.open) {
      stats.in_flight!++;
      continue;
    }
    const free = freeCustomId(db, row.gmail_id, Math.max(row.attempts, before ? before.top + 1 : 0), taken);
    if (!free) {
      finalize(db, row.gmail_id, 'failed', 'attempts_exhausted', o.now);
      stats.exhausted!++;
      continue;
    }
    const r = renderTicketPacket(egress, row, { ownerTz, excludedPeople });
    if (!r.ok) {
      finalize(db, row.gmail_id, r.why === 'blocked' ? 'blocked' : 'skipped', r.why === 'blocked' ? 'egress_blocked' : 'llm_excluded', o.now);
      stats[r.why]!++;
      continue;
    }
    stats.rendered!++;
    taken.add(free.customId);
    const pool: BudgetPool = backfillStart !== null && row.internal_at < backfillStart ? 'backfill' : 'steady';
    const cid = free.customId;
    const g = groups.get(pool) ?? { items: [], ids: [] };
    g.items.push({
      customId: cid,
      kind: 'ticket',
      route: 'ticket_parse',
      subjectRef: subjectRefOf(row.gmail_id),
      promptVersion: TICKET_VERSION,
      system: TICKET_SYSTEM,
      messages: [{ role: 'user', content: r.text }],
      pool,
      estimateUsd: estimateUsd(r.text, params),
      runId,
      schema: TicketEmail,
    });
    g.ids.push({ gmailId: row.gmail_id, customId: cid, attempt: free.attempt });
    groups.set(pool, g);
    if (i % 25 === 24) await new Promise<void>((res) => setImmediate(res));
  }
  for (const [pool, g] of groups) {
    if (!g.items.length) continue;
    const est = g.items.reduce((s, it) => s + (it.estimateUsd ?? 0), 0);
    const check = llm.canSpend(pool, est);
    if (!check.ok) {
      stats.unavailable! += g.items.length;
      log.info('gmail.ticket_parse_skipped', { counts: { items: g.items.length }, error_class: check.reason });
      continue;
    }
    tx(db, () => {
      const mark = db.prepare(
        `UPDATE gmail_messages SET parse_status = 'queued', custom_id = ?, prompt_version = ?, attempts = ?, updated_at = ? WHERE gmail_id = ? AND parse_status = 'pending'`,
      );
      for (const x of g.ids) mark.run(x.customId, TICKET_VERSION, x.attempt, o.now, x.gmailId);
    });
    const putBack = () =>
      tx(db, () => {
        const back = db.prepare(`UPDATE gmail_messages SET parse_status = 'pending', custom_id = NULL, updated_at = ? WHERE gmail_id = ? AND parse_status = 'queued'`);
        for (const x of g.ids) back.run(o.now, x.gmailId);
      });
    let res: Awaited<ReturnType<LlmClient['submitBatch']>>;
    try {
      res = await llm.submitBatch(g.items, { purpose: TICKET_PURPOSE, runId });
    } catch (e) {
      putBack(); // never left waiting as 'queued' for a batch that doesn't exist
      throw e;
    }
    if (res.status !== 'submitted') {
      putBack();
      stats.unavailable! += g.items.length;
      log.info('gmail.ticket_parse_not_submitted', { counts: { items: g.items.length }, error_class: res.reason });
      continue;
    }
    stats.submitted! += res.count;
  }
}

// ---------------------------------------------------------------------------------------------- apply

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** The model's answer, normalized, with the deterministic dates (dates.ts). */
export function normalizeTicket(v: TicketEmail, ctx: { refs: TicketRefs; emailAt: number; ownerTz: string }): ParsedTicket {
  const performers: string[] = [];
  for (const p of v.performers) {
    const c = clean(p, 120);
    if (c && !performers.some((x) => x.toLowerCase() === c.toLowerCase())) performers.push(c);
  }
  const genres = [...new Set(v.genres.map((g) => clean(g, 40)?.toLowerCase()).filter((g): g is string => !!g))].slice(0, 3);
  const ld = ctx.refs.jsonLd;
  const modelTz = clean(v.timezone, 64);
  const d = resolveDates({
    kind: v.kind,
    category: v.category,
    startLocal: v.start_local,
    endLocal: v.end_local,
    timezone: modelTz,
    jsonLdStart: ld?.startDate ?? null,
    jsonLdEnd: ld?.endDate ?? null,
    emailAt: ctx.emailAt,
    ownerTz: ctx.ownerTz,
    weekdays: ctx.refs.weekdays,
  });
  return {
    kind: v.kind,
    title: clean(v.title, 200) ?? (isEventKind(v.kind) ? clean(ld?.name, 200) : null),
    performers: (performers.length ? performers : (ld?.performers ?? [])).slice(0, 12),
    category: v.category,
    genres,
    venue: clean(v.venue, 200) ?? clean(ld?.venue, 200),
    city: clean(v.city, 80) ?? clean(ld?.city, 80),
    quantity: v.quantity !== null && v.quantity > 0 ? v.quantity : null,
    timezone: modelTz && isValidTimeZone(modelTz) ? modelTz : null,
    start_local: d.startLocal,
    end_local: d.startsAt !== null ? d.endLocal : null,
    starts_at: d.startsAt,
    ends_at: d.startsAt !== null ? d.endsAt : null,
    tz: d.tz,
    local_date: d.localDate,
    year_fixed: d.yearFixed,
    date_source: d.source,
  };
}

/** Applies one ticket-parse answer (see the header). 'rejected' when the message is gone or not a candidate. */
export function applyTicketParse(db: DB, subjectRef: string, value: TicketEmail, o: { now: number; ownerTz?: string }): 'applied' | 'rejected' {
  const gmailId = parseSubjectRef(subjectRef);
  if (!gmailId) return 'rejected';
  const row = db.prepare('SELECT gmail_id, internal_at, triage, refs FROM gmail_messages WHERE gmail_id = ?').get(gmailId) as
    | { gmail_id: string; internal_at: number; triage: string; refs: string }
    | undefined;
  if (!row || row.triage !== 'candidate') return 'rejected';
  const ownerTz = o.ownerTz ?? settingTimeZone(db);
  let refs: TicketRefs;
  try {
    refs = JSON.parse(row.refs) as TicketRefs;
  } catch {
    refs = {};
  }
  const parsed = normalizeTicket(value, { refs, emailAt: row.internal_at, ownerTz });
  tx(db, () => {
    const ticket = isEventKind(parsed.kind);
    db.prepare(
      `UPDATE gmail_messages SET parse_status = ?, parsed = ?, clean_text = NULL, error_class = NULL, prompt_version = coalesce(prompt_version, ?), updated_at = ?
       WHERE gmail_id = ?`,
    ).run(ticket ? 'parsed' : 'not_ticket', JSON.stringify(parsed), TICKET_VERSION, o.now, gmailId);
    if (ticket) placeMessage(db, gmailId, { now: o.now, ownerTz });
    else unplaceMessage(db, gmailId, { now: o.now, ownerTz });
  });
  return 'applied';
}

/** A request that will never get a usable answer (refused, invalid twice, dead-lettered) → 'failed'. */
export function failTicketParse(db: DB, subjectRef: string, why: BatchFailure, now: number): void {
  const gmailId = parseSubjectRef(subjectRef);
  if (!gmailId) return;
  db.prepare(
    `UPDATE gmail_messages SET parse_status = 'failed', error_class = ?, clean_text = NULL, updated_at = ?
     WHERE gmail_id = ? AND parse_status IN ('pending','queued')`,
  ).run(why, now, gmailId);
}

export function ticketConsumer(o: { now?: () => number } = {}): BatchConsumer<TicketEmail> {
  const now = o.now ?? Date.now;
  return {
    purpose: TICKET_PURPOSE,
    schema: () => TicketEmail,
    validate: (v) => validateTicketEmail(v),
    apply: (db: DB, item: StoredBatchItem, value: TicketEmail) => applyTicketParse(db, item.subjectRef, value, { now: now() }),
    fail: (db: DB, item: StoredBatchItem, why: BatchFailure) => failTicketParse(db, item.subjectRef, why, now()),
  };
}

/** Registers the consumer the llm-collect job hands ticket-parse results to (idempotent per purpose). */
export function registerTicketConsumer(o: { now?: () => number } = {}): () => void {
  return registerBatchConsumer(ticketConsumer(o));
}
