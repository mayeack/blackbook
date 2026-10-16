/**
 * The nightly ties pass (job 'ties', after the graph and the occasions/Partiful/LLM stages have applied what they
 * found): for every canonical person (kind person, active/provisional), rebuild person_touch_days from interactions
 * (all sources, incl. Partiful events and calendar occasions) and 1:1 tapbacks, then person_stats (E/S/F/H, momentum,
 * reciprocity, T, state, fading severity) and the trailing weekly tie_stats_snapshot rows (stats.ts, touch.ts).
 *
 * All three tables are derived (D): plain writes, never journaled, recomputed from history on every pass (an undo
 * of an interaction or merge is reflected the next night). Writes are diffed (unchanged touch days and snapshots
 * aren't rewritten). The pass is a generator of small steps (a chunk of people each, its writes in one
 * transaction); runTiesAsync hands the event loop back every SLICE_MS so the 10 s iMessage tail and the API keep
 * running, and stops between steps on abort.
 *
 * Fading suppression (PLAN "Until WhatsApp and Instagram ingest are live"): a person with an active WhatsApp or
 * Instagram identity whose source hasn't had a successful pass in the last 3 days never becomes 'fading'
 * (person_stats.fading_suppressed = 1), so friends who text elsewhere aren't nagged about.
 */
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { settingsSnapshot, settingTimeZone, type SettingsSnapshot } from '../../settings/registry';
import { dayConverter, dayString, weekStart } from './days';
import { computeTie, decilePriors, gapSummary, weeklySeries, type GapSummary, type TieResult, type TieThresholds } from './stats';
import { touchDays, type ComputedTouchDay, type InteractionRow } from './touch';

const DAY = 86_400_000;
export const SLICE_MS = 25;
const CHUNK = 20;
/** A source counts as ingesting when it had a successful pass this recently. */
export const SOURCE_LIVE_MS = 3 * DAY;
const SNAPSHOT_KEEP_WEEKS = 104;

export const WHATSAPP_KINDS = ['whatsapp_jid', 'whatsapp_lid'] as const;
export const INSTAGRAM_KINDS = ['instagram_id', 'instagram_username', 'beeper_user'] as const;

export interface TiesRunOptions {
  now?: number;
  /** IANA zone for local days (default: the `tz` setting). */
  timeZone?: string;
  signal?: AbortSignal;
  sliceMs?: number;
}

export interface TiesRunStats {
  people: number;
  withStats: number;
  touchDaysWritten: number;
  touchDaysDeleted: number;
  statsDeleted: number;
  snapshotsWritten: number;
  suppressed: number;
  strong: number;
  steady: number;
  cooling: number;
  fading: number;
  dormant: number;
  new: number;
}

export interface TiesRunResult {
  stats: TiesRunStats;
  complete: boolean;
}

export function thresholdsFrom(s: SettingsSnapshot): TieThresholds {
  return {
    fadingMultiple: s['agent.fading_multiple'],
    fadingMinSilenceDays: s['agent.fading_min_silence_days'],
    fadingMinHistorical: s['agent.fading_min_historical'],
    fadingMinContactDays: s['agent.fading_min_contact_days'],
    priorityFadingMultiple: s['agent.priority_fading_multiple'],
    priorityMinSilenceDays: s['agent.priority_min_silence_days'],
    priorityMinHistorical: s['agent.priority_min_historical'],
    dormantDays: s['agent.dormant_days'],
  };
}

/** Whether `source` had a successful pass within SOURCE_LIVE_MS. */
export function sourceLive(db: DB, source: string, now: number): boolean {
  const ok = db.prepare('SELECT last_ok_at FROM source_health WHERE source = ?').pluck().get(source) as number | null | undefined;
  return ok != null && ok >= now - SOURCE_LIVE_MS;
}

