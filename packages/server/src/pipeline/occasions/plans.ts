/**
 * The owner's other plans, so a message clue counts for the get-together it is about and not for every occasion
 * near it. A "thank you for coming" at 00:08 on Saturday says the owner saw someone, not which plan: a Thursday
 * wine tasting, a Friday dinner and that friend's own show on Friday night all sit inside its 36 h window. Graded
 * against Partiful guest lists (`yb eval attendance`), clues taken without this check were wrong far more often
 * than right.
 *
 * Plans: the run's occasions (not all-day, not on a community calendar awaiting corroboration, not declined, not
 * errands, appointments, lodging or travel), plus Partiful events the owner went to that no occasion covers. A plan
 * names the people its title words or "w/" names could be, its explicit invitees and its Partiful going/host guests.
 *
 * A standing plan is one instance of a recurring listing on a calendar other than the owner's own (a weekly wine
 * tasting on an owned "Recurring Events" calendar) with no invitees and no Partiful link: the calendar
 * says it happens that week, not that he went, and a name in a listing's title is the act, not his company.
 *
 * For one occasion and one person, per message clue:
 *   - about the occasion (its title or venue words, a group that discussed it): counts, except that a standing
 *     instance cedes it to a sibling of the same series nearer the message ("wine tasting thursday?" is about one
 *     week, not the next one too);
 *   - timed (omw / here near the start, "great seeing you" after, photos) and day clues (a date phrase or tickets
 *     talk for that day): counts in full when this occasion names the person; dropped when another plan the message
 *     could be about names them; for a standing instance, dropped when a one-off plan is also in reach; in full when
 *     the person also wrote about this occasion (that says which plan the timing belongs to); otherwise shared with
 *     the other plans that explain it at least as well (ended later; as near the message, an ongoing plan being
 *     nearest; same day; a party the owner hosted shares only with other parties he hosted), weight / (1 + n).
 *     An after-message that says which night ("thank you for last night") or what it was ("thanks for having us
 *     for brunch") only reaches the plans that fit: a different night drops it, this night counts in full (they
 *     spent that evening together), a kind word only this occasion's title has settles it, one only another plan's
 *     title has gives it to that plan;
 *   - a standing instance keeps timed and day clues only for people with an about clue that survived.
 */
import { localDate } from '@yb/shared';
import type { DB } from '../../db/connection';
import { occasionChain, occasionDays, type OccasionDraft } from './build';
import { primaryCalendars } from './calendars';
import type { PeopleIndex } from './people';
import type { Signal, SignalType } from './signals';
import { kindWordsOf, titleNameWords } from './text';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Longer timed plans are trips or festivals: they don't explain one evening's messages. */
const MAX_PLAN_MS = DAY;
/** Plans looked at around an occasion: its 14-day message window, padded by the longest clue reach. */
const LOOK_BEFORE = 15 * DAY;
const LOOK_AFTER = 3 * DAY;

const PLAN_KINDS_EXCLUDED = new Set(['logistics', 'appointment', 'lodging', 'travel']);
const GOING = new Set(['going', 'approved', 'checked_in', 'attended', 'host']);
const HOSTED = `lower(coalesce(my_role, '')) IN ('host', 'co_host', 'cohost')`;
const OWNER_WENT = `(lower(coalesce(my_rsvp, '')) IN ('going', 'approved', 'checked_in', 'attended') OR ${HOSTED})`;

export const ABOUT_CLUES: ReadonlySet<SignalType> = new Set(['mention_dm', 'mention_group', 'group_discussed']);
const AFTER_CLUES: ReadonlySet<SignalType> = new Set(['after_dm', 'after_group']);
const LOGISTICS_CLUES: ReadonlySet<SignalType> = new Set(['logistics_dm', 'logistics_group']);
const DAY_CLUES: ReadonlySet<SignalType> = new Set(['date_dm', 'tickets_dm']);
/** Clues that depend on when a message was sent rather than what it says about the occasion. */
export const TIMED_CLUES: ReadonlySet<SignalType> = new Set([...AFTER_CLUES, 'photos_dm', ...LOGISTICS_CLUES, ...DAY_CLUES]);

