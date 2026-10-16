/**
 * Event brief + trips screen logic (pure; unit-tested in test/intel.test.ts): date ranges, match reasons, the
 * attendee line ("talked 12d ago · strong tie") and loop lines for a brief.
 */
import type { BriefAttendee, OpenLoop, TripMatchReason } from '@yb/shared';
import { attendeeStatusLabel } from './labels';

const DAY = 86_400_000;

/** "Oct 20 – 24", "Oct 30 – Nov 2", "Dec 30, 2026 – Jan 3, 2027"; one day → "Oct 20". Dates are local YYYY-MM-DD. */
export function dayRange(startsOn: string, endsOn: string | null, today = new Date()): string {
  const parse = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, dd);
  };
  const a = parse(startsOn);
  const b = endsOn ? parse(endsOn) : a;
  const thisYear = today.getFullYear();
  const withYear = a.getFullYear() !== b.getFullYear() || a.getFullYear() !== thisYear;
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', o).format(d);
  const md: Intl.DateTimeFormatOptions = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' };
  if (!endsOn || startsOn === endsOn) return fmt(a, md);
  if (!withYear && a.getMonth() === b.getMonth()) return `${fmt(a, { month: 'short', day: 'numeric' })} – ${b.getDate()}`;
  return `${fmt(a, md)} – ${fmt(b, md)}`;
}

/** Days from today's local date to `startsOn` (negative = already started). */
export function daysUntil(startsOn: string, today = new Date()): number {
  const [y, m, d] = startsOn.split('-').map(Number) as [number, number, number];
  const start = Date.UTC(y, m - 1, d);
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((start - t) / DAY);
}

/** "in 5 days", "tomorrow", "today", "now" (ongoing), "" for past trips. */
export function whenLabel(startsOn: string, endsOn: string, today = new Date()): string {
  const n = daysUntil(startsOn, today);
  if (n > 1) return `in ${n} days`;
  if (n === 1) return 'tomorrow';
  if (n === 0) return 'today';
  return daysUntil(endsOn, today) >= 0 ? 'now' : '';
}

const REASONS: Record<TripMatchReason, string> = {
  location_current: 'Lives there',
  location_next: 'Moving there',
  travel_plan: 'Will be there too',
  addressbook: 'Address in Contacts',
  partiful: 'Partiful events there',
  legacy_location: 'Tagged with this place',
};
export const tripReasonLabel = (r: TripMatchReason | string) => REASONS[r as TripMatchReason] ?? r.replace(/_/g, ' ');

/** "Lives there · since Mar" — the server's detail often restates the reason ("lives there since Mar"): say it once. */
export function tripPersonLine(reason: TripMatchReason | string, detail: string | null): string {
  const label = tripReasonLabel(reason);
  const d = detail?.trim();
  if (!d) return label;
  if (d.toLowerCase().startsWith(label.toLowerCase())) return d.charAt(0).toUpperCase() + d.slice(1);
  return `${label} · ${d}`;
}

/** "talked today", "talked 12 days ago", "no messages yet". */
export function lastContactLine(at: number | null, now = Date.now()): string {
  if (at == null) return 'no messages yet';
  const d = Math.floor((now - at) / DAY);
  if (d <= 0) return 'talked today';
  if (d === 1) return 'talked yesterday';
  if (d < 60) return `talked ${d} days ago`;
  const m = Math.round(d / 30);
  if (m < 18) return `talked ${m} months ago`;
  return `talked ${Math.round(d / 365)} years ago`;
}

/** Tie strength T (0–100) in words. */
export function tieWord(t: number | null): string | null {
  if (t == null) return null;
  if (t >= 70) return 'close';
  if (t >= 45) return 'good friend';
  if (t >= 20) return 'know them';
  return 'acquaintance';
}

/** Attendance words, as on the event page. */
export const briefStatusLabel = (s: string) => attendeeStatusLabel(s);

/** The attendee's subtitle: status · last contact · tie. */
export function attendeeSubtitle(a: Pick<BriefAttendee, 'status' | 'lastContactAt' | 'tieStrength'>, now = Date.now()): string {
  return [briefStatusLabel(a.status), lastContactLine(a.lastContactAt, now), tieWord(a.tieStrength)].filter(Boolean).join(' · ');
}

/** One open loop as a short line ("↩ Asked you something", "✓ You promised: send the trail map"). */
export function loopLine(l: Pick<OpenLoop, 'type' | 'title' | 'owner'>): string {
  if (l.type === 'reply_debt') return `↩ ${l.title}`;
  const who = l.owner === 'them' ? 'They promised' : l.owner === 'both' ? 'Plan' : 'You promised';
  return `✓ ${who}: ${l.title}`;
}

/** Attendees ordered for the brief: those with open loops first, then by tie strength. */
export function orderAttendees<T extends Pick<BriefAttendee, 'openLoops' | 'tieStrength' | 'person'>>(xs: readonly T[]): T[] {
  return [...xs].sort(
    (a, b) =>
      Number(b.openLoops.length > 0) - Number(a.openLoops.length > 0) ||
      (b.tieStrength ?? -1) - (a.tieStrength ?? -1) ||
      a.person.displayName.localeCompare(b.person.displayName),
  );
}
