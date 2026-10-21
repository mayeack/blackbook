/**
 * One occasions pass (job 'occasions', nightly after Partiful and Google Calendar, and on demand):
 *   1. calendar treatments → calendar events in [now − 400 d, now + 90 d] → clusters, then the ticket events the
 *      owner holds in the same window attach to them or stand alone (tickets.ts) → occasions (build.ts)
 *   2. per occasion: rule classification; for social ones the attendee candidates and scores (infer.ts),
 *      corroboration of shared-calendar events, occasion_candidates (the LLM packet) and the journaled attendee
 *      rows (attendees.ts); non-social, cancelled, excluded, uncorroborated and merged-away occasions get their
 *      agent rows withdrawn
 *   3. interactions + co_attend edges from the counted attendees (effects.ts)
 * Idempotent: a second pass over unchanged data writes nothing and opens no run.
 * The pass is a generator of small steps (one occasion each, its writes in one transaction): runOccasionsAsync, what
 * the job uses, hands the event loop back every SLICE_MS so the 10 s iMessage tail and the HTTP API keep running
 * during a long night, and stops between steps when the scheduler aborts. runOccasions drains it synchronously.
 */
import { localDate } from '@yb/shared';
import { sourceRun } from '../../adapters/common/context';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { applyAttendees, evidenceJson, type ApplyStats } from './attendees';
import { calendarTreatments, ownerEmails } from './calendars';
import { clusterEvents, draftOccasion, loadCalendarEvents, occasionChain, occasionDays, syncOccasions, updateChanged, type OccasionRow } from './build';
import { deriveOccasionEffects, type EffectStats } from './effects';
import { inferAttendees, type Candidate } from './infer';
import { MessageScanner } from './messages';
import { PeopleIndex } from './people';
import { attachTickets, loadTicketEvents } from './tickets';

const DAY = 86_400_000;

export interface OccasionRunOptions {
  now?: number;
  jobRunId?: number | null;
  /** IANA zone for date phrases and local dates (default: settings 'tz', else the system zone). */
  timeZone?: string;
  /** How far back calendar and ticket events are (re)processed. */
  horizonDays?: number;
  aheadDays?: number;
  /** Checked between steps: an aborted pass stops there (its run closes 'partial'; effects wait for the next pass). */
  signal?: AbortSignal;
}

export interface OccasionAsyncOptions extends OccasionRunOptions {
  /** Longest synchronous stretch before the event loop gets a turn (default SLICE_MS). */
  sliceMs?: number;
}

export interface OccasionRunResult {
  stats: OccasionRunStats;
  /** False when the signal stopped the pass early. */
  complete: boolean;
}

export const SLICE_MS = 25;

export interface OccasionRunStats extends EffectStats {
  calendarEvents: number;
  /** Ticket events the owner holds in the window (ticket copies). */
  ticketEvents: number;
  occasions: number;
  occasionsCreated: number;
  occasionsUpdated: number;
  occasionsMerged: number;
  occasionsRetired: number;
  social: number;
  uncorroborated: number;
  candidates: number;
  messagesScanned: number;
  attendeesInserted: number;
  attendeesUpdated: number;
  attendeesWithdrawn: number;
  attendeesBlocked: number;
}

/** Minimum person score kept in occasion_candidates (lower ones are noise for the adjudicator too). */
const KEEP_CANDIDATE = 0.25;
const AGENT_SOURCES = `('inferred','calendar_explicit','calendar_text','partiful','calendar','inference')`;

function settingTimeZone(db: DB): string | undefined {
  const raw = db.prepare(`SELECT value FROM settings WHERE key = 'tz'`).pluck().get() as string | undefined;
  try {
    const tz = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (typeof tz === 'string' && tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    }
  } catch {
    // an invalid zone falls back to the system zone
  }
  return undefined;
}

interface CandidateRowOut {
  cand_key: string;
  kind: string;
  person_id: string | null;
  surface: string | null;
  role: string | null;
  score: number;
  signals: string;
  alternatives: string;
}