export interface Plan {
  /** The draft's primary calendar event id, or 'event:<id>' for a Partiful event no occasion covers. */
  key: string;
  /** Linked Partiful event (events.id). */
  eventId: string | null;
  startsAt: number;
  endsAt: number;
  days: ReadonlySet<string>;
  /** The night it belongs to (its start, a night running to 05:00). */
  night: string;
  /** Kind words of its title ("brunch", "dinner", "show"). */
  kinds: ReadonlySet<string>;
  /** The owner hosted it (his Partiful role). */
  hosted: boolean;
  series: string | null;
  standing: boolean;
  people: ReadonlySet<string>;
}

/**
 * A message clue as the scanner emits it: one message, when it was sent, and for an after-message the night ("last
 * night") or day ("this afternoon") it points back to and the kind words it uses ("brunch").
 */
export type TimedSignal = Signal & { at?: number; night?: string; day?: string; kinds?: string[] };

/** A recurring listing's instance with nothing that makes this week's one the owner's plan. */
export function isStanding(d: Pick<OccasionDraft, 'events' | 'eventId' | 'partifulId' | 'attendees'>): boolean {
  return d.events.length > 0 && d.events.every((e) => e.series !== null) && !d.eventId && !d.partifulId && d.attendees.length === 0;
}

/**
 * Everyone a plan names: title words and "w/" names (every visible match; a standing listing's don't count),
 * invitees, Partiful going/host guests.
 */
export function planPeople(
  db: DB,
  people: PeopleIndex,
  d: Pick<OccasionDraft, 'title' | 'eventTitle' | 'mentions' | 'attendees' | 'eventId'>,
  standing = false,
): Set<string> {
  const out = new Set<string>();
  const add = (id: string | null) => {
    if (id && id !== people.me) out.add(id);
  };
  if (!standing) {
    for (const w of new Set([...titleNameWords(d.title), ...titleNameWords(d.eventTitle)])) for (const id of people.lookupName(w).ids) add(id);
    for (const m of d.mentions) for (const id of people.lookupName(m.norm).ids) add(id);
  }
  for (const a of d.attendees) if (a.response !== 'declined' && a.email) add(people.personOfEmail(a.email));
  if (d.eventId) for (const id of eventGuests(db, d.eventId)) add(people.visibleCanonical(id));
  return out;
}

function eventGuests(db: DB, eventId: string): string[] {
  const rows = db
    .prepare(`SELECT person_id, lower(status) AS status, lower(coalesce(role, '')) AS role FROM event_attendees WHERE event_id = ? AND source = 'partiful'`)
    .all(eventId) as { person_id: string; status: string; role: string }[];
  return rows.filter((r) => GOING.has(r.status) || r.role === 'host' || r.role === 'co_host').map((r) => r.person_id);
}

export interface PlanSource {
  draft: OccasionDraft;
  /** Kind as stored (an LLM or user classification wins over the rules); default the draft's rule kind. */
  kind?: string;
  sensitive?: boolean;
}

const hostedBy = (db: DB, eventId: string | null): boolean =>
  eventId !== null && db.prepare(`SELECT 1 FROM events WHERE id = ? AND ${HOSTED}`).get(eventId) !== undefined;

export class OccasionPlans {
  private constructor(
    private readonly db: DB,
    private readonly people: PeopleIndex,
    /** Sorted by start. */
    private readonly plans: Plan[],
    private readonly timeZone: string | undefined,
  ) {}

