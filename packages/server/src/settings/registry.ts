/**
 * THE settings registry: every key the agent reads from the `settings` table, its type (zod), default, group and
 * whether the web may see/change it. Reads never throw (a missing or invalid stored value falls back to the
 * default); writes are validated and journaled (one change batch, kind 'setting', undoable from Today).
 *
 * Exposed keys and their value schemas come from @yb/shared (SettingsValues) so the web and server agree; this
 * file adds the defaults, the internal keys, and checks the shared bounds can't be bypassed (time zones are
 * checked with Intl, cross-field rules below).
 *
 * Not in the registry: dynamic per-entity keys other modules own (e.g. `gcal.calendar:<id>` in
 * adapters/calendar/treatment.ts). The registry never reads or writes those.
 *
 * Usage:
 *   const s = settingsSnapshot(db);          // every key, typed, defaults applied
 *   if (!s['digest.enabled']) return;
 *   readSetting(db, 'digest.time');           // one key
 *   writeSettings(db, { 'digest.time': '07:45' }, { actor: 'user' });
 */
import { z } from 'zod';
import { SettingsValues, SETTING_KEYS, type SettingGroup, type SettingKey, type SettingMeta } from '@yb/shared';
import type { DB } from '../db/connection';
import { withBatch, type Actor } from '../journal/batch';
import { withRun } from '../journal/runs';
import { DEFAULT_LOCAL_MODEL } from '../llm/local';
import { routeOverrideIssues } from '../llm/models';

// ---------------------------------------------------------------------------------------------- keys & types

/** Server-only keys: never returned by GET /settings, never changed by PATCH. */
const INTERNAL_SCHEMAS = {
  /** The owner's own iMessage handles (phone + Apple ID email), written by `npm run setup:self`. PII: never exposed. */
  self_handles: z.array(z.string().min(1).max(320)).max(10),
} as const;

export type InternalKey = keyof typeof INTERNAL_SCHEMAS;
export type AnySettingKey = SettingKey | InternalKey;
export type SettingsSnapshot = SettingsValues & { [K in InternalKey]: z.infer<(typeof INTERNAL_SCHEMAS)[K]> };
export type SettingValue<K extends AnySettingKey> = SettingsSnapshot[K];

export const INTERNAL_KEYS = Object.keys(INTERNAL_SCHEMAS) as InternalKey[];
export const ALL_SETTING_KEYS: AnySettingKey[] = [...SETTING_KEYS, ...INTERNAL_KEYS];

interface Def<K extends AnySettingKey> {
  group: SettingGroup | 'internal';
  label: string;
  description: string;
  default: () => SettingValue<K>;
}

/** The system time zone (the Mac's), validated. */
export function systemTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(tz) ? tz : 'UTC';
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const v =
  <T>(x: T) =>
  () =>
    x;

