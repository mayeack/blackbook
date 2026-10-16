/**
 * Settings DTOs: GET /api/v1/settings and PATCH /api/v1/settings.
 *
 * Only the non-secret keys exposed to the web are listed here (the server registry in
 * packages/server/src/settings/registry.ts adds internal keys such as self_handles, and owns defaults, validation
 * and the journaled write). Keys are dotted strings; values are JSON. Numeric bounds here are the same ones the
 * server enforces.
 */
import { z } from 'zod';
import { HHMM, Ms } from './common';
import { SuggestionKind } from './suggestions';

export const QuietHours = z.object({ start: HHMM, end: HHMM });
export type QuietHours = z.infer<typeof QuietHours>;

/** An IANA time zone name ("America/Chicago"); the server checks it with Intl. */
export const TimeZoneName = z.string().min(1).max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/);

const usd = (max: number) => z.number().min(0).max(max);
const days = (min: number, max: number) => z.number().int().min(min).max(max);

/** Every web-visible setting, typed. */
export const SettingsValues = z.object({
  // ---- digest (PLAN "Digest"; delivery §3). Ships DISABLED: nothing is sent until the owner turns it on.
  'digest.enabled': z.boolean(),
  'digest.time': HHMM,
  /** A digest missed while the Mac was down still goes out before this time; later, Today only. */
  'digest.catch_up_until': HHMM,
  /** Default item cap (3–5); the adaptive cap moves within it when digest.adaptive_cap is on. */
  'digest.max_items': z.number().int().min(3).max(5),
  'digest.adaptive_cap': z.boolean(),
  /** Sunday weekly review (deferred: not requested; off). */
  'digest.weekly': z.boolean(),
  /** `pause` command / Settings pause: no digest until this time (null = not paused). */
  'digest.paused_until': Ms.nullable(),
  /** Quiet hours for anything not a direct reply to a command. */
  quiet_hours: QuietHours,
  /** Settings → Digest "Send test": off unless the owner explicitly allows it. */
  'delivery.allow_test_send': z.boolean(),

  // ---- push (PWA web push). Off until a device subscribes and the owner turns it on.
  'push.enabled': z.boolean(),
  /** First names in notification bodies (off: "Your brief is ready · 4 things"). */
  'push.names_in_notifications': z.boolean(),
  /** Generic "event in 3 h" push for same-day events with a brief. */
  'push.pre_event': z.boolean(),

  // ---- agent thresholds (intelligence §3). Learning never moves these; only the owner does.
  'agent.fading_multiple': z.number().min(1.5).max(6),
  'agent.fading_min_silence_days': days(7, 180),
  'agent.fading_min_historical': z.number().min(0).max(100),
  'agent.fading_min_contact_days': days(1, 60),
  'agent.priority_fading_multiple': z.number().min(1.2).max(6),
  'agent.priority_min_silence_days': days(3, 180),
  'agent.priority_min_historical': z.number().min(0).max(100),
  'agent.dormant_days': days(90, 1000),
  /** Base of the per-person ignore cooldown (7 d × 2^ignores, capped at 90 d). */
  'agent.ignore_cooldown_days': days(1, 30),

  // ---- self-learning ranker (PLAN "Suggestions, self-learning and wildcards")
  'learner.enabled': z.boolean(),
  /** Probability of a 🎲 wildcard per digest (never on two consecutive days). */
  'learner.wildcard_epsilon': z.number().min(0).max(0.5),
  /** "Never suggest <kind>" hard mutes (suggestion kinds). */
  'learner.muted_kinds': z.array(SuggestionKind).max(20),

  // ---- LLM (Claude Haiku 5.5 on every route by default). Inert without ANTHROPIC_API_KEY; at a budget cap LLM
  // stages are skipped.
  'llm.enabled': z.boolean(),
  'llm.daily_budget_usd': usd(100),
  'llm.monthly_budget_usd': usd(1000),
  /** One-time historical backfill allowance (separate from the steady-state caps). */
  'llm.backfill_budget_usd': usd(2000),
  /** Privacy → LLM exclusions: never sent to the model (people / conversations by id). */
  'llm.excluded_person_ids': z.array(z.string().min(1).max(64)).max(500),
  'llm.excluded_conversation_ids': z.array(z.string().min(1).max(64)).max(500),
  /**
   * Advanced: per-route model/effort overrides, route → {model?, effort?}. The server checks route names and that the
   * model is on its allowlist (Claude Haiku 5.5 / Sonnet 5.5; Opus is not selectable). {} = every route on its default.
   */
  'llm.route_overrides': z.record(
    z.string().regex(/^[a-z_]{1,32}$/),
    z.object({ model: z.string().min(1).max(64).optional(), effort: z.enum(['low', 'medium', 'high']).optional() }).strict(),
  ),

  // ---- features
  /** Two-way texting: commands from the self-thread. */
  'commands.enabled': z.boolean(),
  'intros.enabled': z.boolean(),
  /** Home city for travel intel (falls back to the owner's location fact); free text, matched to a metro. */
  'travel.home_city': z.string().min(1).max(80).nullable(),

  // ---- locale
  /** IANA zone for digests, day boundaries and LLM windows; defaults to the system zone. */
  tz: TimeZoneName,
});
export type SettingsValues = z.infer<typeof SettingsValues>;
export type SettingKey = keyof SettingsValues;