  /** The plans among `sources` plus the Partiful events the owner went to that none of them links. */
  static build(db: DB, people: PeopleIndex, sources: readonly PlanSource[], o: { timeZone?: string } = {}): OccasionPlans {
    const plans: Plan[] = [];
    const linked = new Set<string>();
    for (const s of sources) {
      const d = s.draft;
      if (d.eventId) linked.add(d.eventId);
      const kind = s.kind ?? d.classification.kind;
      if (d.allDay || d.treatment === 'candidate' || d.selfDeclined || (s.sensitive ?? d.classification.sensitive) || PLAN_KINDS_EXCLUDED.has(kind)) continue;
      if (d.endsAt - d.startsAt > MAX_PLAN_MS) continue;
      plans.push({
        key: d.primary.id,
        eventId: d.eventId,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        days: occasionDays(d.startsAt, d.endsAt, false, o.timeZone),
        night: localDate(d.startsAt - 5 * HOUR, o.timeZone),
        kinds: kindWordsOf(d.title, d.eventTitle),
        hosted: hostedBy(db, d.eventId),
        series: d.primary.series,
        standing: isStanding(d),
        people: planPeople(db, people, d, isStanding(d)),
      });
    }
    const events = db
      .prepare(
        `SELECT id, title, starts_at, ends_at, ${HOSTED} AS hosted FROM events
         WHERE source = 'partiful' AND starts_at IS NOT NULL AND ${OWNER_WENT}`,
      )
      .all() as { id: string; title: string | null; starts_at: number; ends_at: number | null; hosted: number }[];
    for (const e of events) {
      if (linked.has(e.id)) continue;
      const endsAt = e.ends_at && e.ends_at > e.starts_at ? e.ends_at : e.starts_at + 3 * HOUR;
      if (endsAt - e.starts_at > MAX_PLAN_MS) continue;
      plans.push({
        key: `event:${e.id}`,
        eventId: e.id,
        startsAt: e.starts_at,
        endsAt,
        days: occasionDays(e.starts_at, endsAt, false, o.timeZone),
        night: localDate(e.starts_at - 5 * HOUR, o.timeZone),
        kinds: kindWordsOf(e.title),
        hosted: e.hosted === 1,
        series: null,
        standing: false,
        people: planPeople(db, people, { title: e.title ?? '', eventTitle: null, mentions: [], attendees: [], eventId: e.id }),
      });
    }
    plans.sort((a, b) => a.startsAt - b.startsAt || (a.key < b.key ? -1 : 1));
    return new OccasionPlans(db, people, plans, o.timeZone);
  }

  get size(): number {
    return this.plans.length;
  }

  /** Plans starting in [from, to]. */
  private between(from: number, to: number): Plan[] {
    let lo = 0;
    let hi = this.plans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.plans[mid]!.startsAt < from) lo = mid + 1;
      else hi = mid;
    }
    const out: Plan[] = [];
    for (let i = lo; i < this.plans.length && this.plans[i]!.startsAt <= to; i++) out.push(this.plans[i]!);
    return out;
  }

  /**
   * Attribution for one occasion. `exclude` drops its own copies: plans with these keys or linked to this Partiful
   * event (the eval holds a Partiful event out and re-runs it as a calendar occasion).
   */
  attribution(d: OccasionDraft, days: ReadonlySet<string>, exclude: { keys?: Iterable<string>; eventId?: string | null } = {}): ClueAttribution {
    const keys = new Set([d.primary.id, ...d.events.map((e) => e.id), ...(exclude.keys ?? [])]);
    const eventId = exclude.eventId ?? d.eventId;
    const others = this.between(d.startsAt - LOOK_BEFORE, d.endsAt + LOOK_AFTER).filter((p) => !keys.has(p.key) && !(eventId && p.eventId === eventId));
    const self: Plan = {
      key: d.primary.id,
      eventId: d.eventId,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      days,
      night: localDate(d.startsAt - 5 * HOUR, this.timeZone),
      kinds: kindWordsOf(d.title, d.eventTitle),
      hosted: hostedBy(this.db, d.eventId),
      series: d.primary.series,
      standing: isStanding(d),
      people: planPeople(this.db, this.people, d, isStanding(d)),
    };
    return new ClueAttribution(self, others);
  }
}