const DEFS: { [K in AnySettingKey]: Def<K> } = {
  // ---- digest
  'digest.enabled': {
    group: 'digest',
    label: 'Daily brief',
    description: 'Send the morning brief to yourself over iMessage. Off until you turn it on.',
    default: v(false),
  },
  'digest.email': {
    group: 'digest',
    label: 'Email me the daily brief',
    description: 'Also send the brief to your own Gmail, from and to your address (once “Email me” is connected in Email & photos).',
    default: v(true),
  },
  'digest.time': { group: 'digest', label: 'Brief time', description: 'When the brief is sent (local time).', default: v('08:00') },
  'digest.catch_up_until': {
    group: 'digest',
    label: 'Catch-up until',
    description: 'If the Mac was down at brief time, still send until this time; later it only shows on Today.',
    default: v('11:00'),
  },
  'digest.max_items': { group: 'digest', label: 'Items per brief', description: 'Most items in one brief (3–5).', default: v(4) },
  'digest.adaptive_cap': {
    group: 'digest',
    label: 'Adapt the item count',
    description: 'Drop to 3 items when later items are rarely acted on, rise to 5 when they often are.',
    default: v(true),
  },
  'digest.weekly': { group: 'digest', label: 'Weekly review', description: 'A Sunday review (not built yet).', default: v(false) },
  'digest.paused_until': {
    group: 'digest',
    label: 'Paused until',
    description: 'No brief until this time (set by "pause", cleared by "resume").',
    default: v(null),
  },
  quiet_hours: {
    group: 'digest',
    label: 'Quiet hours',
    description: 'Nothing is sent in this window except direct replies to your own commands.',
    default: () => ({ start: '22:00', end: '07:00' }),
  },
  'delivery.allow_test_send': {
    group: 'digest',
    label: 'Allow test sends',
    description: 'Lets "Send test to me" text your own handle. Off by default.',
    default: v(false),
  },
  // ---- push
  'push.enabled': { group: 'push', label: 'Push notifications', description: 'Ping subscribed devices when the brief is ready.', default: v(false) },
  'push.names_in_notifications': {
    group: 'push',
    label: 'First names in notifications',
    description: 'Show first names on the lock screen. Off: "Your brief is ready · 4 things".',
    default: v(false),
  },
  'push.pre_event': {
    group: 'push',
    label: 'Event reminders',
    description: 'A generic push 3 hours before a same-day event that has a brief.',
    default: v(true),
  },
  // ---- agent thresholds (intelligence §3)
  'agent.fading_multiple': {
    group: 'agent',
    label: 'Fading multiple',
    description: 'Someone is fading when the silence is this many times their usual gap.',
    default: v(3),
  },
  'agent.fading_min_silence_days': { group: 'agent', label: 'Minimum silence (days)', description: 'Never "fading" before this many quiet days.', default: v(21) },
  'agent.fading_min_historical': {
    group: 'agent',
    label: 'Minimum history (0–100)',
    description: 'How strong the relationship must have been before fading counts.',
    default: v(40),
  },
  'agent.fading_min_contact_days': {
    group: 'agent',
    label: 'Minimum contact days',
    description: 'Days in touch over the past year before cadence states apply.',
    default: v(6),
  },
  'agent.priority_fading_multiple': { group: 'agent', label: 'Priority: fading multiple', description: 'The fading multiple for priority people.', default: v(2) },
  'agent.priority_min_silence_days': { group: 'agent', label: 'Priority: minimum silence (days)', description: 'Minimum quiet days for priority people.', default: v(14) },
  'agent.priority_min_historical': { group: 'agent', label: 'Priority: minimum history', description: 'Minimum history score for priority people.', default: v(15) },
  'agent.dormant_days': { group: 'agent', label: 'Dormant after (days)', description: 'Silence after which someone counts as dormant.', default: v(365) },
  'agent.ignore_cooldown_days': {
    group: 'agent',
    label: 'Ignore cooldown (days)',
    description: 'Someone you keep ignoring rests this long, doubling each time (capped at 90 days).',
    default: v(7),
  },
  // ---- learner
  'learner.enabled': { group: 'learner', label: 'Learn from feedback', description: 'Rank suggestions by what you act on.', default: v(true) },
  'learner.wildcard_epsilon': {
    group: 'learner',
    label: 'Wildcard chance',
    description: 'Chance of one 🎲 wildcard per brief (never two days in a row).',
    default: v(0.2),
  },
  'learner.muted_kinds': { group: 'learner', label: 'Muted kinds', description: 'Suggestion kinds you asked never to see.', default: () => [] },
  // ---- llm
  'llm.enabled': {
    group: 'llm',
    label: 'Use Claude',
    description: 'Extraction, digest copy, Ask and briefs use Claude Haiku 5.5, the cheapest model (pseudonymized, prompt-cached). Inert without an API key.',
    default: v(true),
  },
  'llm.daily_budget_usd': { group: 'llm', label: 'Daily budget (USD)', description: 'LLM stages are skipped once today’s spend reaches this.', default: v(1) },
  'llm.monthly_budget_usd': { group: 'llm', label: 'Monthly budget (USD)', description: 'LLM stages are skipped once this month’s spend reaches this.', default: v(10) },
  'llm.backfill_budget_usd': {
    group: 'llm',
    label: 'Backfill allowance (USD)',
    description: 'One-time allowance for the historical backfill, separate from the steady-state caps.',
    default: v(20),
  },
  'llm.excluded_person_ids': { group: 'llm', label: 'Excluded people', description: 'Never sent to the model.', default: () => [] },
  'llm.excluded_conversation_ids': { group: 'llm', label: 'Excluded conversations', description: 'Never sent to the model.', default: () => [] },
  'llm.local_enabled': {
    group: 'llm',
    label: 'Read commands on this Mac first',
    description: 'A local model (Ollama) works out what your "yb …" texts mean before Claude sees them; Claude only steps in when it is unsure or unavailable. Nothing leaves the Mac for those.',
    default: v(true),
  },
  'llm.local_model': {
    group: 'llm',
    label: 'Local model',
    description: 'The Ollama model that reads your texts. Pull it first: ollama pull llama3.1:8b.',
    default: v(DEFAULT_LOCAL_MODEL),
  },
  'llm.route_overrides': {
    group: 'llm',
    label: 'Model per route',
    description: 'Advanced: run one LLM route on another allowed model (Claude Haiku 5.5 or Sonnet 5.5) or effort. Empty = every route on Haiku 5.5 at low effort.',
    default: () => ({}),
  },
  // ---- features
  'commands.enabled': {
    group: 'features',
    label: 'Text commands',
    description: 'Reply to the brief from your self-thread ("done 2", "log: …", "? …").',
    default: v(true),
  },
  'commands.read_images': {
    group: 'features',
    label: 'Read screenshots in commands',
    description: 'A screenshot you send with a "yb …" command (e.g. an Instagram profile) goes to Claude, downscaled, so it can tell who you mean.',
    default: v(true),
  },
  'intros.enabled': { group: 'features', label: 'Intro suggestions', description: 'Suggest introducing two people (drafts only, never sent).', default: v(true) },
  'travel.home_city': {
    group: 'features',
    label: 'Home city',
    description: 'Used to spot trips; falls back to your own location fact.',
    default: v(null),
  },
  // ---- gmail (adapters/gmail)
  'gmail.backfill_days': {
    group: 'features',
    label: 'Ticket mail look-back (days)',
    description: 'How far back Gmail is read for ticket emails once connected (30–3650).',
    default: v(1095),
  },
  'gmail.extra_senders': {
    group: 'features',
    label: 'Extra ticket senders',
    description: 'Sender domains to treat as ticket vendors besides the built-in list.',
    default: () => [],
  },
  // ---- event picks (intel/eventPicks)
  'events.enabled': {
    group: 'features',
    label: 'Weekly event picks',
    description:
      'Each week, send me events I might like on nights my calendar is free, with ticket links: from the web, my event newsletters and my Recurring Events calendar (uses Claude web search, about $0.12 a week).',
    default: v(true),
  },
  'events.weekday': {
    group: 'features',
    label: 'Event picks day',
    description: 'Day the picks are sent (0 = Sunday … 6 = Saturday). Sent in the evening, they cover the next 7 nights.',
    default: v(0),
  },
  'events.time': { group: 'features', label: 'Event picks time', description: 'When the picks are sent (local time).', default: v('18:00') },
  'events.max_picks': { group: 'features', label: 'Events per free day', description: 'Most events for each free day (at least 3 when there are enough; 2–8).', default: v(5) },
  'events.city': {
    group: 'features',
    label: 'Event picks city',
    description: 'Where to look for events; empty = your home city.',
    default: v(null),
  },
  'events.max_searches': {
    group: 'features',
    label: 'Web searches per week',
    description: 'Most web searches the weekly picks may run (2–12, $0.01 each).',
    default: v(10),
  },
  'events.channel': {
    group: 'features',
    label: 'Send event picks by',
    description: 'Email to your Gmail (texts until “Email me” is connected in Email & photos), or texts.',
    default: v('email'),
  },
  'events.newsletters': {
    group: 'features',
    label: 'Read event newsletters',
    description: 'Look through the past week’s event newsletters in Gmail for events on your free nights.',
    default: v(true),
  },
  'events.listings': {
    group: 'features',
    label: 'Recurring Events calendar',
    description: 'Add the best recurring events on your Recurring Events calendar that fall on your free nights.',
    default: v(true),
  },
  // ---- locale
  tz: { group: 'locale', label: 'Time zone', description: 'Digest times, day boundaries and dates in briefs.', default: systemTimeZone },
  // ---- internal
  self_handles: { group: 'internal', label: 'Own handles', description: 'Set by npm run setup:self.', default: () => [] },
};

