/**
 * The full pre-event brief (GET /api/v1/events/:id/brief; intelligence §5 "Event intel"): for a social occasion
 * (a merged-away id answers with its survivor) or a Partiful event —
 *   attendees    every known attendee (going / maybe / possible …) ordered by tie strength, each with the last
 *                contact, open loops (reply debts, promises), and one recent non-sensitive fact;
 *   unknownGuests guest names with no matching person (roster-only Partiful guests, unresolved calendar names);
 *   connectors   known people with a "know each other" edge (≥ 0.4) to two or more attendees;
 *   followUp     the day-after follow-up's state.
 * Sensitive occasions and non-social kinds have no brief (null → 404). Deterministic: composer 'template'.
 * Hidden people never appear (person_visible), names in titles are redacted like the Events screen does.
 */
import type { BriefAttendee, EventBrief, OpenLoop, PersonChip } from '@yb/shared';
import type { DB } from '../db/connection';
import { openLoopsByPerson } from '../pipeline/obligations/loops';
import { survivingOccasion } from '../pipeline/occasions/build';
import { hiddenNameRedactor, maskText } from '../routes/people';
import { byTie } from './events';
import { knownAttendees, statsOf, unknownGuestNames, type KnownAttendee } from './common';

/** Edge strength for "knows" (the "know each other" tier). */
export const CONNECTOR_MIN_STRENGTH = 0.4;
const MAX_CONNECTORS = 5;
const FACT_TYPES = ['interest', 'activity_pref', 'food_drink', 'location_current', 'location_next', 'employer', 'role', 'school', 'job', 'travel_plan', 'pet', 'hometown'];

interface Target {
  type: 'occasion' | 'event';
  id: string;
  title: string | null;
  kind: string;
  startsAt: number;
  endsAt: number | null;
  venue: string | null;
  eventId: string | null;
}

/** The occasion or Partiful event behind an id, or null when it has no brief. */
export function briefTarget(db: DB, rawId: string): Target | null {
  const id = rawId.toLowerCase();
  if (db.prepare('SELECT 1 FROM occasions WHERE id = ?').get(id)) {
    const occ = db.prepare('SELECT * FROM occasions WHERE id = ?').get(survivingOccasion(db, id)) as {
      id: string;
      title: string | null;
      kind: string;
      starts_at: number;
      ends_at: number | null;
      venue_text: string | null;
      event_id: string | null;
      is_social: number | null;
      sensitive: number;
      status: string;
    };
    if (occ.sensitive === 1 || occ.is_social !== 1 || occ.kind !== 'social' || (occ.status !== 'active' && occ.status !== 'candidate')) return null;
    const redact = hiddenNameRedactor(db);
    return {
      type: 'occasion',
      id: occ.id,
      title: redact(occ.title),
      kind: occ.kind,
      startsAt: occ.starts_at,
      endsAt: occ.ends_at,
      venue: occ.venue_text && maskText(occ.venue_text),
      eventId: occ.event_id,
    };
  }
  const ev = db.prepare(`SELECT id, title, starts_at, ends_at, location_text FROM events WHERE id = ? AND source = 'partiful'`).get(id) as
    | { id: string; title: string | null; starts_at: number | null; ends_at: number | null; location_text: string | null }
    | undefined;
  if (!ev || ev.starts_at == null) return null;
  return {
    type: 'event',
    id: ev.id,
    title: ev.title && maskText(ev.title),
    kind: 'social',
    startsAt: ev.starts_at,
    endsAt: ev.ends_at,
    venue: ev.location_text && maskText(ev.location_text),
    eventId: null,
  };
}

function chips(db: DB, ids: readonly string[]): Map<string, PersonChip> {
  const out = new Map<string, PersonChip>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT pv.id, pv.display_name, pv.first_name, ps.state FROM person_visible pv LEFT JOIN person_stats ps ON ps.person_id = pv.id
       WHERE pv.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(ids)])) as { id: string; display_name: string; first_name: string | null; state: PersonChip['state'] }[];
  for (const r of rows) out.set(r.id, { id: r.id, displayName: maskText(r.display_name), firstName: r.first_name, state: r.state ?? null });
  return out;
}

/** One recent, non-sensitive, live fact about the person. */
export function recentFact(db: DB, personId: string, now: number): BriefAttendee['recentFact'] {
  const r = db
    .prepare(
      `SELECT f.id, f.type, f.value FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE pc.canonical_id = ? AND f.status IN ('tentative','confirmed') AND f.sensitive = 0 AND f.retracted_at IS NULL
         AND (f.valid_to IS NULL OR f.valid_to > ?) AND f.type IN (SELECT value FROM json_each(?))
       ORDER BY f.recorded_at DESC, f.id DESC LIMIT 1`,
    )
    .get(personId, now, JSON.stringify(FACT_TYPES)) as { id: string; type: string; value: string } | undefined;
  return r ? { id: r.id, type: r.type, value: maskText(r.value).slice(0, 200) } : null;
}

