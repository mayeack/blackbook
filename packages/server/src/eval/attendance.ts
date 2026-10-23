/**
 * Attendance eval: the attendee deduction (pipeline/occasions) graded against confirmed attendance. `yb eval
 * attendance` is read-only and LLM-free; it prints counts and rates, never names or message text.
 *
 * Ground truth is the Partiful guest list of every past Partiful event the owner went to (his RSVP going / approved /
 * checked in / attended, or he hosted) whose list was read completely (partiful_event_sync.guests_status 'ok'):
 *   confirmed     going, approved, checked in, attended, host
 *   absent        declined, or not on the list at all (a plus-one or a walk-in is graded as absent: a floor, not
 *                 an exact precision)
 *   unknown       maybe, invited, waitlist (not graded)
 * Partiful often lists a guest or host by first name only, as a record of its own ("Sam" next to the contact
 * "Sam Rivera"): a person whose first name agrees with a listed record and whose last name doesn't contradict
 * it gets that record's grade.
 * Each event is re-run through the deduction as if no guest list existed: a calendar-style occasion with its
 * title, venue and time and nothing linking it to Partiful, so only the message clues (and names in the title) can
 * find people. The other plans around it (calendar occasions, Partiful events) are the same ones the nightly pass
 * weighs against, minus the event's own copies.
 * A second check grades what is stored today: message-only attendee rows (the deterministic 'inferred' ones and
 * the LLM adjudicator's) on the occasions linked to those events. The adjudicator saw the guest list there, so its
 * score on people who are not on it is the part that says something.
 */
import { firstNameScore, lastNameScore, localDate } from '@yb/shared';
import type { DB } from '../db/connection';
import { calendarTreatments, ownerEmails } from '../pipeline/occasions/calendars';
import { clusterEvents, draftOccasion, loadCalendarEvents, occasionChain, occasionDays, type CalEvent } from '../pipeline/occasions/build';
import { inferAttendees, type PersonCandidate } from '../pipeline/occasions/infer';
import { OccasionPlans } from '../pipeline/occasions/plans';
import { MessageScanner } from '../pipeline/occasions/messages';
import { PeopleIndex } from '../pipeline/occasions/people';
import { COUNTED, NAMED, POSSIBLE, type SignalType } from '../pipeline/occasions/signals';
import { venueKey, words } from '../pipeline/occasions/text';

const DAY = 86_400_000;
const DEFAULT_LENGTH = 3 * 3_600_000;
/** Candidates below this are noise (the nightly pass doesn't keep them either). */
const KEEP = 0.25;

const GOING = new Set(['going', 'approved', 'checked_in', 'attended', 'host']);
const OWNER_WENT = `(lower(coalesce(e.my_rsvp, '')) IN ('going', 'approved', 'checked_in', 'attended') OR lower(coalesce(e.my_role, '')) IN ('host', 'co_host', 'cohost'))`;

export type Grade = 'confirmed' | 'absent' | 'unknown';

export interface GradeCounts {
  n: number;
  confirmed: number;
  absent: number;
  unknown: number;
  /** confirmed / (confirmed + absent); null without graded predictions. */
  precision: number | null;
}

export interface AttendanceEvalReport {
  /** Partiful events graded (past, owner went, complete guest list, ≥ minGuests known guests). */
  events: number;
  /** Known people on those lists. */
  truth: { confirmed: number; declined: number };
  deduction: {
    /** Predictions at "possible" (≥ 0.5) and at "attended" (≥ 0.75). */
    possible: GradeCounts;
    counted: GradeCounts;
    /** Confirmed guests found at ≥ 0.5 / ≥ 0.75, out of truth.confirmed. */
    recallPossible: number | null;
    recallCounted: number | null;
    /** Every candidate ≥ 0.25 that carries the clue type. */
    bySignal: ({ type: SignalType } & GradeCounts)[];
    byScore: ({ band: string } & GradeCounts)[];
  };
  stored: {
    /** Message-only rows the adjudicator wrote (≥ 0.5). */
    llm: GradeCounts;
    /** Message-only rows the deterministic pass wrote (≥ 0.5). */
    inferred: GradeCounts;
  };
}

