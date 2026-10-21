/**
 * The `suggestions` table as the stage sees it: candidate validation, upsert by dedupe key (one live row per
 * subject: candidate | selected | delivered | snoozed), cooldown scopes and showing counts. Class (S) table:
 * plain writes, never journaled.
 */
import { SUGGESTION_KINDS, uuidv7, type SuggestionKind, type SuggestionStatus, type WildcardGenerator } from '@yb/shared';
import type { DB } from '../../db/connection';
import { canonAll, visibleSet } from './people';
import { KIND_POLICY, suggestionDedupeKey, type Candidate } from './types';

const DAY = 86_400_000;
export const LIVE_STATUSES: readonly SuggestionStatus[] = ['candidate', 'selected', 'delivered', 'snoozed'];
const LIVE_SQL = `('candidate','selected','delivered','snoozed')`;

export interface SuggestionRow {
  id: string;
  kind: SuggestionKind;
  wildcard_generator: WildcardGenerator | null;
  person_id: string | null;
  related_person_id: string | null;
  event_id: string | null;
  occasion_id: string | null;
  circle_id: string | null;
  commitment_id: string | null;
  reply_debt_id: string | null;
  trip_id: string | null;
  dedupe_key: string;
  base_score: number | null;
  score: number;
  learned_factors: string | null;
  signals: string;
  title: string | null;
  body: string | null;
  openers: string | null;
  sensitive: number;
  is_wildcard: number;
  status: SuggestionStatus;
  snoozed_until: number | null;
  cooldown_until: number | null;
  expires_at: number | null;
  run_id: string | null;
  delivered_at: number | null;
  acted_at: number | null;
  created_at: number;
  updated_at: number;
  subject_key: string | null;
  person_ids: string;
  evidence_ids: string;
  time_critical: number;
  rank_details: string | null;
  selected_at: number | null;
  digest_id: string | null;
  showings: number;
  last_seen_run: string | null;
  decided_at: number | null;
}

export function getSuggestion(db: DB, id: string): SuggestionRow | undefined {
  return db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined;
}

export const personIdsOf = (r: Pick<SuggestionRow, 'person_ids' | 'person_id' | 'related_person_id'>): string[] => {
  const ids = JSON.parse(r.person_ids) as string[];
  if (ids.length) return ids;
  return [r.person_id, r.related_person_id].filter((x): x is string => !!x);
};

const SCALAR = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Cleans a generator's candidate: known kind, non-empty subject, finite base clamped to [0, 1], canonical and
 * visible people (the primary must be visible; an intro pair needs both), bounded evidence ids, JSON-safe payload,
 * not already expired. Returns null to drop it. `self` (identity/self.ts selfPeople) are records of the owner:
 * never visible here, so an item about me is dropped and I am never listed as one of its people.
 */
export function normalizeCandidate(db: DB, c: Candidate, now: number, self: ReadonlySet<string> = new Set()): Candidate | null {
  if (!(SUGGESTION_KINDS as readonly string[]).includes(c.kind)) return null;
  if (typeof c.subjectKey !== 'string' || !c.subjectKey || c.subjectKey.length > 200) return null;
  if (typeof c.base !== 'number' || Number.isNaN(c.base)) return null;
  if (c.expiresAt !== null && c.expiresAt !== undefined && c.expiresAt <= now) return null;
  const ids = canonAll(db, (c.personIds ?? []).filter((x) => typeof x === 'string' && x));
  const visible = visibleSet(db, ids);
  for (const id of self) visible.delete(id);
  if (ids.length && !visible.has(ids[0]!)) return null;
  if (c.kind === 'intro' && ids.some((id) => !visible.has(id))) return null;
  const personIds = ids.filter((id) => visible.has(id));
  const payload: Candidate['payload'] = {};
  for (const [k, v] of Object.entries(c.payload ?? {})) {
    if (v === undefined) continue;
    if (SCALAR(v) || (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))) payload[k] = v as never;
  }
  const relatedRaw = c.links?.relatedPersonId ?? (c.kind === 'intro' ? personIds[1] : null) ?? null;
  const related = relatedRaw ? canonAll(db, [relatedRaw])[0]! : null;
  if (related && self.has(related) && c.kind === 'intro') return null;
  return {
    ...c,
    personIds,
    base: Math.min(1, Math.max(0, c.base)),
    evidenceIds: (c.evidenceIds ?? []).filter((e) => typeof e === 'string' && e.length <= 100).slice(0, 20),
    expiresAt: c.expiresAt ?? null,
    timeCritical: !!c.timeCritical,
    sensitive: !!c.sensitive,
    links: { ...(c.links ?? {}), relatedPersonId: related && visible.has(related) ? related : null },
    payload,
  };
}

