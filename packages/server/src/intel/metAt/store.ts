/**
 * person_met_at reads and the owner's "Wrong" (design docs/design/tickets-met-at.md §2, [met] amendments). What
 * other modules import (event_invite, routes, the person page):
 *   activeMetAtLinks     active links of visible canonical people (person_canon → person_visible, never the owner),
 *                        targets resolved to the surviving occasion (still active, social, non-sensitive; a Partiful
 *                        event not cancelled); one per (person, target), the strongest.
 *   metAtLinksForPerson  the same for one person's canonical set.
 *   rejectMetAtLinks     tombstones links to 'rejected' (journaled, in the caller's run): the sticky "Wrong" that the
 *                        nightly run never re-creates for that happening.
 *   screenshotPeople     visible canonical people with a linked contact screenshot (an IG profile showing ≥ 5k
 *                        followers is not contact info and doesn't count).
 * Happening keys: a link's target is 'o:<occasion>' or 'e:<Partiful event>'; matching spans the occasion's merge
 * chain and treats e:<id> and o:<occasion whose event_id = id> as the same happening.
 */
import type { DB } from '../../db/connection';
import { selfPeople } from '../../identity/self';
import { withBatch } from '../../journal/batch';
import { occasionChain, survivingOccasion } from '../../pipeline/occasions/build';
import { MET_AT } from './score';

export interface MetAtLink {
  id: string;
  /** Canonical, visible. */
  personId: string;
  /** The surviving occasion id for occasions. */
  target: { type: 'occasion' | 'event'; id: string };
  signal: string;
  signalAt: number;
  confidence: number;
  /** The person has a linked contact_screenshots row. */
  screenshot: boolean;
}