/** Could the plan be what a message sent at `at` refers to, the way this clue reads messages (messages.ts windows)? */
function reaches(p: Plan, type: SignalType, at: number, days: ReadonlySet<string>): boolean {
  if (AFTER_CLUES.has(type)) return at > p.startsAt + HOUR && at <= p.endsAt + 36 * HOUR;
  if (type === 'photos_dm') return at >= p.startsAt && at <= p.endsAt + 12 * HOUR;
  if (LOGISTICS_CLUES.has(type)) return Math.abs(at - p.startsAt) <= 3 * HOUR;
  if (DAY_CLUES.has(type)) return at <= p.endsAt && [...p.days].some((x) => days.has(x));
  return false;
}

/** The plan is on the night or day an after-message points back to (true when it doesn't say). */
const pointsTo = (p: Plan, s: TimedSignal) => (s.night ? p.night === s.night : s.day ? p.days.has(s.day) : true);

/** How far a message is from a plan's time span (0 while it is on). */
const distance = (p: Plan, at: number) => (at < p.startsAt ? p.startsAt - at : at > p.endsAt ? at - p.endsAt : 0);

/** The other plan explains the message at least as well as this occasion does. */
function atLeastAsClose(p: Plan, self: Plan, type: SignalType, at: number): boolean {
  if (AFTER_CLUES.has(type) || type === 'photos_dm') return p.endsAt >= self.endsAt;
  if (LOGISTICS_CLUES.has(type)) return distance(p, at) <= distance(self, at);
  return true;
}

export class ClueAttribution {
  constructor(
    readonly self: Plan,
    private readonly others: readonly Plan[],
  ) {}

  /**
   * One clue's weight for this occasion (0 = it belongs to another plan). `wroteAbout`: the person has a clue about
   * this occasion itself, so its timing clues aren't shared with the other plans.
   */
  weigh(personId: string, s: TimedSignal, wroteAbout = false): number {
    const at = s.at;
    if (at === undefined) return s.weight;
    if (ABOUT_CLUES.has(s.type)) {
      if (!this.self.series) return s.weight;
      const mine = distance(this.self, at);
      return this.others.some((p) => p.series === this.self.series && distance(p, at) < mine) ? 0 : s.weight;
    }
    if (!TIMED_CLUES.has(s.type)) return s.weight;
    if (!pointsTo(this.self, s)) return 0;
    if (this.self.people.has(personId)) return s.weight;
    let rivals = this.others.filter((p) => reaches(p, s.type, at, this.self.days) && pointsTo(p, s));
    const kinds = (s.kinds ?? []).filter((k) => this.self.kinds.has(k));
    if (kinds.length) rivals = rivals.filter((p) => p.people.has(personId) || kinds.some((k) => p.kinds.has(k)));
    else if (s.kinds?.length && rivals.some((p) => s.kinds!.some((k) => p.kinds.has(k)))) return 0;
    if (rivals.some((p) => p.people.has(personId))) return 0;
    if (this.self.standing && rivals.some((p) => !p.standing)) return 0;
    if (wroteAbout || s.night || s.day) return s.weight;
    const closer = rivals.filter((p) => atLeastAsClose(p, this.self, s.type, at) && (this.self.standing || !p.standing) && (!this.self.hosted || p.hosted));
    return s.weight / (1 + closer.length);
  }