export function liveRow(db: DB, dedupeKey: string): SuggestionRow | undefined {
  return db.prepare(`SELECT * FROM suggestions WHERE dedupe_key = ? AND status IN ${LIVE_SQL}`).get(dedupeKey) as SuggestionRow | undefined;
}

/**
 * Kinds whose row, once shown (selected, delivered, or still snoozed), keeps the people, payload, evidence and base it
 * was shown with: a later "Wrong" acts on what the owner saw (an event invite rejects the met-at links named in it:
 * intel/eventInvites.ts), never on people a later night picked. Links, expiry and the emitting run still refresh.
 */
const KEEP_SHOWN_KINDS: ReadonlySet<SuggestionKind> = new Set(['event_invite']);
const SHOWN_FIELDS: ReadonlySet<string> = new Set(['person_id', 'related_person_id', 'person_ids', 'signals', 'evidence_ids', 'base_score']);

/**
 * Inserts or refreshes the live row for a candidate (signals, base, links, expiry, the emitting run; for
 * KEEP_SHOWN_KINDS once shown, only links, expiry and the run). A snoozed row whose snooze has passed becomes a
 * candidate again. Returns the row id.
 */
export function upsertCandidate(db: DB, c: Candidate, runId: string, now: number): string {
  const key = suggestionDedupeKey(c);
  const live = liveRow(db, key);
  const links = c.links ?? {};
  const fields = {
    person_id: c.personIds[0] ?? null,
    related_person_id: links.relatedPersonId ?? null,
    event_id: links.eventId ?? null,
    occasion_id: links.occasionId ?? null,
    circle_id: links.circleId ?? null,
    commitment_id: links.commitmentId ?? null,
    reply_debt_id: links.replyDebtId ?? null,
    trip_id: links.tripId ?? null,
    base_score: c.base,
    signals: JSON.stringify(c.payload),
    sensitive: c.sensitive ? 1 : 0,
    expires_at: c.expiresAt,
    subject_key: c.subjectKey,
    person_ids: JSON.stringify(c.personIds),
    evidence_ids: JSON.stringify(c.evidenceIds),
    time_critical: c.timeCritical ? 1 : 0,
    last_seen_run: runId,
  };
  if (live) {
    const status = live.status === 'snoozed' && (live.snoozed_until ?? 0) <= now ? 'candidate' : live.status;
    const keep = KEEP_SHOWN_KINDS.has(c.kind) && status !== 'candidate';
    const cols = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => !keep || !SHOWN_FIELDS.has(k));
    db.prepare(`UPDATE suggestions SET ${cols.map((k) => `${k} = ?`).join(', ')}, status = ?, updated_at = ? WHERE id = ?`).run(
      ...cols.map((k) => fields[k]),
      status,
      now,
      live.id,
    );
    return live.id;
  }
  const id = uuidv7(now);
  insertRow(db, id, c, fields, 'candidate', now, runId);
  return id;
}

function insertRow(db: DB, id: string, c: Candidate, fields: Record<string, unknown>, status: SuggestionStatus, now: number, runId: string): void {
  const row: Record<string, unknown> = {
    id,
    kind: c.kind,
    dedupe_key: suggestionDedupeKey(c),
    score: c.base,
    status,
    run_id: runId,
    created_at: now,
    updated_at: now,
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO suggestions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k] as never));
}

/** Stores a 🎲 candidate that had no row yet (only the chosen wildcard is ever stored). */
export function insertWildcardRow(db: DB, id: string, c: Candidate, runId: string, now: number): void {
  const links = c.links ?? {};
  insertRow(
    db,
    id,
    c,
    {
      person_id: c.personIds[0] ?? null,
      related_person_id: links.relatedPersonId ?? null,
      event_id: links.eventId ?? null,
      occasion_id: links.occasionId ?? null,
      circle_id: links.circleId ?? null,
      commitment_id: links.commitmentId ?? null,
      reply_debt_id: links.replyDebtId ?? null,
      trip_id: links.tripId ?? null,
      base_score: c.base,
      signals: JSON.stringify(c.payload),
      sensitive: c.sensitive ? 1 : 0,
      expires_at: c.expiresAt,
      subject_key: c.subjectKey,
      person_ids: JSON.stringify(c.personIds),
      evidence_ids: JSON.stringify(c.evidenceIds),
      time_critical: c.timeCritical ? 1 : 0,
      last_seen_run: runId,
    },
    'candidate',
    now,
    runId,
  );
}

