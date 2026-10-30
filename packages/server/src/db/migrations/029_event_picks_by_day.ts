/**
 * 029 event picks by day (owner, 2026-10-28, reviewing the weekly email: "Organize the email by day … Have 3-5 events
 * per day where it looks like I am free"; design docs/design/event-picks.md §5): a week can now carry up to
 * events.max_picks (≤ 8) picks on each of its 7 days, plus that day's Recurring Events listings, so a sent pick's
 * ordinal goes past 028's limit of 20. event_picks is rebuilt with ordinal BETWEEN 1 AND 60 (rows, indexes kept).
 */
import type { DB } from '../connection';
import { rebuildTable } from './023_party_invite';

export const sql = /* sql */ `-- event_picks.ordinal widened in up()`;

export const rebuildsTables = true;

export const ORDINAL_BEFORE = 'ordinal BETWEEN 1 AND 20';
export const ORDINAL_AFTER = 'ordinal BETWEEN 1 AND 60';

export function up(db: DB): void {
  const ddl = db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'event_picks'`).pluck().get() as string | undefined;
  if (!ddl) throw new Error('event_picks: no such table');
  if (!ddl.includes(ORDINAL_BEFORE)) return;
  rebuildTable(db, 'event_picks', ddl.replace(ORDINAL_BEFORE, ORDINAL_AFTER));
}