function candidateRows(cands: readonly Candidate[]): CandidateRowOut[] {
  const out: CandidateRowOut[] = [];
  for (const c of cands) {
    if (c.kind === 'person') {
      if (c.score < KEEP_CANDIDATE) continue;
      out.push({ cand_key: c.key, kind: 'person', person_id: c.personId, surface: c.surface, role: c.role, score: c.score, signals: evidenceJson(c.signals), alternatives: '[]' });
    } else if (c.kind === 'name') {
      out.push({ cand_key: c.key, kind: 'name', person_id: null, surface: c.surface, role: c.role, score: c.score, signals: '[]', alternatives: JSON.stringify(c.alternatives) });
    } else {
      out.push({ cand_key: c.key, kind: 'group', person_id: null, surface: c.surface, role: null, score: c.score, signals: '[]', alternatives: JSON.stringify(c.members) });
    }
  }
  return out.sort((a, b) => (a.cand_key < b.cand_key ? -1 : a.cand_key > b.cand_key ? 1 : 0));
}

/** Replaces an occasion's candidate rows when they changed; true if they did. */
function writeCandidates(db: DB, occasionId: string, rows: CandidateRowOut[], now: number): boolean {
  const cur = db
    .prepare(`SELECT cand_key, kind, person_id, surface, role, score, signals, alternatives FROM occasion_candidates WHERE occasion_id = ? ORDER BY cand_key`)
    .all(occasionId) as CandidateRowOut[];
  if (JSON.stringify(cur) === JSON.stringify(rows)) return false;
  db.prepare('DELETE FROM occasion_candidates WHERE occasion_id = ?').run(occasionId);
  const ins = db.prepare(
    `INSERT INTO occasion_candidates (occasion_id, cand_key, kind, person_id, surface, role, score, signals, alternatives, updated_at)
     VALUES (@occasion_id, @cand_key, @kind, @person_id, @surface, @role, @score, @signals, @alternatives, @now)`,
  );
  for (const r of rows) ins.run({ ...r, occasion_id: occasionId, now });
  return true;
}