function schemaOf(key: AnySettingKey): z.ZodType {
  if (key in INTERNAL_SCHEMAS) return INTERNAL_SCHEMAS[key as InternalKey];
  const base = SettingsValues.shape[key as SettingKey] as z.ZodType;
  if (key === 'tz') return base.refine((tz) => typeof tz === 'string' && isValidTimeZone(tz), 'unknown time zone');
  // Route names and the model allowlist (llm/models.ts): a stored value naming any other model (Opus included) is
  // invalid, so reads fall back to the default and it can never be selected.
  if (key === 'llm.route_overrides') {
    return base.superRefine((val, ctx) => {
      for (const message of routeOverrideIssues(val)) ctx.addIssue({ code: 'custom', message });
    });
  }
  return base;
}

export const isSettingKey = (k: string): k is AnySettingKey => Object.hasOwn(DEFS, k);
export const isExposedSettingKey = (k: string): k is SettingKey => (SETTING_KEYS as string[]).includes(k);

export function settingDefault<K extends AnySettingKey>(key: K): SettingValue<K> {
  return DEFS[key].default() as SettingValue<K>;
}

export function settingDefaults(): SettingsValues {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, settingDefault(k)])) as SettingsValues;
}

// ---------------------------------------------------------------------------------------------- reads

interface StoredRow {
  key: string;
  value: string;
  updated_at: number;
}

