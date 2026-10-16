const DAY = 86_400_000;

/** "today", "yesterday", "5d ago", "3mo ago", "2y ago" (and "in 3d" for the future). */
export function relativeDay(ms: number, now = Date.now()): string {
  const days = Math.floor((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 0) return days === -1 ? 'tomorrow' : `in ${-days}d`;
  if (days < 60) return `${days}d ago`;
  if (days < 365 * 2) return `${Math.round(days / 30.4)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const sameYear = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear();

/** "Oct 14, 3:12 PM" (year added when it isn't this year). */
export function dateTime(ms: number, now = Date.now()): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear(ms, now) ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);
}

/** "Oct 14" / "Oct 14, 2024". */
export function date(ms: number, now = Date.now()): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(sameYear(ms, now) ? {} : { year: 'numeric' }) }).format(ms);
}

export const time = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms);

/** "Oct 14, 3:12 – 3:40 PM"-ish: start date-time, plus the end time when it's a different minute. */
export function span(start: number, end: number | null, now = Date.now()): string {
  const s = dateTime(start, now);
  if (end == null || end - start < 60_000) return s;
  if (startOfDay(start) === startOfDay(end)) return `${s} – ${time(end)}`;
  return `${s} – ${dateTime(end, now)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Up to two initials from a display name ("Alice Avery" → "AA", "cher" → "C"). */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]!][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Stable hue (0–359) for an id, for avatar colours. */
export function hueFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** "Engineer @ Acme" / "Acme" / "Engineer" / null. */
export function roleLine(jobTitle: string | null, company: string | null): string | null {
  if (jobTitle && company) return `${jobTitle} @ ${company}`;
  return company ?? jobTitle ?? null;
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;
