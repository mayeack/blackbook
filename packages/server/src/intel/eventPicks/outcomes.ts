/**
 * Which picks the owner went to (design docs/design/event-picks.md §6): the owner asked yeackbot to "regularly
 * check which events I'm going to" to refine the picks. Job 'event-picks-outcomes' (daily, and right before each
 * weekly run) moves every sent pick still 'picked':
 *
 *   → going (outcome_source):
 *       ticket     a ticket event (Gmail ticket mail) on the same local date that shares a performer, or whose title
 *                  is alike (sim ≥ PICK_MATCH.sim), or at the same venue;
 *       calendar   a calendar event on that date (not declined / cancelled) whose title names a performer, the
 *                  title's distinctive words, or the venue;
 *       partiful   a Partiful event he's going to that date with an alike title or the same venue;
 *   → passed     the date is over with none of those (date). A ticket or calendar entry that shows up within
 *                PICK_MATCH.lateDays after the night still turns it into going.
 * Picks the owner answered himself ('owner': going / not_for_me) are never changed here. Writes event_picks only.
 */
import { addDays, localDate } from '@yb/shared';
import type { DB } from '../../db/connection';
import { distinctiveTokens, venueKey } from '../../pipeline/occasions/text';
import { PARTIFUL_ATTENDING_SQL } from '../common';
import { features, performerKey, sharedPerformer, similarity, type EventFeatures } from '../similarity';

export const PICK_MATCH = {
  /** Title similarity (intel/similarity.ts) that counts as the same event on the same date. */
  sim: 0.5,
  /** Distinctive title words a calendar entry must share (when no performer or venue matches). */
  minSharedWords: 2,
  /** A night that passed is re-checked this many days after it (a late calendar entry or ticket mail). */
  lateDays: 3,
} as const;

interface OpenPick {
  id: string;
  title: string;
  performers: string;
  genres: string;
  category: string;
  venue: string;
  venue_key: string;
  local_date: string;
  status: string;
}

const jsonStrings = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const pickFeatures = (p: OpenPick): EventFeatures =>
  features({ category: p.category, performers: jsonStrings(p.performers), genres: jsonStrings(p.genres), venue: p.venue, venueKey: p.venue_key, titles: [p.title] });

/** Whether a calendar / Partiful title (and venue) on the pick's date is that pick. */
export function sameEvent(pick: EventFeatures, title: string | null, venue: string | null): boolean {
  if (!title?.trim()) return false;
  const other = features({ venue, titles: [title] });
  if (sharedPerformer(pick, other)) return true;
  if (pick.venueKey && other.venueKey && pick.venueKey === other.venueKey) return true;
  const pickWords = new Set(pick.titleTokens);
  const shared = distinctiveTokens([title], [], 12).filter((w) => pickWords.has(w)).length;
  if (shared >= PICK_MATCH.minSharedWords) return true;
  // The pick's venue named in the entry's title ("Sample Band at Example Hall").
  if (pick.venueKey && pick.venueKey.length >= 4 && ` ${performerKey(title)} `.includes(` ${pick.venueKey} `)) return true;
  return false;
}

export interface OutcomeCounts {
  checked: number;
  going: number;
  passed: number;
}

export function updatePickOutcomes(db: DB, now: number, timeZone: string): OutcomeCounts {
  const today = localDate(now, timeZone);
  const open = db
    .prepare(
      `SELECT id, title, performers, genres, category, venue, venue_key, local_date, status FROM event_picks
       WHERE ordinal IS NOT NULL AND (status = 'picked' OR (status = 'passed' AND outcome_source = 'date' AND local_date >= ?))`,
    )
    .all(addDays(today, -PICK_MATCH.lateDays)) as OpenPick[];
  const counts: OutcomeCounts = { checked: open.length, going: 0, passed: 0 };
  if (!open.length) return counts;
  const tickets = db.prepare(
    `SELECT title, performers, genres, category, venue, venue_key FROM ticket_events
     WHERE merged_into_id IS NULL AND status IN ('holding','unconfirmed','gave_away') AND local_date = ?`,
  );
  const calendar = db.prepare(
    `SELECT summary, location, starts_at, start_date FROM calendar_events_included
     WHERE status <> 'cancelled' AND coalesce(self_response, '') <> 'declined'
       AND ((all_day = 0 AND starts_at >= @from AND starts_at < @to) OR (all_day = 1 AND start_date = @date))`,
  );
  const partiful = db.prepare(`SELECT e.title, e.location_text, e.starts_at FROM events e WHERE e.source = 'partiful' AND ${PARTIFUL_ATTENDING_SQL} AND e.starts_at >= @from AND e.starts_at < @to`);
  const setGoing = db.prepare(`UPDATE event_picks SET status = 'going', outcome_at = @now, outcome_source = @source, updated_at = @now WHERE id = @id AND status IN ('picked','passed')`);
  const setPassed = db.prepare(`UPDATE event_picks SET status = 'passed', outcome_at = @now, outcome_source = 'date', updated_at = @now WHERE id = @id AND status = 'picked'`);
  for (const p of open) {
    const f = pickFeatures(p);
    // The local day, ±12 h of slack for a zone guess on either side.
    const from = Date.parse(`${p.local_date}T00:00:00Z`) - 14 * 3_600_000;
    const to = Date.parse(`${addDays(p.local_date, 1)}T00:00:00Z`) + 14 * 3_600_000;
    let source: 'ticket' | 'calendar' | 'partiful' | null = null;
    for (const t of tickets.all(p.local_date) as { title: string; performers: string; genres: string; category: string; venue: string | null; venue_key: string | null }[]) {
      const tf = features({ category: t.category, performers: jsonStrings(t.performers), genres: jsonStrings(t.genres), venue: t.venue, venueKey: t.venue_key, titles: [t.title] });
      if (sharedPerformer(f, tf) || similarity(f, tf) >= PICK_MATCH.sim || (!!f.venueKey && f.venueKey === tf.venueKey)) {
        source = 'ticket';
        break;
      }
    }
    if (!source) {
      for (const c of calendar.all({ from, to, date: p.local_date }) as { summary: string | null; location: string | null; starts_at: number; start_date: string | null }[]) {
        if (c.start_date !== p.local_date && localDate(c.starts_at, timeZone) !== p.local_date) continue;
        if (sameEvent(f, c.summary, c.location)) {
          source = 'calendar';
          break;
        }
      }
    }
    if (!source) {
      for (const e of partiful.all({ from, to }) as { title: string | null; location_text: string | null; starts_at: number }[]) {
        if (localDate(e.starts_at, timeZone) !== p.local_date) continue;
        if (sameEvent(f, e.title, e.location_text) || (!!f.venueKey && f.venueKey === venueKey(e.location_text))) {
          source = 'partiful';
          break;
        }
      }
    }
    if (source) {
      setGoing.run({ id: p.id, now, source });
      counts.going++;
    } else if (p.status === 'picked' && p.local_date < today) {
      setPassed.run({ id: p.id, now });
      counts.passed++;
    }
  }
  return counts;
}