/** Parses a stored JSON value; undefined when it is missing or no longer valid (callers use the default). */
function parseStored(key: AnySettingKey, raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schemaOf(key).safeParse(key === 'self_handles' ? normalizeSelfHandles(json) : json);
  return parsed.success ? parsed.data : undefined;
}

/** setup:self historically stored `[…]`; accept `{handles:[…]}` too (adapters/imessage/ingest.ts reads both). */
function normalizeSelfHandles(json: unknown): unknown {
  return json && typeof json === 'object' && !Array.isArray(json) && Array.isArray((json as { handles?: unknown }).handles)
    ? (json as { handles: unknown[] }).handles
    : json;
}

function storedRows(db: DB): Map<string, StoredRow> {
  const keys = ALL_SETTING_KEYS;
  const rows = db.prepare(`SELECT key, value, updated_at FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys) as StoredRow[];
  return new Map(rows.map((r) => [r.key, r]));
}

/** One setting, typed; the default when unset or invalid. Never throws. */
export function readSetting<K extends AnySettingKey>(db: DB, key: K): SettingValue<K> {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  const stored = parseStored(key, raw);
  return (stored === undefined ? settingDefault(key) : stored) as SettingValue<K>;
}

/** Every registry key (exposed + internal), typed, defaults applied. One query. */
export function settingsSnapshot(db: DB): SettingsSnapshot {
  const rows = storedRows(db);
  const out: Record<string, unknown> = {};
  for (const key of ALL_SETTING_KEYS) {
    const stored = parseStored(key, rows.get(key)?.value);
    out[key] = stored === undefined ? settingDefault(key) : stored;
  }
  return out as SettingsSnapshot;
}

/** The web-visible values (no internal keys). */
export function exposedSettings(db: DB): SettingsValues {
  const snap = settingsSnapshot(db);
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, snap[k]])) as SettingsValues;
}

/** The `tz` setting (validated), else the system zone. */
export function settingTimeZone(db: DB): string {
  return readSetting(db, 'tz');
}

/** Metadata rows for the Settings screen. */
export function settingsMeta(db: DB): SettingMeta[] {
  const rows = storedRows(db);
  return SETTING_KEYS.map((key) => {
    const def = DEFS[key];
    const row = rows.get(key);
    const stored = parseStored(key, row?.value);
    return {
      key,
      group: def.group as SettingGroup,
      label: def.label,
      description: def.description,
      writable: true,
      overridden: stored !== undefined && JSON.stringify(stored) !== JSON.stringify(settingDefault(key)),
      updatedAt: row?.updated_at ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------------------- writes

export interface SettingsIssue {
  key: string;
  message: string;
}

export class SettingsError extends Error {
  constructor(readonly issues: SettingsIssue[]) {
    super(`Invalid settings: ${issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`);
    this.name = 'SettingsError';
  }
}

/** Rules that span keys, checked on the merged result of a write. */
function crossFieldIssues(s: SettingsSnapshot): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  if (s['digest.catch_up_until'] <= s['digest.time']) {
    issues.push({ key: 'digest.catch_up_until', message: 'must be later than the brief time' });
  }
  if (s.quiet_hours.start === s.quiet_hours.end) issues.push({ key: 'quiet_hours', message: 'start and end must differ' });
  else if (inLocalWindow(s['digest.time'], s.quiet_hours.start, s.quiet_hours.end)) {
    issues.push({ key: 'digest.time', message: 'falls inside quiet hours' });
  }
  return issues;
}

/** Whether HH:MM `t` is in [start, end), a window that may wrap past midnight (22:00–07:00). */
export function inLocalWindow(t: string, start: string, end: string): boolean {
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export interface WriteSettingsOptions {
  actor: Actor;
  /** Keys to reset to their defaults (the stored row is removed). */
  reset?: readonly AnySettingKey[];
  /** Write into an existing run (else a new 'user' / 'system' run is opened). */
  runId?: string;
  /** Feed title; default "Changed <n> setting(s)". Never put personal data here. */
  title?: string;
  /** Internal keys (self_handles) may be written only by server code that asks for it explicitly. */
  allowInternal?: boolean;
  now?: number;
}

export interface WriteSettingsResult {
  batchId: string | null;
  changed: AnySettingKey[];
}

/**
 * Validates and writes settings in one journaled batch. Unknown keys, invalid values, internal keys (unless
 * allowInternal) and cross-field violations throw SettingsError before anything is written. Writing a value equal
 * to the stored one is a no-op; writing the default stores it (reset removes the row).
 */
export function writeSettings(db: DB, values: Partial<Record<string, unknown>>, options: WriteSettingsOptions): WriteSettingsResult {
  const issues: SettingsIssue[] = [];
  const parsed = new Map<AnySettingKey, unknown>();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!isSettingKey(key)) {
      issues.push({ key, message: 'unknown setting' });
      continue;
    }
    if (!isExposedSettingKey(key) && !options.allowInternal) {
      issues.push({ key, message: 'not changeable here' });
      continue;
    }
    const r = schemaOf(key).safeParse(value);
    if (!r.success) issues.push({ key, message: r.error.issues.map((i) => i.message).join(', ') });
    else parsed.set(key, r.data);
  }
  const reset = new Set<AnySettingKey>();
  for (const key of options.reset ?? []) {
    if (!isSettingKey(key)) issues.push({ key, message: 'unknown setting' });
    else if (!isExposedSettingKey(key) && !options.allowInternal) issues.push({ key, message: 'not changeable here' });
    else if (parsed.has(key)) issues.push({ key, message: 'both set and reset' });
    else reset.add(key);
  }
  if (issues.length) throw new SettingsError(issues);

  // Cross-field rules on the merged result, and the no-op check, before any run or batch is opened.
  const stored = storedRows(db);
  const merged = settingsSnapshot(db) as Record<string, unknown>;
  for (const [k, val] of parsed) merged[k] = val;
  for (const k of reset) merged[k] = settingDefault(k);
  const cross = crossFieldIssues(merged as SettingsSnapshot);
  if (cross.length) throw new SettingsError(cross);
  const toWrite = [...parsed].filter(([k, val]) => stored.get(k)?.value !== JSON.stringify(val));
  const toReset = [...reset].filter((k) => stored.has(k));
  if (!toWrite.length && !toReset.length) return { batchId: null, changed: [] };

  const now = options.now ?? Date.now();
  const n = toWrite.length + toReset.length;
  const run = (runId: string): WriteSettingsResult => {
    const { batchId, result, changes } = withBatch(
      db,
      { runId, kind: 'setting', title: options.title ?? `Changed ${n === 1 ? 'a setting' : `${n} settings`}`, actor: options.actor },
      (t) => {
        const changed: AnySettingKey[] = [];
        for (const [key, val] of toWrite) {
          const value = JSON.stringify(val);
          if (t.get('settings', { key })) {
            if (t.update('settings', { key }, { value })) changed.push(key);
          } else {
            t.insert('settings', { key, value });
            changed.push(key);
          }
        }
        for (const key of toReset) if (t.delete('settings', { key })) changed.push(key);
        return changed;
      },
      { now },
    );
    return { batchId: changes ? batchId : null, changed: result };
  };
  if (options.runId) return run(options.runId);
  return withRun(db, options.actor === 'user' ? 'user' : 'system', run, { now });
}

/** Convenience: one key. */
export function writeSetting<K extends AnySettingKey>(
  db: DB,
  key: K,
  value: SettingValue<K>,
  options: WriteSettingsOptions,
): WriteSettingsResult {
  return writeSettings(db, { [key]: value }, options);
}