function canonicalSet(db: DB, kinds: readonly string[]): Set<string> {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT pc.canonical_id FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
         WHERE i.status = 'active' AND i.kind IN (SELECT value FROM json_each(?))`,
      )
      .pluck()
      .all(JSON.stringify(kinds)) as string[],
  );
}

interface PersonRow {
  id: string;
  is_priority: number;
  created_at: number;
}

interface Loaded {
  days: ComputedTouchDay[];
  sessions365: { total: number; mine: number };
  hasMessageHistory: boolean;
  gaps: GapSummary;
}

/** Group size without the owner, per group conversation. */
function groupSizes(db: DB): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT c.id, c.member_count AS member_count,
              count(DISTINCT CASE WHEN p.kind = 'person' THEN p.id END) AS roster
       FROM conversations c
       LEFT JOIN conversation_members cm ON cm.conversation_id = c.id
       LEFT JOIN identities i ON i.id = cm.identity_id
       LEFT JOIN person_canon pc ON pc.person_id = i.person_id
       LEFT JOIN people p ON p.id = pc.canonical_id
       WHERE c.kind = 'group'
       GROUP BY c.id`,
    )
    .all() as { id: string; member_count: number | null; roster: number }[];
  return new Map(rows.map((r) => [r.id, Math.max(r.roster, (r.member_count ?? 0) - 1)]));
}

/** 1:1 tapback times per canonical counterpart. */
function dmReactions(db: DB): Map<string, number[]> {
  const counterpart = new Map<string, Set<string>>();
  for (const r of db
    .prepare(
      `SELECT cm.conversation_id AS conv, pc.canonical_id AS pid FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
       JOIN identities i ON i.id = cm.identity_id
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN people p ON p.id = pc.canonical_id
       WHERE p.kind = 'person'`,
    )
    .all() as { conv: string; pid: string }[]) {
    let s = counterpart.get(r.conv);
    if (!s) counterpart.set(r.conv, (s = new Set()));
    s.add(r.pid);
  }
  const out = new Map<string, number[]>();
  const rows = db
    .prepare(
      `SELECT m.conversation_id AS conv, r.at FROM message_reactions r
       JOIN messages m ON m.id = r.message_id
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
       WHERE r.removed = 0`,
    )
    .all() as { conv: string; at: number }[];
  for (const r of rows) {
    const s = counterpart.get(r.conv);
    if (!s || s.size !== 1) continue;
    const pid = [...s][0]!;
    let list = out.get(pid);
    if (!list) out.set(pid, (list = []));
    list.push(r.at);
  }
  return out;
}

