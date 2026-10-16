/**
 * Cadence-aware tie strength (intelligence §3), pure functions over one person's daily touch units.
 *
 *   contact day   U ≥ 0.3
 *   gaps g_i      between consecutive contact days in [today−365, today] (the open gap excluded)
 *   G, P75        median and 75th percentile of the gaps
 *   E             clamp(exp((n·ln G + k·ln E_prior)/(n+k)), 1, 120), k = 4 (shrunk towards the volume-decile prior)
 *   E_r           max(E, 0.5·P75, 7)
 *   S, F          silence = today − last contact day; fading ratio F = S / E_r
 *   H             100·(1 − e^(−V/30)), V = Σ U over [last contact − 365, last contact] (+ the Partiful seed for people
 *                 without message history: 5·min(3, sharedEventCount)); anchored at the last contact so silence
 *                 doesn't erode it
 *   rate_τ        Σ U·e^(−age/τ) / τ for τ = 90, 365;  m = log2((rate90 + 0.01) / (rate365 + 0.01))
 *   Rcp           1 − 2·|I_me − 0.5| over the 365-day 1:1 sessions (I_me = share the owner started)
 *   T             100·(1 − e^(−A/12))·(0.7 + 0.3·Rcp), A = Σ U·0.5^(age/60)
 * States (first match wins): no contact yet → new · S > dormant days → dormant · cold start → new · fading ·
 * cooling (H ≥ 50, m ≤ −1, F < fading multiple) · strong (T ≥ 70) · steady.
 */
export const CONTACT_UNITS = 0.3;
const SHRINK_K = 4;
const PRIOR_FALLBACK = 30;
const COOLING_MIN_H = 50;
const COOLING_MOMENTUM = -1;
const STRONG_T = 70;
const COLD_KNOWN_DAYS = 60;
const AB_FADING_AFTER_DAYS = 90;
export const SPARK_WEEKS = 26;

export type TieStateName = 'strong' | 'steady' | 'cooling' | 'fading' | 'dormant' | 'new';

export interface TouchDay {
  day: number;
  units: number;
  /** Whether a 1:1 message component counted that day. */
  dm: boolean;
  /** Latest timestamp of anything that day. */
  lastAt: number;
  /** Latest message from them / from me that day (null: none). */
  lastIn: number | null;
  lastOut: number | null;
}

export interface TieThresholds {
  fadingMultiple: number;
  fadingMinSilenceDays: number;
  fadingMinHistorical: number;
  fadingMinContactDays: number;
  priorityFadingMultiple: number;
  priorityMinSilenceDays: number;
  priorityMinHistorical: number;
  dormantDays: number;
}

export const DEFAULT_THRESHOLDS: TieThresholds = {
  fadingMultiple: 3,
  fadingMinSilenceDays: 21,
  fadingMinHistorical: 40,
  fadingMinContactDays: 6,
  priorityFadingMultiple: 2,
  priorityMinSilenceDays: 14,
  priorityMinHistorical: 15,
  dormantDays: 365,
};

export interface TieInputs {
  /** Today's local day number. */
  today: number;
  /** Touch days, ascending by day (any units > 0). */
  days: readonly TouchDay[];
  /** 1:1 sessions in the last 365 days, and how many the owner started. */
  sessions365: { total: number; mine: number };
  priority: boolean;
  hasAddressBook: boolean;
  /** Any 1:1 or group message interactions ever (the Partiful seed only applies without). */
  hasMessageHistory: boolean;
  partifulSharedEvents: number | null;
  /** Fallback "known since" when there are no touch days (people.created_at). */
  firstSeenDay: number;
  /** Known WhatsApp/Instagram identity whose source isn't ingesting yet. */
  suppressFading: boolean;
}

export interface GapSummary {
  gaps: number[];
  median: number | null;
  p75: number | null;
  contactDays365: number;
}