// ---------------------------------------------------------------------------------------------- cooldowns

export const pkScope = (personId: string, kind: SuggestionKind) => `pk:${personId}|${kind}`;
export const subjectScope = (dedupeKey: string) => `subject:${dedupeKey}`;

/** Days an intro keeps each of its two people out of further intros (the pair itself rests 30 days). */
export const INTRO_PERSON_COOLDOWN_DAYS = 7;

/**
 * The cooldown scopes a showing of `c` sets, with their length in days: per (person, kind) for person items (both
 * people of an intro, at 7 days, plus the pair at 30), per subject for circle-level items.
 */
export function showingScopes(c: Pick<Candidate, 'kind' | 'subjectKey' | 'personIds'>, multiplier = 1): { scope: string; days: number }[] {
  const days = KIND_POLICY[c.kind].cooldownDays;
  if (days === null) return [];
  const d = days * multiplier;
  if (c.kind === 'intro') {
    return [{ scope: subjectScope(suggestionDedupeKey(c)), days: d }, ...c.personIds.map((p) => ({ scope: pkScope(p, 'intro'), days: INTRO_PERSON_COOLDOWN_DAYS * multiplier }))];
  }
  if (c.personIds[0]) return [{ scope: pkScope(c.personIds[0], c.kind), days: d }];
  return [{ scope: subjectScope(suggestionDedupeKey(c)), days: d }];
}

/** Scopes that can block a candidate (what a showing sets, plus the per-subject scope for person items). */
export function blockingScopes(c: Pick<Candidate, 'kind' | 'subjectKey' | 'personIds'>): string[] {
  const out = new Set<string>([subjectScope(suggestionDedupeKey(c))]);
  if (c.kind === 'intro') for (const p of c.personIds) out.add(pkScope(p, 'intro'));
  else if (c.personIds[0]) out.add(pkScope(c.personIds[0], c.kind));
  return [...out];
}

export type CooldownReason = 'shown' | 'dismissed' | 'wrong' | 'fading_mute' | 'snoozed';

export function cooldownUntil(db: DB, scopes: readonly string[]): number | null {
  if (!scopes.length) return null;
  const v = db.prepare(`SELECT max(until) FROM suggestion_cooldowns WHERE scope IN (${scopes.map(() => '?').join(',')})`).pluck().get(...scopes) as
    | number
    | null;
  return v ?? null;
}

/** Sets a cooldown; with `extend` (default) it only ever lengthens an existing one. Returns the previous row. */
export function setCooldown(
  db: DB,
  scope: string,
  until: number,
  reason: CooldownReason,
  now: number,
  extend = true,
): { until: number; reason: CooldownReason } | null {
  const prev = db.prepare('SELECT until, reason FROM suggestion_cooldowns WHERE scope = ?').get(scope) as { until: number; reason: CooldownReason } | undefined;
  if (prev && extend && prev.until >= until) return prev;
  db.prepare(
    `INSERT INTO suggestion_cooldowns (scope, until, reason, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET until = excluded.until, reason = excluded.reason, updated_at = excluded.updated_at`,
  ).run(scope, until, reason, now);
  return prev ?? null;
}

export function restoreCooldown(db: DB, scope: string, prev: { until: number; reason: CooldownReason } | null, now: number): void {
  if (prev) setCooldown(db, scope, prev.until, prev.reason, now, false);
  else db.prepare('DELETE FROM suggestion_cooldowns WHERE scope = ?').run(scope);
}

export function pruneCooldowns(db: DB, now: number): number {
  return db.prepare('DELETE FROM suggestion_cooldowns WHERE until < ?').run(now - 30 * DAY).changes;
}

/** How many digests have carried this subject (all rows with the same dedupe key). */
export function showingsOf(db: DB, dedupeKey: string): number {
  return (db.prepare('SELECT coalesce(sum(showings), 0) FROM suggestions WHERE dedupe_key = ?').pluck().get(dedupeKey) as number) ?? 0;
}