function zero(): TiesRunStats {
  return {
    people: 0,
    withStats: 0,
    touchDaysWritten: 0,
    touchDaysDeleted: 0,
    statsDeleted: 0,
    snapshotsWritten: 0,
    suppressed: 0,
    strong: 0,
    steady: 0,
    cooling: 0,
    fading: 0,
    dormant: 0,
    new: 0,
  };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Drains the pass synchronously (tests, scripts). */
export function runTies(db: DB, o: TiesRunOptions = {}): TiesRunStats {
  const pass = tiesPass(db, o);
  for (;;) {
    const r = pass.next();
    if (r.done) return r.value.stats;
  }
}

/** The scheduler's entry point: the same pass, with the event loop given a turn every `sliceMs`. */
export async function runTiesAsync(db: DB, o: TiesRunOptions = {}): Promise<TiesRunResult> {
  const slice = o.sliceMs ?? SLICE_MS;
  const pass = tiesPass(db, o);
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

export function* tiesPass(db: DB, o: TiesRunOptions = {}): Generator<void, TiesRunResult> {
  const now = o.now ?? Date.now();
  const stats = zero();
  const aborted = () => o.signal?.aborted === true;
  if (aborted()) return { stats, complete: false };

  const settings = settingsSnapshot(db);
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const th = thresholdsFrom(settings);
  const dayOf = dayConverter(timeZone);
  const today = dayOf(now);

  const persons = db
    .prepare(
      `SELECT id, is_priority, created_at FROM people
       WHERE kind = 'person' AND status IN ('active','provisional') AND merged_into_id IS NULL ORDER BY id`,
    )
    .all() as PersonRow[];
  stats.people = persons.length;
  const sizes = groupSizes(db);
  const reactions = dmReactions(db);
  const seeds = new Map(
    (db.prepare('SELECT person_id, shared_event_count FROM partiful_person_shared_events').all() as { person_id: string; shared_event_count: number }[]).map(
      (r) => [r.person_id, r.shared_event_count],
    ),
  );
  const addressBook = canonicalSet(db, ['addressbook_id']);
  const waPeople = sourceLive(db, 'whatsapp', now) ? new Set<string>() : canonicalSet(db, WHATSAPP_KINDS);
  const igPeople = sourceLive(db, 'instagram', now) ? new Set<string>() : canonicalSet(db, INSTAGRAM_KINDS);
  yield;

  const interactionsOf = db.prepare(
    `SELECT i.kind, i.conversation_id, i.started_at, i.ended_at, i.msgs_from_me, i.msgs_from_them, i.initiated_by_me, i.units
     FROM person_canon pc JOIN interactions i ON i.person_id = pc.person_id
     WHERE pc.canonical_id = ? AND i.retracted_at IS NULL
     ORDER BY i.started_at`,
  );
  const existingDays = db.prepare('SELECT day, units, components FROM person_touch_days WHERE person_id = ?');
  const delDay = db.prepare('DELETE FROM person_touch_days WHERE person_id = ? AND day = ?');
  const putDay = db.prepare(
    `INSERT INTO person_touch_days (person_id, day, units, components) VALUES (?, ?, ?, ?)
     ON CONFLICT (person_id, day) DO UPDATE SET units = excluded.units, components = excluded.components`,
  );

  // ---------------------------------------------------------------- phase A: touch days
  const loaded = new Map<string, Loaded>();
  for (let i = 0; i < persons.length; i += CHUNK) {
    if (aborted()) return { stats, complete: false };
    const chunk = persons.slice(i, i + CHUNK);
    tx(db, () => {
      for (const p of chunk) {
        const rows = interactionsOf.all(p.id) as InteractionRow[];
        const t = touchDays(rows, { dayOf, groupSize: (c) => sizes.get(c), reactionTimes: reactions.get(p.id), now });
        const want = new Map(t.days.map((d) => [dayString(d.day), d]));
        for (const e of existingDays.all(p.id) as { day: string; units: number; components: string | null }[]) {
          const w = want.get(e.day);
          if (!w) {
            stats.touchDaysDeleted += delDay.run(p.id, e.day).changes;
            continue;
          }
          if (Math.abs(w.units - e.units) < 1e-9 && JSON.stringify(w.components) === e.components) want.delete(e.day);
        }
        for (const [day, d] of want) stats.touchDaysWritten += putDay.run(p.id, day, d.units, JSON.stringify(d.components)).changes;
        if (t.days.length || seeds.get(p.id)) loaded.set(p.id, { ...t, gaps: gapSummary(t.days, today) });
      }
    });
    yield;
  }

  // ---------------------------------------------------------------- phase B: volume-decile priors
  const prior = decilePriors(
    [...loaded.values()].filter((l) => l.gaps.median !== null).map((l) => ({ volume: l.gaps.contactDays365, median: l.gaps.median! })),
  );
  yield;

  // ---------------------------------------------------------------- phase C: stats + snapshots
  const putStats = db.prepare(
    `INSERT INTO person_stats (person_id, last_at, last_in_at, last_out_at, contact_days_365, n90, n365, median_gap_d, p75_gap_d,
       expected_gap_d, silence_d, fading_ratio, historical_strength, rate90, rate365, momentum, reciprocity, tie_strength, state,
       fading_suppressed, computed_at, i_start_share, fading_severity, contact_days_total, first_contact_at, cold_start)
     VALUES (@person_id, @last_at, @last_in_at, @last_out_at, @contact_days_365, @n90, @n365, @median_gap_d, @p75_gap_d,
       @expected_gap_d, @silence_d, @fading_ratio, @historical_strength, @rate90, @rate365, @momentum, @reciprocity, @tie_strength, @state,
       @fading_suppressed, @computed_at, @i_start_share, @fading_severity, @contact_days_total, @first_contact_at, @cold_start)
     ON CONFLICT (person_id) DO UPDATE SET last_at = excluded.last_at, last_in_at = excluded.last_in_at, last_out_at = excluded.last_out_at,
       contact_days_365 = excluded.contact_days_365, n90 = excluded.n90, n365 = excluded.n365, median_gap_d = excluded.median_gap_d,
       p75_gap_d = excluded.p75_gap_d, expected_gap_d = excluded.expected_gap_d, silence_d = excluded.silence_d,
       fading_ratio = excluded.fading_ratio, historical_strength = excluded.historical_strength, rate90 = excluded.rate90,
       rate365 = excluded.rate365, momentum = excluded.momentum, reciprocity = excluded.reciprocity, tie_strength = excluded.tie_strength,
       state = excluded.state, fading_suppressed = excluded.fading_suppressed, computed_at = excluded.computed_at,
       i_start_share = excluded.i_start_share, fading_severity = excluded.fading_severity, contact_days_total = excluded.contact_days_total,
       first_contact_at = excluded.first_contact_at, cold_start = excluded.cold_start`,
  );
  const putSnap = db.prepare(
    `INSERT INTO tie_stats_snapshot (person_id, week, tie_strength, units, historical_strength, state, computed_at)
     VALUES (@person_id, @week, @t, @units, @h, @state, @now)
     ON CONFLICT (person_id, week) DO UPDATE SET tie_strength = excluded.tie_strength, units = excluded.units,
       historical_strength = excluded.historical_strength, state = excluded.state, computed_at = excluded.computed_at
     WHERE tie_strength IS NOT excluded.tie_strength OR units IS NOT excluded.units
       OR historical_strength IS NOT excluded.historical_strength OR state IS NOT excluded.state`,
  );
  const ids = [...loaded.keys()];
  const byId = new Map(persons.map((p) => [p.id, p]));
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (aborted()) return { stats, complete: false };
    const chunk = ids.slice(i, i + CHUNK);
    tx(db, () => {
      for (const id of chunk) {
        const l = loaded.get(id)!;
        const p = byId.get(id)!;
        const res = computeTie(
          {
            today,
            days: l.days,
            sessions365: l.sessions365,
            priority: p.is_priority === 1,
            hasAddressBook: addressBook.has(id),
            hasMessageHistory: l.hasMessageHistory,
            partifulSharedEvents: seeds.get(id) ?? null,
            firstSeenDay: dayOf(p.created_at),
            suppressFading: waPeople.has(id) || igPeople.has(id),
          },
          l.gaps,
          prior(l.gaps.contactDays365),
          th,
        );
        putStats.run(statsRow(id, res, now));
        stats.withStats++;
        stats[res.state]++;
        if (res.fadingSuppressed) stats.suppressed++;
        const series = weeklySeries(l.days, today, res.reciprocity, weekStart);
        const current = weekStart(today);
        for (const s of series) {
          const isCurrent = s.week === current;
          if (!isCurrent && s.t === 0 && s.units === 0) continue; // nothing to draw
          stats.snapshotsWritten += putSnap.run({
            person_id: id,
            week: dayString(s.week),
            t: s.t,
            units: s.units,
            h: isCurrent ? res.historical : null,
            state: isCurrent ? res.state : null,
            now,
          }).changes;
        }
      }
    });
    yield;
  }

  // ---------------------------------------------------------------- phase D: people who left the set
  if (aborted()) return { stats, complete: false };
  tx(db, () => {
    const keep = JSON.stringify(ids);
    const everyone = JSON.stringify(persons.map((p) => p.id));
    stats.statsDeleted += db.prepare('DELETE FROM person_stats WHERE person_id NOT IN (SELECT value FROM json_each(?))').run(keep).changes;
    stats.touchDaysDeleted += db.prepare('DELETE FROM person_touch_days WHERE person_id NOT IN (SELECT value FROM json_each(?))').run(everyone).changes;
    db.prepare('DELETE FROM tie_stats_snapshot WHERE person_id NOT IN (SELECT value FROM json_each(?))').run(keep);
    db.prepare('DELETE FROM tie_stats_snapshot WHERE week < ?').run(dayString(weekStart(today) - 7 * SNAPSHOT_KEEP_WEEKS));
  });
  return { stats, complete: true };
}

function statsRow(id: string, r: TieResult, now: number): Record<string, unknown> {
  return {
    person_id: id,
    last_at: r.lastAt,
    last_in_at: r.lastInAt,
    last_out_at: r.lastOutAt,
    contact_days_365: r.contactDays365,
    n90: r.n90,
    n365: r.n365,
    median_gap_d: r.medianGap,
    p75_gap_d: r.p75Gap,
    expected_gap_d: r.expectedGap,
    silence_d: r.silence,
    fading_ratio: r.fadingRatio,
    historical_strength: r.historical,
    rate90: r.rate90,
    rate365: r.rate365,
    momentum: r.momentum,
    reciprocity: r.reciprocity,
    tie_strength: r.tieStrength,
    state: r.state,
    fading_suppressed: r.fadingSuppressed ? 1 : 0,
    computed_at: now,
    i_start_share: r.iStartShare,
    fading_severity: r.severity,
    contact_days_total: r.contactDaysTotal,
    first_contact_at: r.firstContactAt,
    cold_start: r.coldStart ? 1 : 0,
  };
}