export interface TieResult {
  lastContactDay: number | null;
  lastAt: number | null;
  lastInAt: number | null;
  lastOutAt: number | null;
  contactDays365: number;
  n90: number;
  n365: number;
  contactDaysTotal: number;
  firstContactDay: number | null;
  /** A timestamp on the first contact day. */
  firstContactAt: number | null;
  medianGap: number | null;
  p75Gap: number | null;
  /** E: the person's usual gap (shrunk median, 1–120 d), for "usually every ~9d". */
  expectedGap: number | null;
  /** E_r = max(E, 0.5·P75, 7): the floor the fading ratio divides by. */
  expectedGapFloor: number | null;
  silence: number | null;
  fadingRatio: number | null;
  historical: number;
  rate90: number;
  rate365: number;
  momentum: number;
  reciprocity: number | null;
  iStartShare: number | null;
  tieStrength: number;
  state: TieStateName;
  coldStart: boolean;
  fadingSuppressed: boolean;
  /** (H/100)·min(1, log2(F)/3)·(1 + 0.5·priority), clamped to [0, 1]; null unless fading. */
  severity: number | null;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const isContact = (d: TouchDay) => d.units >= CONTACT_UNITS - 1e-9;

/** Gaps between consecutive contact days inside [today − 365, today]. */
export function gapSummary(days: readonly TouchDay[], today: number): GapSummary {
  const contact = days.filter((d) => isContact(d) && d.day >= today - 365 && d.day <= today).map((d) => d.day);
  const gaps: number[] = [];
  for (let i = 1; i < contact.length; i++) gaps.push(contact[i]! - contact[i - 1]!);
  const sorted = [...gaps].sort((a, b) => a - b);
  return { gaps, median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), contactDays365: contact.length };
}

/**
 * E_prior by volume decile: people with ≥1 gap are ranked by contact days and cut into ten equal buckets; a
 * bucket's prior is the median of its members' median gaps (fallback 30 days for buckets with < 5 people).
 */
export function decilePriors(entries: readonly { volume: number; median: number }[]): (volume: number) => number {
  const sorted = [...entries].sort((a, b) => a.volume - b.volume || a.median - b.median);
  if (sorted.length < 5) return () => PRIOR_FALLBACK;
  const buckets: { maxVolume: number; prior: number }[] = [];
  for (let b = 0; b < 10; b++) {
    const slice = sorted.slice(Math.floor((b * sorted.length) / 10), Math.floor(((b + 1) * sorted.length) / 10));
    if (!slice.length) continue;
    const medians = slice.map((e) => e.median).sort((x, y) => x - y);
    buckets.push({ maxVolume: slice[slice.length - 1]!.volume, prior: slice.length >= 5 ? quantile(medians, 0.5)! : PRIOR_FALLBACK });
  }
  return (volume: number) => (buckets.find((b) => volume <= b.maxVolume) ?? buckets[buckets.length - 1]!).prior;
}

export function expectedGap(n: number, median: number | null, prior: number): number {
  const p = Math.max(1, prior);
  if (!n || median === null) return Math.min(120, Math.max(1, p));
  const e = Math.exp((n * Math.log(Math.max(1, median)) + SHRINK_K * Math.log(p)) / (n + SHRINK_K));
  return Math.min(120, Math.max(1, e));
}

/** A = Σ U·0.5^(age/60) at day `at` (days after `at` ignored). */
export function decayedVolume(days: readonly TouchDay[], at: number): number {
  let a = 0;
  for (const d of days) {
    if (d.day > at) break;
    const age = at - d.day;
    if (age > 720) continue;
    a += d.units * 0.5 ** (age / 60);
  }
  return a;
}

export const tieFromVolume = (a: number, reciprocity: number | null) => 100 * (1 - Math.exp(-a / 12)) * (0.7 + 0.3 * (reciprocity ?? 0.5));

export function stateLabel(state: TieStateName | string | null): string | null {
  switch (state) {
    case 'strong':
      return 'Strong';
    case 'steady':
      return 'Steady';
    case 'cooling':
      return 'Cooling';
    case 'fading':
      return 'Fading';
    case 'dormant':
      return 'Dormant';
    case 'new':
      return 'New';
    default:
      return null;
  }
}