export const SETTING_KEYS = Object.keys(SettingsValues.shape) as SettingKey[];

export const SettingGroup = z.enum(['digest', 'push', 'agent', 'learner', 'llm', 'features', 'locale']);
export type SettingGroup = z.infer<typeof SettingGroup>;

export const SettingMeta = z.object({
  key: z.string(),
  group: SettingGroup,
  label: z.string(),
  description: z.string(),
  /** False for keys only the server changes (e.g. digest.paused_until is set by `pause`, still shown). */
  writable: z.boolean(),
  /** True when the stored value differs from the default. */
  overridden: z.boolean(),
  updatedAt: Ms.nullable(),
});
export type SettingMeta = z.infer<typeof SettingMeta>;

/** LLM spend from the server's ledger (USD; spent_date in the tz setting). Reported with or without an API key. */
export const LlmSpend = z.object({
  todayUsd: z.number(),
  monthUsd: z.number(),
  backfillUsd: z.number(),
  dailyBudgetUsd: z.number(),
  monthlyBudgetUsd: z.number(),
  backfillBudgetUsd: z.number(),
  requestsToday: z.number().int(),
  /** cache reads / all input tokens over the last 7 days; null without data. */
  cacheHitRate: z.number().nullable(),
});
export type LlmSpend = z.infer<typeof LlmSpend>;

/** GET /api/v1/settings */
export const SettingsResponse = z.object({
  values: SettingsValues,
  defaults: SettingsValues,
  meta: z.array(SettingMeta),
  /** Read-only facts the Settings screen shows next to the values. */
  environment: z.object({
    llmConfigured: z.boolean(),
    pushConfigured: z.boolean(),
    systemTimeZone: z.string(),
    /** Spend and cache hit rate (Privacy meters, the Sources pipeline card). */
    llmSpend: LlmSpend.optional(),
    /** The model the LLM routes run on ("Claude Haiku 5.5") and how many routes the owner overrode. */
    llmModel: z.object({ label: z.string(), overriddenRoutes: z.number().int().min(0) }).optional(),
  }),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/**
 * PATCH /api/v1/settings — any subset of values (a nullable key accepts null as a value), plus keys to reset to
 * their defaults. Unknown or server-only keys are a 400. One journal batch per PATCH.
 */
export const SettingsPatch = z.object({
  values: SettingsValues.partial().strict().default({}),
  /** Keys to reset to their defaults. */
  reset: z.array(z.string()).max(50).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** PATCH answer: the new effective values plus the journal batch (undoable from Today). */
export const SettingsPatchResult = z.object({
  batchId: z.string().nullable(),
  values: SettingsValues,
  changed: z.array(z.string()),
});
export type SettingsPatchResult = z.infer<typeof SettingsPatchResult>;

// ------------------------------------------------------------------------------------------------ privacy + data

/**
 * Settings → Privacy:
 *   GET    /api/v1/settings/do-not-merge          → DoNotMergeList   pairs the agent will never merge
 *   DELETE /api/v1/settings/do-not-merge/:a/:b    {} → BatchRef      allow merging again (journaled; undoable)
 *   GET    /api/v1/settings/my-identities         → MyIdentities     the owner's own handles (masked)
 * Settings → Data:
 *   GET    /api/v1/settings/export                → a JSON file (attachment) of the CRM data; never sent anywhere
 */
export const DoNotMergeSide = z.object({
  id: z.string(),
  /** A hidden person reads "Hidden contact" (hidden people are only named under Settings → Hidden). */
  displayName: z.string(),
  hidden: z.boolean(),
});
export type DoNotMergeSide = z.infer<typeof DoNotMergeSide>;

export const DoNotMergePair = z.object({
  a: DoNotMergeSide,
  b: DoNotMergeSide,
  /** 'undo' (a split or an undone merge), 'user', 'llm_different'. */
  source: z.string(),
  createdAt: Ms,
});
export type DoNotMergePair = z.infer<typeof DoNotMergePair>;

export const DoNotMergeList = z.object({ pairs: z.array(DoNotMergePair) });
export type DoNotMergeList = z.infer<typeof DoNotMergeList>;

export const MyIdentity = z.object({
  id: z.string(),
  kind: z.string(),
  source: z.string(),
  /** Masked (phones/emails) like Person → Linked accounts. */
  value: z.string(),
  masked: z.boolean(),
});
export type MyIdentity = z.infer<typeof MyIdentity>;

export const MyIdentities = z.object({
  personId: z.string().nullable(),
  identities: z.array(MyIdentity),
  /** settings.self_handles count (the iMessage self-thread handles; never shown). */
  selfHandleCount: z.number().int(),
});
export type MyIdentities = z.infer<typeof MyIdentities>;