/** Drains the pass synchronously (tests, scripts). */
export function runOccasions(db: DB, o: OccasionRunOptions = {}): OccasionRunStats {
  const pass = occasionPass(db, o);
  for (;;) {
    const r = pass.next();
    if (r.done) return r.value.stats;
  }
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The scheduler's entry point: the same pass, with the event loop given a turn every `sliceMs`. */
export async function runOccasionsAsync(db: DB, o: OccasionAsyncOptions = {}): Promise<OccasionRunResult> {
  const slice = o.sliceMs ?? SLICE_MS;
  const pass = occasionPass(db, o);
  let since = performance.now();
  for (;;) {
    const r = pass.next();
    if (r.done) return r.value;
    if (performance.now() - since >= slice) {
      await yieldToLoop();
      since = performance.now();
    }
  }
}

export function* occasionPass(db: DB, o: OccasionRunOptions): Generator<void, OccasionRunResult> {
  const now = o.now ?? Date.now();
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const from = now - (o.horizonDays ?? 400) * DAY;
  const to = now + (o.aheadDays ?? 90) * DAY;
  const stats: OccasionRunStats = {
    calendarEvents: 0,
    ticketEvents: 0,
    occasions: 0,
    occasionsCreated: 0,
    occasionsUpdated: 0,
    occasionsMerged: 0,
    occasionsRetired: 0,
    social: 0,
    uncorroborated: 0,
    candidates: 0,
    messagesScanned: 0,
    attendeesInserted: 0,
    attendeesUpdated: 0,
    attendeesWithdrawn: 0,
    attendeesBlocked: 0,
    interactionsUpserted: 0,
    interactionsDeleted: 0,
    edgesUpserted: 0,
    edgesDeleted: 0,
  };

  const aborted = () => o.signal?.aborted === true;
  if (aborted()) return { stats, complete: false };
  const treatments = calendarTreatments(db, ownerEmails(db));
  const excluded = new Set([...treatments].filter(([, t]) => t === 'excluded').map(([id]) => id));
  const events = loadCalendarEvents(db, treatments, from, to);
  const tickets = loadTicketEvents(db, from, to);
  stats.calendarEvents = events.length;
  stats.ticketEvents = tickets.live.length;
  const attached = attachTickets(clusterEvents(events), tickets, timeZone);
  const drafts = attached.clusters
    .map((c) => draftOccasion(db, c, { ticketReleased: attached.released.has(c) }))
    .sort((a, b) => a.startsAt - b.startsAt || (a.primary.id < b.primary.id ? -1 : 1));
  yield;
  if (aborted()) return { stats, complete: false };
  const synced = syncOccasions(db, drafts, { now, from, to, excludedCalendars: excluded });
  stats.occasions = synced.occasions.length;
  stats.occasionsCreated = synced.stats.created;
  stats.occasionsUpdated = synced.stats.updated;
  stats.occasionsMerged = synced.stats.merged;
  stats.occasionsRetired = synced.stats.retired;

  const people = new PeopleIndex(db);
  const scanner = new MessageScanner(db, people, timeZone);
  const run = sourceRun(db, 'occasions', { now, jobRunId: o.jobRunId ?? null, kind: 'nightly', actor: 'agent' });
  const runId = () => run.ctx.runId();
  const getOcc = db.prepare('SELECT * FROM occasions WHERE id = ?');
  const handled = new Set<string>();
  const add = (s: ApplyStats) => {
    stats.attendeesInserted += s.inserted;
    stats.attendeesUpdated += s.updated;
    stats.attendeesWithdrawn += s.withdrawn;
    stats.attendeesBlocked += s.blocked;
  };

  try {
    yield;
    for (const occ of synced.occasions) {
      if (aborted()) {
        run.finish('partial', { inserted: stats.attendeesInserted, updated: stats.attendeesUpdated, withdrawn: stats.attendeesWithdrawn });
        return { stats, complete: false };
      }
      const d = occ.draft;
      const social = occ.isSocial && !occ.sensitive;
      const days = occasionDays(d.startsAt, d.endsAt, d.allDay, timeZone, d.primary.dates);
      const notGoing = d.selfDeclined || d.ticketReleased;
      const inference = social && !notGoing ? inferAttendees({ db, people, scanner, days }, d) : null;
      stats.messagesScanned += inference?.scanned ?? 0;
      tx(db, () => {
        const row = getOcc.get(occ.id) as OccasionRow;
        const corroborated = d.treatment !== 'candidate' || (inference?.corroborated ?? false);
        const status = row.classified_by === 'user' ? row.status : notGoing ? 'excluded' : corroborated ? 'active' : 'candidate';
        const rows = candidateRows(inference?.candidates ?? []);
        const changed = writeCandidates(db, occ.id, rows, now);
        updateChanged(db, occ.id, row, { status, corroborated: corroborated ? 1 : 0, candidate_count: rows.length, ...(changed ? { inferred_at: now } : {}) }, now);
        if (social) stats.social++;
        if (status === 'candidate') stats.uncorroborated++;
        stats.candidates += rows.length;

        const chain = occasionChain(db, occ.id);
        const counting = status === 'active' && social && inference !== null;
        add(
          applyAttendees(
            db,
            people,
            { id: occ.id, chain, endsAt: d.endsAt, localDate: [...days][0] ?? localDate(d.startsAt, timeZone) },
            counting ? inference.people : [],
            { runId, now },
          ),
        );
        for (const id of chain) handled.add(id);
      });
      yield;
    }

    // occasions no live cluster covered (cancelled, excluded, merged away): their agent rows are withdrawn
    const leftovers = db
      .prepare(
        `SELECT DISTINCT o.id, o.starts_at, o.ends_at FROM occasions o JOIN event_attendees a ON a.occasion_id = o.id
         WHERE a.source IN ${AGENT_SOURCES} AND a.status NOT IN ('withdrawn', 'rejected')
           AND (o.merged_into_id IS NOT NULL OR o.status <> 'active' OR coalesce(o.is_social, 0) = 0 OR o.sensitive = 1)`,
      )
      .all() as { id: string; starts_at: number; ends_at: number | null }[];
    for (const l of leftovers) {
      if (handled.has(l.id)) continue;
      if (aborted()) {
        run.finish('partial', { inserted: stats.attendeesInserted, updated: stats.attendeesUpdated, withdrawn: stats.attendeesWithdrawn });
        return { stats, complete: false };
      }
      add(applyAttendees(db, people, { id: l.id, chain: [l.id], endsAt: l.ends_at ?? l.starts_at, localDate: localDate(l.starts_at, timeZone) }, [], { runId, now }));
      yield;
    }

    Object.assign(stats, deriveOccasionEffects(db, now));
    run.finish('ok', { inserted: stats.attendeesInserted, updated: stats.attendeesUpdated, withdrawn: stats.attendeesWithdrawn });
  } catch (e) {
    run.finish('error');
    throw e;
  }
  return { stats, complete: true };
}