export function computeTie(inp: TieInputs, gaps: GapSummary, decilePrior: number, th: TieThresholds = DEFAULT_THRESHOLDS): TieResult {
  const { today, days } = inp;
  const contact = days.filter(isContact);
  const last = contact.length ? contact[contact.length - 1]! : null;
  const L = last?.day ?? null;
  const firstTouch = days.length ? days[0]!.day : null;
  const knownSince = Math.min(firstTouch ?? inp.firstSeenDay, inp.firstSeenDay);
  const knownDays = today - knownSince;
  const dmDays = days.filter((d) => d.dm).length;

  // cold start, with the address-book exception (E_prior = 30, fading possible after 90 days)
  let coldStart = contact.length < th.fadingMinContactDays || knownDays < COLD_KNOWN_DAYS;
  let prior = decilePrior;
  if (coldStart && inp.hasAddressBook && dmDays >= 1 && knownDays >= AB_FADING_AFTER_DAYS) {
    coldStart = false;
    prior = PRIOR_FALLBACK;
  }

  const n = gaps.gaps.length;
  const E = L === null ? null : expectedGap(n, gaps.median, prior);
  const Er = E === null ? null : Math.max(E, 0.5 * (gaps.p75 ?? 0), 7);
  const S = L === null ? null : today - L;
  const F = S === null || Er === null ? null : S / Er;

  let V = 0;
  if (L !== null) for (const d of days) if (d.day >= L - 365 && d.day <= L) V += d.units;
  if (!inp.hasMessageHistory && inp.partifulSharedEvents) V += 5 * Math.min(3, Math.max(0, inp.partifulSharedEvents));
  const H = 100 * (1 - Math.exp(-V / 30));

  let rate90 = 0;
  let rate365 = 0;
  for (const d of days) {
    const age = today - d.day;
    if (age < 0) continue;
    rate90 += d.units * Math.exp(-age / 90);
    rate365 += d.units * Math.exp(-age / 365);
  }
  rate90 /= 90;
  rate365 /= 365;
  const m = Math.log2((rate90 + 0.01) / (rate365 + 0.01));

  const iStart = inp.sessions365.total ? inp.sessions365.mine / inp.sessions365.total : null;
  const rcp = iStart === null ? null : 1 - 2 * Math.abs(iStart - 0.5);
  const T = tieFromVolume(decayedVolume(days, today), rcp);

  const priority = inp.priority;
  const fadingRule =
    S !== null &&
    F !== null &&
    (priority
      ? H >= th.priorityMinHistorical && F >= th.priorityFadingMultiple && S >= th.priorityMinSilenceDays
      : H >= th.fadingMinHistorical && gaps.contactDays365 >= th.fadingMinContactDays && F >= th.fadingMultiple && S >= th.fadingMinSilenceDays);

  let state: TieStateName;
  if (L === null) state = 'new';
  else if (S! > th.dormantDays) state = 'dormant';
  else if (coldStart) state = 'new';
  else if (fadingRule && !inp.suppressFading) state = 'fading';
  else if (H >= COOLING_MIN_H && m <= COOLING_MOMENTUM && (F ?? 0) < th.fadingMultiple) state = 'cooling';
  else if (T >= STRONG_T) state = 'strong';
  else state = 'steady';

  const severity =
    state === 'fading' && F !== null ? Math.min(1, Math.max(0, (H / 100) * Math.min(1, Math.log2(F) / 3) * (1 + 0.5 * (priority ? 1 : 0)))) : null;

  let lastIn: number | null = null;
  let lastOut: number | null = null;
  for (const d of days) {
    if (d.lastIn !== null && (lastIn === null || d.lastIn > lastIn)) lastIn = d.lastIn;
    if (d.lastOut !== null && (lastOut === null || d.lastOut > lastOut)) lastOut = d.lastOut;
  }

  return {
    lastContactDay: L,
    lastAt: last?.lastAt ?? null,
    lastInAt: lastIn,
    lastOutAt: lastOut,
    contactDays365: gaps.contactDays365,
    n90: contact.filter((d) => d.day >= today - 90 && d.day <= today).length,
    n365: gaps.contactDays365,
    contactDaysTotal: contact.length,
    firstContactDay: contact.length ? contact[0]!.day : null,
    firstContactAt: contact.length ? contact[0]!.lastAt : null,
    medianGap: gaps.median === null ? null : r4(gaps.median),
    p75Gap: gaps.p75 === null ? null : r4(gaps.p75),
    expectedGap: E === null ? null : r4(E),
    expectedGapFloor: Er === null ? null : r4(Er),
    silence: S,
    fadingRatio: F === null ? null : r4(F),
    historical: r2(H),
    rate90: r4(rate90),
    rate365: r4(rate365),
    momentum: r4(m),
    reciprocity: rcp === null ? null : r4(rcp),
    iStartShare: iStart === null ? null : r4(iStart),
    tieStrength: r2(T),
    state,
    coldStart,
    fadingSuppressed: inp.suppressFading,
    severity: severity === null ? null : r4(severity),
  };
}

/** Weekly sparkline points (Monday weeks) for the trailing `weeks` weeks up to today. */
export function weeklySeries(
  days: readonly TouchDay[],
  today: number,
  reciprocity: number | null,
  weekStartOf: (day: number) => number,
  weeks = SPARK_WEEKS,
): { week: number; units: number; t: number }[] {
  if (!days.length) return [];
  const first = days[0]!.day;
  const out: { week: number; units: number; t: number }[] = [];
  const thisWeek = weekStartOf(today);
  for (let w = weeks - 1; w >= 0; w--) {
    const ws = thisWeek - 7 * w;
    if (ws + 6 < first) continue;
    const end = Math.min(ws + 6, today);
    let units = 0;
    for (const d of days) if (d.day >= ws && d.day <= end) units += d.units;
    out.push({ week: ws, units: r4(units), t: r2(tieFromVolume(decayedVolume(days, end), reciprocity)) });
  }
  return out;
}