/** Known people who know ≥ 2 of the attendees (strength ≥ 0.4), most connected first. */
export function connectors(db: DB, attendeeIds: readonly string[]): { personId: string; knows: string[] }[] {
  if (attendeeIds.length < 2) return [];
  const set = new Set(attendeeIds);
  const json = JSON.stringify(attendeeIds);
  const rows = db
    .prepare(
      `SELECT a_id, b_id FROM edge_stats WHERE strength >= ? AND (a_id IN (SELECT value FROM json_each(?)) OR b_id IN (SELECT value FROM json_each(?)))`,
    )
    .all(CONNECTOR_MIN_STRENGTH, json, json) as { a_id: string; b_id: string }[];
  const knows = new Map<string, Set<string>>();
  const add = (x: string, attendee: string) => {
    if (x === attendee) return;
    knows.set(x, (knows.get(x) ?? new Set()).add(attendee));
  };
  for (const r of rows) {
    if (set.has(r.b_id)) add(r.a_id, r.b_id);
    if (set.has(r.a_id)) add(r.b_id, r.a_id);
  }
  const visible = db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck();
  return [...knows]
    .filter(([x, k]) => k.size >= 2 && !!visible.get(x))
    .map(([x, k]) => ({ personId: x, knows: [...k].sort(), t: statsOf(db, x).tie ?? 0 }))
    .sort((a, b) => b.knows.length - a.knows.length || b.t - a.t || (a.personId < b.personId ? -1 : 1))
    .slice(0, MAX_CONNECTORS)
    .map(({ personId, knows: k }) => ({ personId, knows: k }));
}

function followUpState(db: DB, t: Target, now: number): EventBrief['followUp'] {
  if ((t.endsAt ?? t.startsAt) > now) return { status: 'pending', suggestionId: null };
  const row = db
    .prepare(
      `SELECT id, status FROM suggestions WHERE kind = 'event_followup' AND ${t.type === 'occasion' ? 'occasion_id' : 'event_id'} = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(t.id) as { id: string; status: string } | undefined;
  if (!row) return { status: 'none', suggestionId: null };
  if (row.status === 'done') return { status: 'done', suggestionId: row.id };
  if (['candidate', 'selected', 'delivered', 'snoozed'].includes(row.status)) return { status: 'suggested', suggestionId: row.id };
  return { status: 'none', suggestionId: row.id };
}

/** The brief for an occasion / Partiful event id, or null (unknown, sensitive or not social). */
export function eventBrief(db: DB, rawId: string, o: { now: number; timeZone?: string }): EventBrief | null {
  const t = briefTarget(db, rawId);
  if (!t) return null;
  const all: KnownAttendee[] = byTie(db, knownAttendees(db, { type: t.type, id: t.id, eventId: t.eventId }));
  const ids = all.map((a) => a.personId);
  const conn = connectors(db, ids);
  const chipOf = chips(db, [...ids, ...conn.map((c) => c.personId)]);
  const loops: Map<string, OpenLoop[]> = ids.length ? openLoopsByPerson(db, ids, { now: o.now, ...(o.timeZone ? { timeZone: o.timeZone } : {}) }) : new Map();
  const attendees: BriefAttendee[] = [];
  for (const a of all) {
    const person = chipOf.get(a.personId);
    if (!person) continue;
    const s = statsOf(db, a.personId);
    attendees.push({
      person,
      tieStrength: s.tie,
      lastContactAt: s.lastAt,
      status: a.status,
      confidence: Math.round(a.confidence * 100) / 100,
      openLoops: (loops.get(a.personId) ?? []).slice(0, 5),
      recentFact: recentFact(db, a.personId, o.now),
    });
  }
  const redact = hiddenNameRedactor(db);
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    kind: t.kind,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    venue: t.venue,
    attendees,
    unknownGuests: unknownGuestNames(db, { type: t.type, id: t.id, eventId: t.eventId })
      .map((n) => redact(maskText(n)))
      .filter((n): n is string => !!n && !!n.trim()),
    connectors: conn
      .map((c) => ({ person: chipOf.get(c.personId)!, knows: c.knows.map((k) => chipOf.get(k)).filter((x): x is PersonChip => !!x) }))
      .filter((c) => !!c.person && c.knows.length >= 2),
    followUp: followUpState(db, t, o.now),
    composer: 'template',
    generatedAt: o.now,
  };
}