export interface AttendanceEvalOptions {
  now?: number;
  timeZone?: string;
  /** Events with fewer known guests on the list are skipped (default 2). */
  minGuests?: number;
  /** Grade the clues without weighing them against the owner's other plans (the pre-plans deduction). */
  withoutPlans?: boolean;
}

const empty = (): GradeCounts => ({ n: 0, confirmed: 0, absent: 0, unknown: 0, precision: null });

function tally(c: GradeCounts, g: Grade): void {
  c.n++;
  c[g]++;
}

function finish(c: GradeCounts): GradeCounts {
  const graded = c.confirmed + c.absent;
  return { ...c, precision: graded ? round(c.confirmed / graded) : null };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

interface GradedEvent {
  id: string;
  title: string;
  location: string | null;
  startsAt: number;
  endsAt: number;
  confirmed: Set<string>;
  declined: Set<string>;
  listed: Set<string>;
  /** Names of the listed records, for guests Partiful knows only by first name. */
  names: { first: string; last: string; grade: Grade }[];
}

function settingTimeZone(db: DB): string | undefined {
  const raw = db.prepare(`SELECT value FROM settings WHERE key = 'tz'`).pluck().get() as string | undefined;
  try {
    const tz = raw ? (JSON.parse(raw) as unknown) : undefined;
    return typeof tz === 'string' && tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** Past Partiful events the owner went to, with their complete guest lists (known, visible people only). */
export function gradedEvents(db: DB, people: PeopleIndex, now: number, minGuests = 2): GradedEvent[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.location_text, e.starts_at, e.ends_at
       FROM events e JOIN partiful_event_sync s ON s.event_id = e.source_event_id
       WHERE e.source = 'partiful' AND e.starts_at IS NOT NULL AND coalesce(e.ends_at, e.starts_at) < @now
         AND s.guests_status = 'ok' AND ${OWNER_WENT}
       ORDER BY e.starts_at, e.id`,
    )
    .all({ now }) as { id: string; title: string | null; location_text: string | null; starts_at: number; ends_at: number | null }[];
  const guests = db.prepare(
    `SELECT person_id, lower(status) AS status, lower(coalesce(role, '')) AS role FROM event_attendees WHERE event_id = ? AND source = 'partiful'`,
  );
  const out: GradedEvent[] = [];
  for (const r of rows) {
    const confirmed = new Set<string>();
    const declined = new Set<string>();
    const listed = new Set<string>();
    for (const g of guests.all(r.id) as { person_id: string; status: string; role: string }[]) {
      const pid = people.visibleCanonical(g.person_id);
      if (!pid || pid === people.me) continue;
      listed.add(pid);
      if (GOING.has(g.status) || g.role === 'host' || g.role === 'co_host') confirmed.add(pid);
      else if (g.status === 'declined') declined.add(pid);
    }
    // a person listed twice (two identities) counts as their best status
    for (const pid of confirmed) declined.delete(pid);
    if (listed.size < minGuests) continue;
    const endsAt = r.ends_at && r.ends_at > r.starts_at ? r.ends_at : r.starts_at + DEFAULT_LENGTH;
    const names = [...listed].flatMap((pid) => {
      const p = people.get(pid);
      return p?.first ? [{ first: p.first, last: p.last, grade: (confirmed.has(pid) ? 'confirmed' : declined.has(pid) ? 'absent' : 'unknown') as Grade }] : [];
    });
    out.push({ id: r.id, title: (r.title ?? '').trim(), location: r.location_text, startsAt: r.starts_at, endsAt, confirmed, declined, listed, names });
  }
  return out;
}

const GRADE_RANK: Record<Grade, number> = { confirmed: 2, unknown: 1, absent: 0 };

function gradeOf(e: GradedEvent, people: PeopleIndex, pid: string): Grade {
  if (e.confirmed.has(pid)) return 'confirmed';
  if (e.declined.has(pid)) return 'absent';
  if (e.listed.has(pid)) return 'unknown';
  const p = people.get(pid);
  let best: Grade | null = null;
  for (const n of p?.first ? e.names : []) {
    if (firstNameScore(n.first, p!.first) < 0.9 || lastNameScore(n.last, p!.last) < 0.6 || (n.last && p!.last && lastNameScore(n.last, p!.last) < 1)) continue;
    if (best === null || GRADE_RANK[n.grade] > GRADE_RANK[best]) best = n.grade;
  }
  return best ?? 'absent';
}

/** The event as a calendar-style occasion with nothing tying it to Partiful (no id, no guest list). */
function heldOutEvent(e: GradedEvent): CalEvent {
  const location = (e.location ?? '').trim();
  return {
    id: `eval:${e.id}`,
    calendarId: 'eval',
    treatment: 'attending',
    title: e.title,
    notes: '',
    location,
    venue: location,
    venueKey: venueKey(location),
    titleKey: words(e.title).join(' '),
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: false,
    icalUid: null,
    dates: null,
    partifulIds: [],
    reservation: false,
    selfDeclined: false,
    attendees: [],
    social: true,
    series: null,
  };
}

/** The owner's plans as the nightly pass sees them (its calendar window and treatments), built read-only. */
function livePlans(db: DB, people: PeopleIndex, now: number, timeZone: string | undefined): OccasionPlans {
  const events = loadCalendarEvents(db, calendarTreatments(db, ownerEmails(db)), now - 400 * DAY, now + 90 * DAY);
  const kinds = db.prepare(
    `SELECT o.kind, o.sensitive FROM occasion_sources s JOIN occasions o ON o.id = s.occasion_id WHERE s.source = 'calendar' AND s.source_ref = ?`,
  );
  const drafts = clusterEvents(events).map((c) => draftOccasion(db, c));
  return OccasionPlans.build(
    db,
    people,
    drafts.map((draft) => {
      const stored = kinds.get(draft.primary.id) as { kind: string; sensitive: number } | undefined;
      return { draft, ...(stored ? { kind: stored.kind, sensitive: stored.sensitive === 1 } : {}) };
    }),
    { timeZone },
  );
}

export function runAttendanceEval(db: DB, o: AttendanceEvalOptions = {}): AttendanceEvalReport {
  const now = o.now ?? Date.now();
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const people = new PeopleIndex(db);
  const scanner = new MessageScanner(db, people, timeZone);
  const events = gradedEvents(db, people, now, o.minGuests ?? 2);
  // The other plans the nightly pass weighs a clue against.
  const plans = o.withoutPlans ? undefined : livePlans(db, people, now, timeZone);

  const possible = empty();
  const counted = empty();
  const bySignal = new Map<SignalType, GradeCounts>();
  const bands = [
    { band: '0.25–0.5', lo: KEEP, hi: POSSIBLE },
    { band: '0.5–0.75', lo: POSSIBLE, hi: COUNTED },
    { band: '0.75–1', lo: COUNTED, hi: 1.01 },
  ].map((b) => ({ ...b, c: empty() }));
  let foundPossible = 0;
  let foundCounted = 0;
  let truthConfirmed = 0;
  let truthDeclined = 0;

  for (const e of events) {
    truthConfirmed += e.confirmed.size;
    truthDeclined += e.declined.size;
    const d = draftOccasion(db, [heldOutEvent(e)]);
    const days = occasionDays(d.startsAt, d.endsAt, d.allDay, timeZone);
    const inference = inferAttendees({ db, people, scanner, days, ...(plans ? { plans, exclude: { eventId: e.id } } : {}) }, d);
    for (const c of inference.people as PersonCandidate[]) {
      if (c.score < KEEP) continue;
      const g = gradeOf(e, people, c.personId);
      for (const s of c.signals) {
        let t = bySignal.get(s.type);
        if (!t) bySignal.set(s.type, (t = empty()));
        tally(t, g);
      }
      for (const b of bands) if (c.score >= b.lo && c.score < b.hi) tally(b.c, g);
      if (c.score >= POSSIBLE) {
        tally(possible, g);
        if (g === 'confirmed') foundPossible++;
      }
      if (c.score >= COUNTED) {
        tally(counted, g);
        if (g === 'confirmed') foundCounted++;
      }
    }
  }

  return {
    events: events.length,
    truth: { confirmed: truthConfirmed, declined: truthDeclined },
    deduction: {
      possible: finish(possible),
      counted: finish(counted),
      recallPossible: truthConfirmed ? round(foundPossible / truthConfirmed) : null,
      recallCounted: truthConfirmed ? round(foundCounted / truthConfirmed) : null,
      bySignal: [...bySignal].map(([type, c]) => ({ type, ...finish(c) })).sort((a, b) => b.n - a.n || (a.type < b.type ? -1 : 1)),
      byScore: bands.map((b) => ({ band: b.band, ...finish(b.c) })),
    },
    stored: storedRows(db, people, events),
  };
}

/** Message-only attendee rows stored today on the occasions linked to the graded events. */
function storedRows(db: DB, people: PeopleIndex, events: readonly GradedEvent[]): AttendanceEvalReport['stored'] {
  const llm = empty();
  const inferred = empty();
  const linked = db.prepare(`SELECT id FROM occasions WHERE event_id = ? AND merged_into_id IS NULL`).pluck();
  const rows = db.prepare(
    `SELECT person_id, source, confidence, evidence FROM event_attendees
     WHERE occasion_id IN (SELECT value FROM json_each(?)) AND source IN ('llm', 'inferred')
       AND status IN ('attended', 'going', 'possible') AND confidence >= ?`,
  );
  for (const e of events) {
    const chain = (linked.all(e.id) as string[]).flatMap((id) => occasionChain(db, id));
    if (!chain.length) continue;
    const seen = new Set<string>();
    for (const r of rows.all(JSON.stringify(chain), POSSIBLE) as { person_id: string; source: string; confidence: number; evidence: string }[]) {
      const pid = people.visibleCanonical(r.person_id);
      if (!pid || seen.has(pid)) continue;
      const types = (JSON.parse(r.evidence) as { t?: string }[]).map((x) => x.t as SignalType);
      if (types.some((t) => NAMED.has(t))) continue;
      seen.add(pid);
      tally(r.source === 'llm' ? llm : inferred, gradeOf(e, people, pid));
    }
  }
  return { llm: finish(llm), inferred: finish(inferred) };
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);
const line = (label: string, c: GradeCounts) =>
  `${label.padEnd(18)} precision ${pct(c.precision).padStart(6)}   n=${c.n} (confirmed ${c.confirmed} · absent ${c.absent} · unknown ${c.unknown})`;

export function formatAttendanceReport(r: AttendanceEvalReport, at: number, timeZone?: string): string[] {
  const out = [
    `attendance eval (${localDate(at, timeZone)}): ${r.events} past Partiful events you went to, guest lists held out`,
    `  truth: ${r.truth.confirmed} confirmed guests · ${r.truth.declined} declined`,
    'deduction (message clues + names in the title):',
    `  ${line('possible ≥ 0.5', r.deduction.possible)}`,
    `  ${line('attended ≥ 0.75', r.deduction.counted)}`,
    `  recall: ${pct(r.deduction.recallPossible)} at ≥ 0.5 · ${pct(r.deduction.recallCounted)} at ≥ 0.75`,
    '  by clue (every candidate ≥ 0.25 carrying it):',
    ...r.deduction.bySignal.map((s) => `    ${line(s.type, s)}`),
    '  by score:',
    ...r.deduction.byScore.map((b) => `    ${line(b.band, b)}`),
    'stored rows (message-only, ≥ 0.5) on the linked occasions:',
    `  ${line('llm', r.stored.llm)}`,
    `  ${line('inferred', r.stored.inferred)}`,
    'absent = declined or not on the list (plus-ones and walk-ins land here too, so precision is a floor).',
  ];
  return out;
}
