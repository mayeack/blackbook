/**
 * Settings logic (pure, unit-tested in test/settings.test.ts): per-key validation against the shared schema, the
 * cross-field rules the server also enforces, building one PATCH from a draft, mapping server issues back onto
 * fields, and the small formatters the sub-pages use.
 */
import { SettingsValues, type SettingKey, type SettingsPatch } from '@yb/shared/api';
import { isApiError } from '../../api/client';

export type Values = SettingsValues;
export type Draft = Partial<{ [K in SettingKey]: Values[K] }>;
export type FieldErrors = Partial<Record<SettingKey, string>>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The schema's numeric bounds (one source of truth: @yb/shared). */
export function numberBounds(key: SettingKey): { min: number | null; max: number | null; int: boolean } {
  const s = SettingsValues.shape[key] as unknown as { minValue?: number | null; maxValue?: number | null; isInt?: boolean };
  return { min: s.minValue ?? null, max: s.maxValue ?? null, int: Boolean(s.isInt) };
}

/** Friendly message for one value, or null when it is valid. */
export function validateField<K extends SettingKey>(key: K, value: unknown): string | null {
  const schema = SettingsValues.shape[key];
  const r = schema.safeParse(value);
  if (r.success) return null;
  const b = numberBounds(key);
  if (b.min != null && b.max != null) return `${b.int ? 'A whole number' : 'A number'} from ${b.min} to ${b.max}.`;
  if (key === 'digest.time' || key === 'digest.catch_up_until' || key === 'events.time') return 'A time like 08:00.';
  return r.error.issues[0]?.message ?? 'Not a valid value.';
}

/** `HH:MM` → minutes since midnight. */
const mins = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether `t` is in [start, end), a window that may wrap past midnight (22:00–07:00). Mirrors the server. */
export function inWindow(t: string, start: string, end: string): boolean {
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The rules that span keys (the server checks the same ones on the merged result). */
export function crossFieldErrors(v: Values): FieldErrors {
  const e: FieldErrors = {};
  if (v['digest.catch_up_until'] <= v['digest.time']) e['digest.catch_up_until'] = 'Must be later than the brief time.';
  if (v.quiet_hours.start === v.quiet_hours.end) e.quiet_hours = 'Start and end must differ.';
  else if (inWindow(v['digest.time'], v.quiet_hours.start, v.quiet_hours.end)) e['digest.time'] = 'Falls inside quiet hours.';
  return e;
}

/** Effective values: the server's, with the draft on top and resets back to their defaults. */
export function mergeDraft(server: Values, defaults: Values, draft: Draft, resets: ReadonlySet<SettingKey>): Values {
  const out = { ...server, ...draft } as Record<string, unknown>;
  for (const k of resets) out[k] = defaults[k];
  return out as Values;
}

/** Keys whose effective value would change. */
export function dirtyKeys(server: Values, draft: Draft, resets: ReadonlySet<SettingKey>, overridden: ReadonlySet<string>): SettingKey[] {
  const keys = new Set<SettingKey>();
  for (const [k, v] of Object.entries(draft) as [SettingKey, unknown][]) if (!resets.has(k) && !same(v, server[k])) keys.add(k);
  for (const k of resets) if (overridden.has(k)) keys.add(k);
  return [...keys];
}

/** One PATCH for the whole draft (one journal batch, undoable from Today); null when nothing changes. */
export function buildPatch(server: Values, draft: Draft, resets: ReadonlySet<SettingKey>, overridden: ReadonlySet<string>): SettingsPatch | null {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft) as [SettingKey, unknown][]) {
    if (resets.has(k) || same(v, server[k])) continue;
    values[k] = v;
  }
  const reset = [...resets].filter((k) => overridden.has(k));
  if (Object.keys(values).length === 0 && reset.length === 0) return null;
  return { values: values as SettingsPatch['values'], ...(reset.length ? { reset } : {}) };
}

/** A 400 from PATCH /settings → field errors (`[{key, message}]` from the registry, `[{path, message}]` from zod). */
export function serverFieldErrors(e: unknown): FieldErrors {
  if (!isApiError(e) || !Array.isArray(e.details)) return {};
  const out: FieldErrors = {};
  for (const raw of e.details as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const i = raw as { key?: unknown; path?: unknown; message?: unknown };
    const key = typeof i.key === 'string' ? i.key : typeof i.path === 'string' ? i.path.replace(/^values\./, '') : null;
    if (!key || !(key in SettingsValues.shape)) continue;
    const msg = typeof i.message === 'string' && i.message ? i.message : 'Not a valid value.';
    out[key as SettingKey] = msg[0]!.toUpperCase() + msg.slice(1) + (/[.!?]$/.test(msg) ? '' : '.');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- formatters

export const usd = (x: number) => `$${x.toFixed(x >= 100 ? 0 : 2)}`;

/** Spend: like usd, but amounts under a cent keep four decimals (Haiku-priced days are often < $0.01). */
export const spendUsd = (x: number) => (x > 0 && x < 0.01 ? `$${x.toFixed(4)}` : usd(x));

/** Share of a budget used, 0..1 (null without a budget). */
export const budgetShare = (spent: number, budget: number) => (budget > 0 ? Math.min(1, Math.max(0, spent / budget)) : null);

/** "8:00 AM" from `HH:MM` in the viewer's locale. */
export function hhmmLabel(t: string): string {
  const m = mins(t);
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Day name for events.weekday (0 = Sunday … 6 = Saturday) in the viewer's locale: "Monday". */
export const weekdayName = (day: number) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 0, 4 + day));

/** Wildcard chance as a percentage string ("20%"). */
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

/** Pause until a day: that local day's midnight + 1 day (`YYYY-MM-DD` input), or null when not in the future. */
export function pauseUntil(value: string, now = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return d.getTime() > now ? d.getTime() : null;
}

/** Light Intl-based time zone check (the server checks again). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Ids pasted into a list setting: trimmed, de-duplicated, order kept. */
export function addId(list: readonly string[], id: string): string[] {
  const v = id.trim();
  return v && !list.includes(v) ? [...list, v] : [...list];
}

/** LLM spend as the server reports it (environment.llmSpend, LlmSpend in @yb/shared api/settings.ts). */
export interface SpendView {
  todayUsd: number;
  monthUsd: number;
  backfillUsd: number;
  requestsToday: number | null;
  cacheHitRate: number | null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Reads spend from `environment.llmSpend` (or a bare LlmSpend object) when the server sends it; null otherwise, so the
 * Privacy page can say usage isn't reported instead of showing zeros.
 */
export function normalizeSpend(environment: unknown): SpendView | null {
  if (!environment || typeof environment !== 'object') return null;
  const env = environment as Record<string, unknown>;
  const raw = (env.llmSpend ?? env.spend ?? (num(env.todayUsd) != null ? env : null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;
  const today = num(raw.todayUsd);
  const month = num(raw.monthUsd);
  if (today == null || month == null) return null;
  const hit = num(raw.cacheHitRate);
  return {
    todayUsd: today,
    monthUsd: month,
    backfillUsd: num(raw.backfillUsd) ?? 0,
    requestsToday: num(raw.requestsToday),
    cacheHitRate: hit != null && hit >= 0 && hit <= 1 ? hit : null,
  };
}

// ---------------------------------------------------------------------------------------------- gmail

const SENDER_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Comma- or space-separated sender domains → the valid, lowercased, de-duplicated list (≤ 50). */
export function parseSenderDomains(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, '');
    if (d.length >= 3 && d.length <= 100 && SENDER_DOMAIN.test(d)) out.add(d);
  }
  return [...out].slice(0, 50);
}
