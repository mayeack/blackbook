/**
 * How each Google calendar counts (PLAN "Google Calendar → Calendars"):
 *   attending  personal calendars (and the calendar adapter's 'classify' ones): what is on them, he goes to
 *   feed       the subscribed Partiful feed: attending, and linked to the Partiful event
 *   candidate  shared community calendars: an occasion only once corroborated (Partiful RSVP or messages)
 *   excluded   holidays, birthdays, week numbers, removed calendars
 * The calendar adapter's gcal_calendar_treatment view is the source of truth (its defaults come from calendarList,
 * the owner's choice is a journaled 'gcal.calendar:<id>' setting). A calendar it hasn't listed falls back to its
 * id and events: Google's virtual calendars are excluded, an imported calendar whose events carry Partiful ids is
 * the feed, any other imported feed and a group calendar whose events the owner didn't create are candidates,
 * anything else is attending.
 */
import type { DB } from '../../db/connection';

export type CalendarTreatment = 'attending' | 'feed' | 'candidate' | 'excluded';

/** The owner's own email keys (identities of the 'me' person), lowercased. */
export function ownerEmails(db: DB): Set<string> {
  const rows = db
    .prepare(
      `SELECT lower(i.key) FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN people me ON me.id = pc.canonical_id AND me.kind = 'me'
       WHERE i.kind = 'email' AND i.status = 'active'`,
    )
    .pluck()
    .all() as string[];
  return new Set(rows);
}

const SYSTEM_CALENDAR = /@group\.v\.calendar\.google\.com$|^addressbook#/i;
const GROUP_CALENDAR = /@group\.calendar\.google\.com$/i;
const IMPORTED = /@import\.calendar\.google\.com$/i;

const hasRelation = (db: DB, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')`).get(name) !== undefined;

/** The calendar adapter's effective treatments (setting, else its default), when that adapter is installed. */
function adapterTreatments(db: DB): Map<string, CalendarTreatment> {
  const out = new Map<string, CalendarTreatment>();
  if (!hasRelation(db, 'gcal_calendar_treatment')) return out;
  const rows = db.prepare('SELECT calendar_id, treatment, partiful_linked, removed_at FROM gcal_calendar_treatment').all() as {
    calendar_id: string;
    treatment: string;
    partiful_linked: number | null;
    removed_at: number | null;
  }[];
  for (const r of rows) {
    const t: CalendarTreatment =
      r.removed_at !== null || r.treatment === 'excluded' ? 'excluded' : r.partiful_linked ? 'feed' : r.treatment === 'candidate' ? 'candidate' : 'attending';
    out.set(r.calendar_id, t);
  }
  return out;
}

interface CalendarStats {
  calendar_id: string;
  n: number;
  partiful: number;
  mine: number;
  other_creator: number;
}

const PLAIN_ADDRESS = /^[^@\s#]+@(?!(?:group|import|group\.v)\.calendar\.google\.com$)[^@\s]+\.[a-z]{2,}$/i;

/** Treatment of every calendar that has events in calendar_events. */
export function calendarTreatments(db: DB, known: Set<string> = ownerEmails(db)): Map<string, CalendarTreatment> {
  const set = adapterTreatments(db);
  const ids = db.prepare('SELECT DISTINCT calendar_id FROM calendar_events').pluck().all() as string[];
  // Without a known owner email, the primary calendar's id (a plain address) is the owner's.
  const me = known.size ? known : new Set(ids.filter((id) => PLAIN_ADDRESS.test(id)).map((id) => id.toLowerCase()));
  const stats = db
    .prepare(
      `SELECT calendar_id, count(*) AS n,
              sum(partiful_event_id IS NOT NULL OR ical_uid LIKE '%partiful%' OR description LIKE '%partiful.com/e/%') AS partiful,
              sum(lower(coalesce(creator_email, '')) IN (SELECT value FROM json_each(@me))) AS mine,
              sum(creator_email IS NOT NULL AND lower(creator_email) NOT IN (SELECT value FROM json_each(@me))) AS other_creator
       FROM calendar_events GROUP BY calendar_id`,
    )
    .all({ me: JSON.stringify([...me]) }) as CalendarStats[];
  const out = new Map<string, CalendarTreatment>();
  for (const s of stats) {
    const explicit = set.get(s.calendar_id);
    if (explicit) {
      out.set(s.calendar_id, explicit);
      continue;
    }
    const id = s.calendar_id;
    if (SYSTEM_CALENDAR.test(id)) out.set(id, 'excluded');
    else if (s.partiful * 2 >= s.n && (IMPORTED.test(id) || s.mine === 0)) out.set(id, 'feed');
    else if (me.has(id.toLowerCase()) || id === 'primary') out.set(id, 'attending');
    else if (IMPORTED.test(id)) out.set(id, 'candidate');
    else if (GROUP_CALENDAR.test(id) && s.mine === 0 && s.other_creator > 0) out.set(id, 'candidate');
    else out.set(id, 'attending');
  }
  return out;
}
