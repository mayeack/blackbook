/**
 * Google Calendar adapter (PLAN "Ingestion → Google Calendar"; adapters/calendar/**).
 *   - gcal_calendars (S): every calendar seen in calendarList, with the adapter's default treatment
 *     (adapters/calendar/treatment.ts), recomputed on each sync. The owner's choice is a journaled settings row
 *     'gcal.calendar:<calendar_id>' = {"treatment": …, "partifulLinked"?: bool}, so it is undoable and always wins.
 *   - gcal_calendar_treatment: the effective treatment per calendar (setting, else default).
 *   - calendar_events gains the columns attendee inference needs: Google's eventType ('fromGmail' marks Gmail
 *     reservations), the all-day dates (end exclusive, as Google sends them), the owner's own RSVP, and the
 *     original start of a moved recurring instance.
 *   - calendar_events_included: what the occasions pipeline reads (listed calendars that aren't excluded).
 * Sync tokens live in source_cursors (source 'gcal', scope 'cal:<calendar_id>'); the refresh token in secrets.
 */
export const sql = /* sql */ `
CREATE TABLE gcal_calendars (
  calendar_id TEXT PRIMARY KEY,
  summary TEXT,
  time_zone TEXT,
  access_role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  kind TEXT NOT NULL
    CHECK (kind IN ('primary','personal','partiful_feed','holiday','google_virtual','shared','subscribed','owned','unavailable')),
  default_treatment TEXT NOT NULL CHECK (default_treatment IN ('attending','candidate','classify','excluded')),
  default_partiful_linked INTEGER NOT NULL DEFAULT 0 CHECK (default_partiful_linked IN (0,1)),
  removed_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_listed_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE VIEW gcal_calendar_treatment AS
SELECT c.calendar_id, c.kind, c.is_primary, c.removed_at, c.default_treatment,
  coalesce(json_extract(s.value, '$.treatment'), c.default_treatment) AS treatment,
  coalesce(json_extract(s.value, '$.partifulLinked'), c.default_partiful_linked) AS partiful_linked,
  (s.key IS NOT NULL) AS user_set
FROM gcal_calendars c LEFT JOIN settings s ON s.key = 'gcal.calendar:' || c.calendar_id;

ALTER TABLE calendar_events ADD COLUMN event_type TEXT;
ALTER TABLE calendar_events ADD COLUMN start_date TEXT;
ALTER TABLE calendar_events ADD COLUMN end_date TEXT;
ALTER TABLE calendar_events ADD COLUMN self_response TEXT
  CHECK (self_response IN ('accepted','declined','tentative','needsAction'));
ALTER TABLE calendar_events ADD COLUMN original_start_at INTEGER;
CREATE INDEX cal_calendar_time ON calendar_events(calendar_id, starts_at);
CREATE INDEX cal_recurring ON calendar_events(calendar_id, recurring_event_id) WHERE recurring_event_id IS NOT NULL;

CREATE VIEW calendar_events_included AS
SELECT e.*, t.treatment AS treatment, t.partiful_linked AS partiful_linked
FROM calendar_events e JOIN gcal_calendar_treatment t ON t.calendar_id = e.calendar_id
WHERE t.treatment <> 'excluded' AND t.removed_at IS NULL;
`;
