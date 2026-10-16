/**
 * Per-calendar treatment (PLAN "Google Calendar" table): how events from each calendar count.
 *   attending  his own calendar (Personal / primary) or the Partiful feed: an event there means he went
 *   candidate  shared community calendars: an occasion only when messages or an RSVP corroborate it
 *   classify   included, then classified (e.g. "Recurring Events")
 *   excluded   never synced (holidays, birthdays and other Google-generated calendars)
 * Defaults come from calendarList on every sync; the owner's choice is a journaled settings row and wins.
 */
import type { DB } from '../../db/connection';

export const TREATMENTS = ['attending', 'candidate', 'classify', 'excluded'] as const;
export type Treatment = (typeof TREATMENTS)[number];

export type CalendarKind =
  | 'primary'
  | 'personal'
  | 'partiful_feed'
  | 'holiday'
  | 'google_virtual'
  | 'shared'
  | 'subscribed'
  | 'owned'
  | 'unavailable';

export interface CalendarDefaults {
  kind: CalendarKind;
  treatment: Treatment;
  partifulLinked: boolean;
}

export interface CalendarIdentity {
  id: string;
  summary?: string | null;
  summaryOverride?: string | null;
  accessRole?: string | null;
  primary?: boolean | null;
}

/** Subscribed iCal feeds (the Partiful feed is one of these). */
const IMPORT_SUFFIX = '@import.calendar.google.com';
/** Google-generated calendars: holidays ("…#holiday@…"), birthdays, week numbers. */
const VIRTUAL_SUFFIX = '@group.v.calendar.google.com';

const names = (c: CalendarIdentity) => [c.summary, c.summaryOverride].filter((s): s is string => !!s).map((s) => s.trim().toLowerCase());

export function defaultTreatment(c: CalendarIdentity): CalendarDefaults {
  const id = c.id.toLowerCase();
  const role = c.accessRole ?? 'reader';
  const own = role === 'owner' || role === 'writer';
  if (c.primary) return { kind: 'primary', treatment: 'attending', partifulLinked: false };
  if (id.endsWith(VIRTUAL_SUFFIX)) {
    return { kind: id.includes('#holiday') ? 'holiday' : 'google_virtual', treatment: 'excluded', partifulLinked: false };
  }
  if (id.endsWith(IMPORT_SUFFIX)) {
    return names(c).some((n) => n.includes('partiful'))
      ? { kind: 'partiful_feed', treatment: 'attending', partifulLinked: true }
      : { kind: 'subscribed', treatment: 'classify', partifulLinked: false };
  }
  // Free/busy access carries no titles or notes: nothing to infer from.
  if (role === 'freeBusyReader') return { kind: 'unavailable', treatment: 'excluded', partifulLinked: false };
  if (own && names(c).includes('personal')) return { kind: 'personal', treatment: 'attending', partifulLinked: false };
  // Someone else's calendar or a community calendar shared with him: its events aren't his plans by default.
  if (role !== 'owner') return { kind: 'shared', treatment: 'candidate', partifulLinked: false };
  return { kind: 'owned', treatment: 'classify', partifulLinked: false };
}

export const TREATMENT_SETTING_PREFIX = 'gcal.calendar:';
export const treatmentSettingKey = (calendarId: string) => `${TREATMENT_SETTING_PREFIX}${calendarId}`;

/** The stored setting value (JSON in settings.value). A missing field follows the default. */
export interface TreatmentSetting {
  treatment?: Treatment;
  partifulLinked?: boolean;
}

export interface EffectiveTreatment {
  calendar_id: string;
  kind: CalendarKind;
  is_primary: number;
  removed_at: number | null;
  default_treatment: Treatment;
  treatment: Treatment;
  partiful_linked: number;
  user_set: number;
}

export function effectiveTreatments(db: DB): EffectiveTreatment[] {
  return db.prepare('SELECT * FROM gcal_calendar_treatment ORDER BY is_primary DESC, calendar_id').all() as EffectiveTreatment[];
}
