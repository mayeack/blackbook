/**
 * 024 Partiful guest names (owner: adapters/partiful/guests.ts; read by intel/invites.ts).
 *
 *   partiful_guest_names (D)  guests on the lists of events I host who have no Partiful account (invited by SMS):
 *                             Partiful gives a name but no user, so they never become a person or an attendee row.
 *                             "Who to invite" checks candidates against these names so it never suggests someone
 *                             already invited. Rebuilt from each complete read of the list (a partial read only adds);
 *                             local only, never logged or sent.
 */
export const sql = /* sql */ `
CREATE TABLE partiful_guest_names (
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  status TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, name)
) STRICT, WITHOUT ROWID;
`;