  /** The person's clues with attribution applied (dropped ones removed); `at` is stripped. */
  attribute(personId: string, signals: readonly TimedSignal[]): Signal[] {
    const wroteAbout = signals.some((s) => ABOUT_CLUES.has(s.type) && this.weigh(personId, s) > 0);
    // A standing listing needs a message about it before the timing of other messages means anything.
    const timedOk = wroteAbout || !this.self.standing || this.self.people.has(personId);
    const out: Signal[] = [];
    for (const s of signals) {
      if (!timedOk && TIMED_CLUES.has(s.type)) continue;
      const weight = this.weigh(personId, s, wroteAbout);
      if (weight <= 0) continue;
      out.push({ type: s.type, weight, ...(s.m ? { m: s.m } : {}), ...(s.ref ? { ref: s.ref } : {}) });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------- stored occasions

/**
 * A stored occasion that is one week of a recurring listing: every calendar copy is a recurring instance on a
 * calendar other than the owner's own, with no invitees, and no Partiful event is linked (isStanding, from the DB).
 */
export function isStandingOccasion(db: DB, occasionId: string): boolean {
  const own = [...primaryCalendars(db)];
  const r = db
    .prepare(
      `SELECT o.event_id IS NULL AS unlinked,
              count(ce.id) AS copies,
              sum(ce.recurring_event_id IS NOT NULL AND ce.calendar_id NOT IN (SELECT value FROM json_each(@own))
                  AND coalesce(json_array_length(ce.attendees), 0) = 0) AS listed
       FROM occasions o
       LEFT JOIN occasion_sources s ON s.occasion_id = o.id AND s.source = 'calendar'
       LEFT JOIN calendar_events ce ON ce.id = s.source_ref
       WHERE o.id = @id GROUP BY o.id`,
    )
    .get({ id: occasionId, own: JSON.stringify(own) }) as { unlinked: number; copies: number; listed: number } | undefined;
  return !!r && r.unlinked === 1 && r.copies > 0 && r.listed === r.copies;
}

export interface NearbyPlan {
  title: string | null;
  startsAt: number;
  endsAt: number;
  standing: boolean;
}

/**
 * The owner's other plans from 6 h before an occasion to 36 h after it (the reach of its after-messages): live
 * timed occasions that aren't errands, appointments, lodging or travel, and Partiful events he went to that no
 * occasion covers. For the adjudicator, so a "thanks for coming" can be read against them.
 */
export function plansNear(db: DB, occasionId: string, limit = 8): NearbyPlan[] {
  const occ = db.prepare('SELECT starts_at, ends_at, event_id FROM occasions WHERE id = ?').get(occasionId) as
    { starts_at: number; ends_at: number | null; event_id: string | null } | undefined;
  if (!occ) return [];
  const from = occ.starts_at - 6 * HOUR;
  const to = (occ.ends_at ?? occ.starts_at) + 36 * HOUR;
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT o.id, o.title, o.starts_at, coalesce(o.ends_at, o.starts_at + 7200000) AS ends_at, 1 AS occasion
         FROM occasions o
         WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.all_day = 0 AND o.sensitive = 0
           AND o.kind NOT IN ('logistics', 'appointment', 'lodging', 'travel')
           AND o.id NOT IN (SELECT value FROM json_each(@chain)) AND o.starts_at BETWEEN @from AND @to
           AND coalesce(o.ends_at, o.starts_at) - o.starts_at <= @day
         UNION ALL
         SELECT e.id, e.title, e.starts_at, coalesce(e.ends_at, e.starts_at + 10800000), 0
         FROM events e
         WHERE e.source = 'partiful' AND e.starts_at BETWEEN @from AND @to AND ${OWNER_WENT} AND e.id IS NOT @event
           AND NOT EXISTS (SELECT 1 FROM occasions x WHERE x.event_id = e.id AND x.merged_into_id IS NULL AND x.status = 'active')
       ) ORDER BY starts_at, id LIMIT @limit`,
    )
    .all({ chain: JSON.stringify(occasionChain(db, occasionId)), from, to, day: DAY, event: occ.event_id, limit }) as {
    id: string;
    title: string | null;
    starts_at: number;
    ends_at: number;
    occasion: number;
  }[];
  return rows.map((r) => ({ title: r.title, startsAt: r.starts_at, endsAt: r.ends_at, standing: r.occasion === 1 && isStandingOccasion(db, r.id) }));
}