export interface MetAtRow {
  id: string;
  person_id: string;
  occasion_id: string | null;
  event_id: string | null;
  target_key: string;
  signal: string;
  signal_at: number;
  signals: string;
  confidence: number;
  status: 'active' | 'withdrawn' | 'rejected';
  source: 'inferred' | 'user';
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Every o:/e: key naming the happening a stored target points at (merge chain + Partiful link, both ways). */
export function targetKeys(db: DB, target: { occasion_id: string | null; event_id: string | null }): Set<string> {
  const keys = new Set<string>();
  const eventOf = db.prepare('SELECT event_id FROM occasions WHERE id = ?').pluck();
  const addOccasion = (id: string) => {
    const surv = survivingOccasion(db, id);
    keys.add(`o:${surv}`);
    for (const o of occasionChain(db, surv)) {
      const ev = eventOf.get(o) as string | null | undefined;
      if (ev) keys.add(`e:${ev}`);
    }
  };
  if (target.occasion_id) addOccasion(target.occasion_id);
  if (target.event_id) {
    keys.add(`e:${target.event_id}`);
    for (const o of db.prepare('SELECT id FROM occasions WHERE event_id = ?').pluck().all(target.event_id) as string[]) addOccasion(o);
  }
  return keys;
}

/** A canonical id's visible form, or null (hidden, merged into nobody visible, the owner, roster-only, …). */
const visibleCanonical = (db: DB, id: string): string | null =>
  (db.prepare('SELECT pv.id FROM person_canon pc JOIN person_visible pv ON pv.id = pc.canonical_id WHERE pc.person_id = ?').pluck().get(id) as
    | string
    | undefined) ?? null;

/** A contact_screenshots row `s` that counts as contact info: linked, and not an IG profile showing ≥ 5k followers. */
export const SHOT_SQL = `s.status = 'linked' AND CAST(coalesce(json_extract(s.found, '$.followers'), 0) AS REAL) < ${MET_AT.maxFollowers}`;

/** Canonical visible people with a linked contact screenshot (never the owner). */
export function screenshotPeople(db: DB): Set<string> {
  const self = selfPeople(db);
  const ids = db
    .prepare(
      `SELECT DISTINCT pv.id FROM contact_screenshots s JOIN person_canon pc ON pc.person_id = s.person_id JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE ${SHOT_SQL}`,
    )
    .pluck()
    .all() as string[];
  return new Set(ids.filter((id) => !self.has(id)));
}

/** Active links (≥ minConfidence), optionally for some people (any member id; matched canonically). */
export function activeMetAtLinks(db: DB, o: { minConfidence?: number; personIds?: readonly string[] } = {}): MetAtLink[] {
  let only: Set<string> | null = null;
  if (o.personIds) {
    only = new Set<string>();
    for (const id of o.personIds) {
      const c = visibleCanonical(db, id);
      if (c) only.add(c);
    }
    if (!only.size) return [];
  }
  const rows = db
    .prepare(
      `SELECT m.id, pc.canonical_id AS person_id, m.occasion_id, m.event_id, m.signal, m.signal_at, m.confidence
       FROM person_met_at m JOIN person_canon pc ON pc.person_id = m.person_id JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE m.status = 'active' AND m.confidence >= ?
       ORDER BY m.signal_at, m.id`,
    )
    .all(o.minConfidence ?? 0) as Pick<MetAtRow, 'id' | 'person_id' | 'occasion_id' | 'event_id' | 'signal' | 'signal_at' | 'confidence'>[];
  if (!rows.length) return [];
  const self = selfPeople(db);
  const shots = screenshotPeople(db);
  // Until the nightly pass withdraws them: never a link to an occasion that turned sensitive, excluded or
  // non-social, or to a Partiful event since cancelled.
  const occasionLive = db.prepare(`SELECT 1 FROM occasions WHERE id = ? AND status = 'active' AND is_social = 1 AND sensitive = 0`).pluck();
  const eventLive = db.prepare(`SELECT 1 FROM events WHERE id = ? AND lower(coalesce(status, '')) NOT LIKE '%cancel%'`).pluck();
  const best = new Map<string, MetAtLink>();
  for (const r of rows) {
    if (self.has(r.person_id) || (only && !only.has(r.person_id))) continue;
    let target: MetAtLink['target'];
    if (r.occasion_id) {
      const id = survivingOccasion(db, r.occasion_id);
      if (!occasionLive.get(id)) continue;
      target = { type: 'occasion', id };
    } else {
      if (!eventLive.get(r.event_id!)) continue;
      target = { type: 'event', id: r.event_id! };
    }
    const link: MetAtLink = {
      id: r.id,
      personId: r.person_id,
      target,
      signal: r.signal,
      signalAt: r.signal_at,
      confidence: r.confidence,
      screenshot: shots.has(r.person_id),
    };
    const k = `${r.person_id}|${target.type}|${target.id}`;
    const cur = best.get(k);
    if (!cur || link.confidence > cur.confidence) best.set(k, link);
  }
  return [...best.values()];
}

/** The person's active links (their canonical set); [] when the person isn't visible. */
export function metAtLinksForPerson(db: DB, personId: string): MetAtLink[] {
  return visibleCanonical(db, personId) ? activeMetAtLinks(db, { personIds: [personId] }) : [];
}

/**
 * The owner's "Wrong" (or an agent retraction on his behalf): each link becomes 'rejected', one journaled batch in
 * the caller's run. Returns how many changed (already-rejected or unknown ids are skipped).
 */
export function rejectMetAtLinks(db: DB, linkIds: readonly string[], o: { runId: string; actor: 'user' | 'agent'; now?: number }): number {
  const ids = [...new Set(linkIds)];
  if (!ids.length) return 0;
  const rows = ids
    .map((id) => db.prepare('SELECT id, person_id, status FROM person_met_at WHERE id = ?').get(id) as Pick<MetAtRow, 'id' | 'person_id' | 'status'> | undefined)
    .filter((r): r is Pick<MetAtRow, 'id' | 'person_id' | 'status'> => !!r && r.status !== 'rejected');
  if (!rows.length) return 0;
  const people = new Set(rows.map((r) => r.person_id));
  const subject = people.size === 1 ? (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(rows[0]!.person_id) as string | undefined) : undefined;
  const { result } = withBatch(
    db,
    {
      runId: o.runId,
      kind: 'met_at',
      title: rows.length === 1 ? 'Not where you met them' : `Not where you met them (${rows.length} links)`,
      subjectPersonId: subject ?? null,
      actor: o.actor,
    },
    (t) => rows.reduce((n, r) => n + (t.tombstone('person_met_at', { id: r.id }) ? 1 : 0), 0),
    { now: o.now },
  );
  return result;
}
