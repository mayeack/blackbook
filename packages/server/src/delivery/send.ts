/**
 * Digest delivery: one cheap decision per tick (every AGENT_TIMES.deliveryTickMs), per channel, for today's digest.
 *
 *   before settings digest.time ............ nothing
 *   no digest row 20 min after digest.time .. an empty 'skipped' row is written (the ranker found nothing / isn't
 *                                             coming); while today's 'suggestions' run is still pending it waits until
 *                                             catch-up instead, and a late ranking takes the placeholder over
 *   empty digest ............................ skipped; a pipeline failure sends one "Last night's run failed at …"
 *                                             line, else every 3rd consecutive empty day one heartbeat line
 *   catch-up passed (digest.catch_up_until)  skipped: Today only
 *   paused (digest.paused_until) ........... waits (a `resume` before catch-up still sends)
 *   iMessage: digest.enabled=false ......... 'disabled' (ships this way); quiet hours → waits; else the brief's texts
 *                                             go to the owner one by one (one per suggestion, then ≤1 health text),
 *                                             each with a stable client_ref, so a retry never double-sends. The digest
 *                                             counts as sent from its first delivered text (replies bind to it at once);
 *                                             until the rest settle it is 'partial' and its texts are frozen. The next
 *                                             tick resends from the top (sent parts are duplicates); a pause, turning the
 *                                             brief off, or catch-up passing closes it with what already went out, and so
 *                                             does the day ending.
 *   push: push.enabled + a VAPID sender + ≥1 device → "Your brief is ready · N things" once
 * A channel that can't go yet (collector down, quiet hours, circuit open) is retried next tick until catch-up passes.
 * The row's final status: 'sent' | 'fallback_sent' (LLM was configured but the copy fell back to templates) |
 * 'failed' | 'skipped' (with skip_reason). Critical-source alerts get one generic health push each.
 */
import { addDays, localParts, uuidv7, type ChannelDelivery, type PushPayload } from '@yb/shared';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import type { AgentServices } from '../services';
import { inLocalWindow, settingsSnapshot, type SettingsSnapshot } from '../settings/registry';
import { composeSelection, compositionCurrent, minimalText, partsAttempted, persistComposition, pushBodyFor, storedComposition, type ComposedDigest } from './compose';
import { pushDeviceCount, pushToDevices, type PushFanoutResult } from './push';
import { getDigestRow, readDigestSelection, type DigestRow, type DigestSelection, type SelectDigestItems } from './selection';
import { peopleAdded, pipelineFailure, SOURCE_LABELS } from './status';
import { BOT_MARKER, plural, SOURCES_LINK, stableUuid } from './text';
import type { OutboundResult, PushSender } from './types';

const MIN = 60_000;
const DAY = 86_400_000;
/** How long after digest.time a missing digest row is treated as "nothing today". */
export const MISSING_ROW_GRACE_MIN = 20;
/** Heartbeat every Nth consecutive empty day. */
export const HEARTBEAT_EVERY_DAYS = 3;

export interface DeliveryDeps {
  db: DB;
  services: Pick<AgentServices, 'llm' | 'egress' | 'outbound'>;
  push: PushSender;
  now?: () => number;
  log?: Logger;
  select?: SelectDigestItems;
  signal?: AbortSignal;
}

export type DeliveryAction =
  | 'before_time'
  | 'no_digest_yet'
  | 'final'
  | 'delivered'
  | 'waiting'
  | 'skipped'
  | 'notice_sent'
  | 'heartbeat_sent'
  | 'failed';

export interface DeliveryTickResult {
  action: DeliveryAction;
  localDate: string;
  reason?: string | null;
  imessage?: ChannelDelivery;
  push?: ChannelDelivery;
  pushed?: PushFanoutResult | null;
  /** Health + pre-event pushes sent this tick. */
  healthPushes?: number;
}

const FINAL_STATUSES = new Set(['sent', 'fallback_sent', 'failed', 'skipped']);

const addMinutes = (hhmm: string, m: number): string => {
  const [h, mm] = hhmm.split(':').map(Number) as [number, number];
  const t = Math.min(23 * 60 + 59, h * 60 + mm + m);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function updateRow(db: DB, id: string, patch: Partial<Record<keyof DigestRow, string | number | null>>): void {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.prepare(`UPDATE digests SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c as keyof DigestRow] ?? null), id);
}

function markDelivered(db: DB, suggestionIds: string[], now: number): void {
  const upd = db.prepare(
    `UPDATE suggestions SET status = CASE status WHEN 'selected' THEN 'delivered' ELSE status END, delivered_at = coalesce(delivered_at, ?), updated_at = ?
     WHERE id = ? AND status IN ('selected','delivered')`,
  );
  for (const id of suggestionIds) upd.run(now, now, id);
}

/** Consecutive empty days ending today (today counts; a day with no row breaks the streak). */
export function emptyStreak(db: DB, localDate: string): number {
  let n = 1;
  const get = db.prepare('SELECT status, skip_reason FROM digests WHERE local_date = ?');
  for (let d = addDays(localDate, -1); n < 400; d = addDays(d, -1)) {
    const r = get.get(d) as { status: string; skip_reason: string | null } | undefined;
    if (!r || r.status !== 'skipped' || (r.skip_reason !== 'empty' && r.skip_reason !== 'pipeline_failed')) break;
    n++;
  }
  return n;
}

export const noticeText = (stage: string): string => `${BOT_MARKER} Heads up: last night's run failed at ${stage}.\nDetails at ${SOURCES_LINK}`;
export const heartbeatText = (days: number, added: number): string =>
  `${BOT_MARKER} All quiet for ${days} days. Nothing needs you right now.${added ? `\nI added ${plural(added, 'new person', 'new people')} to your contacts.` : ''}`;

interface ChannelStep {
  state: ChannelDelivery;
  final: boolean;
  reason: string | null;
}

/** Maps a send result to the channel's state. */
export function imessageStep(r: OutboundResult): ChannelStep & { sent: boolean } {
  switch (r.status) {
    case 'delivered':
    case 'sent':
    case 'unverified':
      return { state: 'sent', final: true, reason: null, sent: true };
    case 'duplicate':
      // The earlier send's result is final (sender returns 'duplicate' only for answered sends).
      return { state: 'sent', final: true, reason: null, sent: true };
    case 'ghost':
      return { state: 'failed', final: true, reason: 'ghost', sent: false };
    case 'failed':
      return r.reason === 'collector_unavailable'
        ? { state: 'pending', final: false, reason: 'collector_unavailable', sent: false }
        : { state: 'failed', final: true, reason: r.reason ?? 'failed', sent: false };
    case 'blocked':
      return r.reason === 'quiet_hours' || r.reason === 'circuit_open'
        ? { state: 'pending', final: false, reason: r.reason, sent: false }
        : { state: 'failed', final: true, reason: r.reason ?? 'blocked', sent: false };
    case 'disabled':
    default:
      return { state: 'not_configured', final: false, reason: r.reason ?? 'collector_unavailable', sent: false };
  }
}

/**
 * A duplicate's real outcome (the stored outbound row). The sender answers 'duplicate' only for sends the collector
 * answered (or that are still in flight); a failed one is final.
 */
function duplicateOutcome(db: DB, r: OutboundResult): OutboundResult {
  if (r.status !== 'duplicate' || !r.outboundId) return r;
  const status = db.prepare('SELECT status FROM outbound_messages WHERE id = ?').pluck().get(r.outboundId) as string | undefined;
  if (status === 'delivered' || status === 'sent' || status === 'unverified' || status === 'ghost') return { ...r, status };
  if (status === 'failed') return { ...r, status: 'failed', reason: undefined };
  // still in flight (another tick is sending it): wait
  return { ...r, status: 'failed', reason: 'collector_unavailable' };
}

interface Clock {
  now: number;
  date: string;
  hhmm: string;
  s: SettingsSnapshot;
  pastCatchUp: boolean;
  paused: boolean;
  quiet: boolean;
}

function clockOf(db: DB, now: number): Clock {
  const s = settingsSnapshot(db);
  const lp = localParts(now, s.tz);
  return {
    now,
    date: lp.date,
    hhmm: lp.hhmm,
    s,
    pastCatchUp: lp.hhmm >= s['digest.catch_up_until'],
    paused: s['digest.paused_until'] !== null && s['digest.paused_until'] > now,
    quiet: inLocalWindow(lp.hhmm, s.quiet_hours.start, s.quiet_hours.end),
  };
}

/** Push for the day's brief (one attempt per day once it can go). */
async function pushStep(deps: DeliveryDeps, c: Clock, d: DigestRow, payload: PushPayload): Promise<ChannelStep & { result: PushFanoutResult | null }> {
  if (d.push_sent_at || d.push_status === 'sent' || d.push_status === 'failed') return { state: (d.push_status as ChannelDelivery) ?? 'sent', final: true, reason: null, result: null };
  if (c.pastCatchUp) return { state: 'skipped', final: true, reason: 'catch_up_passed', result: null };
  if (!c.s['push.enabled']) return { state: 'disabled', final: false, reason: 'disabled', result: null };
  if (!deps.push.configured || pushDeviceCount(deps.db) === 0) return { state: 'not_configured', final: false, reason: 'not_configured', result: null };
  if (c.paused) return { state: 'skipped', final: false, reason: 'paused', result: null };
  if (c.quiet) return { state: 'pending', final: false, reason: 'quiet_hours', result: null };
  const ttlSeconds = Math.max(600, Math.round((catchUpEndMs(c) - c.now) / 1000));
  const result = await pushToDevices(deps.db, deps.push, payload, { now: deps.now, log: deps.log, ttlSeconds, urgency: 'normal' });
  return { state: result.sent ? 'sent' : 'failed', final: true, reason: result.sent ? null : 'push_failed', result };
}

/** Ms until today's catch-up end (approximate: minutes from the local clock). */
function catchUpEndMs(c: Clock): number {
  const [h, m] = c.hhmm.split(':').map(Number) as [number, number];
  const [eh, em] = c.s['digest.catch_up_until'].split(':').map(Number) as [number, number];
  return c.now + ((eh * 60 + em) - (h * 60 + m)) * MIN;
}

async function handleEmpty(deps: DeliveryDeps, c: Clock, d: DigestRow): Promise<DeliveryTickResult> {
  const db = deps.db;
  const failure = pipelineFailure(db, c.now);
  const reason = failure ? 'pipeline_failed' : 'empty';
  const finalize = (patch: Partial<Record<keyof DigestRow, string | number | null>>, action: DeliveryAction, imessage: ChannelDelivery): DeliveryTickResult => {
    updateRow(db, d.id, { status: 'skipped', skip_reason: reason, imessage_status: imessage, push_status: 'skipped', delivery_checked_at: c.now, ...patch });
    return { action, localDate: c.date, reason, imessage, push: 'skipped' };
  };
  const streak = failure ? 0 : emptyStreak(db, c.date);
  const wantsHeartbeat = !failure && streak >= HEARTBEAT_EVERY_DAYS && streak % HEARTBEAT_EVERY_DAYS === 0;
  if (!failure && !wantsHeartbeat) return finalize({}, 'skipped', 'skipped');
  if (!c.s['digest.enabled']) return finalize({}, 'skipped', 'disabled');
  if (c.paused || c.pastCatchUp) return finalize({}, 'skipped', 'skipped');
  if (c.quiet) {
    updateRow(db, d.id, { skip_reason: 'quiet_hours', imessage_status: 'pending', delivery_checked_at: c.now });
    return { action: 'waiting', localDate: c.date, reason: 'quiet_hours', imessage: 'pending' };
  }
  const text = failure ? noticeText(failure.stage) : heartbeatText(streak, peopleAdded(db, c.now - streak * DAY, c.now));
  const purpose = failure ? 'alert' : 'heartbeat';
  const sent = duplicateOutcome(db, await deps.services.outbound.sendToSelf(text, purpose, stableUuid(`${purpose}:${d.id}`), { digestId: d.id }));
  const step = imessageStep(sent);
  if (!step.final) {
    updateRow(db, d.id, { skip_reason: step.reason, imessage_status: step.state, delivery_checked_at: c.now });
    return { action: 'waiting', localDate: c.date, reason: step.reason, imessage: step.state };
  }
  deps.log?.info(`digest.${purpose}`, { ids: [d.id], counts: { sent: step.sent ? 1 : 0 } });
  return finalize({ notice_outbound_id: sent.outboundId }, step.sent ? (failure ? 'notice_sent' : 'heartbeat_sent') : 'failed', step.state);
}

/** One generic push per newly opened critical alert ("Instagram needs attention · open Sources"). */
export async function healthPushes(deps: DeliveryDeps, c: Clock): Promise<number> {
  if (!c.s['push.enabled'] || !deps.push.configured || c.quiet || pushDeviceCount(deps.db) === 0) return 0;
  const alerts = deps.db
    .prepare(`SELECT id, source FROM alerts WHERE resolved_at IS NULL AND severity = 'critical' AND last_notified_at IS NULL ORDER BY opened_at LIMIT 3`)
    .all() as { id: string; source: string }[];
  let n = 0;
  for (const a of alerts) {
    const label = SOURCE_LABELS[a.source] ?? 'A source';
    await pushToDevices(deps.db, deps.push, { kind: 'health', title: 'Yeackbot', body: `${label} needs attention · open Sources`, url: '/sources', tag: `health-${a.source}`.slice(0, 64) }, {
      now: deps.now,
      log: deps.log,
      ttlSeconds: 12 * 3600,
    });
    deps.db.prepare('UPDATE alerts SET last_notified_at = ? WHERE id = ?').run(c.now, a.id);
    n++;
  }
  return n;
}

/**
 * Today's ranking hasn't run yet but still will: the 'suggestions' job exists, isn't disabled, hasn't covered today
 * and isn't failing (a failing ranker gets the empty day / failure notice instead of a silent wait).
 */
export function rankerPending(db: DB, localDate: string): boolean {
  const st = db.prepare(`SELECT last_success_local_date, consecutive_failures, disabled FROM job_state WHERE job = 'suggestions'`).get() as
    | { last_success_local_date: string | null; consecutive_failures: number; disabled: number }
    | undefined;
  if (!st || st.disabled || st.consecutive_failures > 0) return false;
  return (st.last_success_local_date ?? '') < localDate;
}

/** The status a sent digest gets: 'fallback_sent' when a configured LLM couldn't write the copy. */
function sentStatus(c: ComposedDigest | null): 'sent' | 'fallback_sent' {
  const l = c?.llm;
  if (!l || c?.composer === 'llm') return 'sent';
  return l.status === 'ok' || l.status === 'skipped' || l.reason === 'no_key' || l.reason === 'disabled' ? 'sent' : 'fallback_sent';
}

/** The client_ref of part k of a digest (part 0 keeps the one-text era's ref). Stable because parts freeze. */
export const partRef = (digestId: string, k: number): string => stableUuid(k === 0 ? `digest:${digestId}` : `digest:${digestId}:${k}`);

interface FirstPart {
  id: string;
  at: number;
}

/** The brief's first text that reached the owner (by send order), or null. */
function firstDeliveredPart(db: DB, digestId: string): FirstPart | null {
  return (
    (db
      .prepare(
        `SELECT id, coalesce(sent_at, created_at) AS at FROM outbound_messages
         WHERE digest_id = ? AND purpose = 'digest' AND status IN ('delivered','sent','unverified') ORDER BY created_at LIMIT 1`,
      )
      .get(digestId) as FirstPart | undefined) ?? null
  );
}

type PartsStep = ChannelStep & { sent: boolean; outboundId: string | null; sentAt: number | null };

/**
 * Sends the brief's texts in order. Parts already sent come back as duplicates (no second text). The moment the
 * first text reaches the owner the digest is marked sent (sent_at, outbound_id, a sent status) with
 * imessage_status 'pending' / skip_reason 'partial' until the rest settle, so replies bind to it right away and a
 * crash mid-way can't lose track of it. A part that can't go yet (collector down, quiet hours, circuit open) stops
 * here; a part refused for good is skipped so the rest still arrives; a part about someone hidden since is dropped.
 */
async function sendParts(deps: DeliveryDeps, d: DigestRow, composed: ComposedDigest, sel: DigestSelection, now: number, statusOnSent: 'sent' | 'fallback_sent'): Promise<PartsStep> {
  const db = deps.db;
  const visible = new Set(sel.items.map((i) => i.suggestionId));
  // A text that carries the whole brief (the minimal fallback, or a one-text brief composed before the upgrade).
  const wholeBrief = composed.parts.every((p) => p === null);
  // Such a text names everyone it was written about: if one of them is hidden since, send the nameless version
  // under the same ref (if the old text already reached the collector it dedupes; otherwise no name goes out).
  const stale = wholeBrief && composed.suggestionIds.some((id) => !visible.has(id));
  const texts = stale ? [minimalText(sel.items.length)] : composed.texts;
  const parts = stale ? [null] : composed.parts;
  let first: FirstPart | null = d.sent_at && d.outbound_id ? { id: d.outbound_id, at: d.sent_at } : firstDeliveredPart(db, d.id);
  let lastFailure: ChannelStep | null = null;
  for (let k = 0; k < texts.length; k++) {
    const part = parts[k] ?? null;
    if (part && !visible.has(part.suggestionId)) {
      deps.log?.info('digest.part_dropped', { ids: [d.id], counts: { part: k } });
      continue;
    }
    const r = duplicateOutcome(
      db,
      await deps.services.outbound.sendToSelf(texts[k]!, 'digest', partRef(d.id, k), { digestId: d.id, digestOrdinal: part?.ordinal ?? null }),
    );
    const step = imessageStep(r);
    if (step.sent) {
      if (!first && r.outboundId) {
        first = { id: r.outboundId, at: now };
        db.prepare(
          `UPDATE digests SET status = CASE WHEN status IN ('sent','fallback_sent') THEN status ELSE ? END, sent_at = coalesce(sent_at, ?),
             outbound_id = coalesce(outbound_id, ?), imessage_status = 'pending', skip_reason = 'partial', delivery_checked_at = ? WHERE id = ?`,
        ).run(statusOnSent, now, r.outboundId, now, d.id);
      }
      // Only what reached the owner counts as delivered (a text that carries the whole brief delivers every item).
      if (part) markDelivered(db, [part.suggestionId], now);
      else if (wholeBrief) markDelivered(db, [...visible], now);
      continue;
    }
    if (!step.final) {
      // Nothing out yet: the channel's own state (not configured, quiet hours…); else the brief is part-way out.
      return first ? { state: 'pending', final: false, reason: 'partial', sent: false, outboundId: first.id, sentAt: first.at } : { ...step, sent: false, outboundId: null, sentAt: null };
    }
    lastFailure = step;
    deps.log?.warn('digest.part_failed', { ids: [d.id], counts: { part: k } });
  }
  if (first) return { state: 'sent', final: true, reason: null, sent: true, outboundId: first.id, sentAt: first.at };
  return { ...(lastFailure ?? { state: 'failed', final: true, reason: 'failed' }), sent: false, outboundId: null, sentAt: null };
}

/**
 * Briefs from earlier days that were part-way out when their day ended (collector down past midnight, a crash):
 * what went out counts, the rest is dropped (yesterday's suggestions arriving today would be stale).
 */
function closeStrandedBriefs(deps: DeliveryDeps, today: string, now: number): void {
  const db = deps.db;
  const rows = db
    .prepare(
      `SELECT d.id FROM digests d WHERE d.local_date < ? AND coalesce(d.imessage_status, '') <> 'sent'
         AND d.status IN ('composing','ready','sent','fallback_sent')
         AND (d.skip_reason = 'partial' OR (d.sent_at IS NULL AND EXISTS (SELECT 1 FROM outbound_messages om
              WHERE om.digest_id = d.id AND om.purpose = 'digest' AND om.status IN ('delivered','sent','unverified'))))`,
    )
    .pluck()
    .all(today) as string[];
  for (const id of rows) {
    const first = firstDeliveredPart(db, id);
    if (!first) continue;
    db.prepare(
      `UPDATE digests SET status = CASE WHEN status IN ('sent','fallback_sent') THEN status ELSE 'sent' END, sent_at = coalesce(sent_at, ?),
         outbound_id = coalesce(outbound_id, ?), imessage_status = 'sent', skip_reason = NULL, delivery_checked_at = ? WHERE id = ?`,
    ).run(first.at, first.id, now, id);
    deps.log?.info('digest.parts_closed', { ids: [id] });
  }
}

/** One delivery decision for today (plus any pending critical-alert pushes). Never throws for delivery outcomes. */
export async function deliveryTick(deps: DeliveryDeps): Promise<DeliveryTickResult> {
  const now = deps.now?.() ?? Date.now();
  const c = clockOf(deps.db, now);
  // Pre-event pings are the intel job's ('pre-event-push', claim-first, deep link to the brief), not this tick's.
  const healthPushed = await healthPushes(deps, c);
  const r = await digestStep(deps, c);
  return { ...r, healthPushes: healthPushed };
}

async function digestStep(deps: DeliveryDeps, c: Clock): Promise<DeliveryTickResult> {
  const db = deps.db;
  const now = c.now;
  const select = deps.select ?? readDigestSelection;
  closeStrandedBriefs(deps, c.date, now);
  if (c.hhmm < c.s['digest.time']) return { action: 'before_time', localDate: c.date };

  let sel: DigestSelection | null = select(db, { localDate: c.date, now });
  if (!sel) {
    if (c.hhmm < addMinutes(c.s['digest.time'], MISSING_ROW_GRACE_MIN) && !c.pastCatchUp) return { action: 'no_digest_yet', localDate: c.date };
    // The ranker is late (the Mac slept through 07:16, a slow night): keep waiting for it until catch-up ends.
    if (!c.pastCatchUp && rankerPending(db, c.date)) return { action: 'no_digest_yet', localDate: c.date, reason: 'ranker_pending' };
    db.prepare(`INSERT OR IGNORE INTO digests (id, local_date, status, composed_at) VALUES (?, ?, 'ready', ?)`).run(uuidv7(now), c.date, now);
    sel = select(db, { localDate: c.date, now }) ?? { digest: getDigestRow(db, c.date)!, items: [], droppedHidden: 0 };
  }
  const d = sel.digest;
  // A brief is "started" once one of its texts reached the owner; until all its texts settle it is part-way out.
  const first = d.sent_at && d.outbound_id ? { id: d.outbound_id, at: d.sent_at } : firstDeliveredPart(db, d.id);
  const partial = first !== null && d.imessage_status !== 'sent';
  if (FINAL_STATUSES.has(d.status) && !partial) return { action: 'final', localDate: c.date };
  if (!sel.items.length && !first) return handleEmpty(deps, c, d);

  // Compose (or recompose if the ranker's picks changed) before anything goes out; never once a text was handed to
  // the sender: parts are sent by position, so the texts must not move under their client_refs.
  const frozen = first !== null || partsAttempted(db, d.id);
  let composed = frozen || compositionCurrent(sel) ? storedComposition(sel) : null;
  if (!composed) {
    composed = await composeSelection(db, deps.services, sel, { localDate: c.date, now, log: deps.log, signal: deps.signal, settings: c.s });
    persistComposition(db, composed, now);
  }
  const statusOnSent = d.status === 'sent' || d.status === 'fallback_sent' ? d.status : sentStatus(composed);

  // iMessage: one text per suggestion.
  let im: ChannelStep & { sent?: boolean; outboundId?: string | null; sentAt?: number | null };
  const priorReason = d.skip_reason;
  if (d.imessage_status === 'sent') im = { state: 'sent', final: true, reason: null };
  else if (partial) {
    // Part-way out: finish it, unless the owner paused or turned off the brief since, or its morning is over;
    // then what already went out counts and nothing more is sent.
    const stop = c.paused ? 'paused' : !c.s['digest.enabled'] ? 'disabled' : c.pastCatchUp ? 'catch_up_passed' : null;
    if (stop) {
      deps.log?.info('digest.parts_stopped', { ids: [d.id], counts: { [stop]: 1 } });
      im = { state: 'sent', final: true, reason: null, sent: true, outboundId: first.id, sentAt: first.at };
    } else im = await sendParts(deps, d, composed, sel, now, statusOnSent);
  } else if (c.pastCatchUp) im = { state: 'skipped', final: true, reason: priorReason && priorReason !== 'quiet_hours' ? priorReason : 'catch_up_passed' };
  else if (c.paused) im = { state: 'skipped', final: false, reason: 'paused' };
  else if (!c.s['digest.enabled']) im = { state: 'disabled', final: false, reason: 'disabled' };
  else if (c.quiet) im = { state: 'pending', final: false, reason: 'quiet_hours' };
  else im = await sendParts(deps, d, composed, sel, now, statusOnSent);

  // push
  // The body follows the names setting at push time (it may have changed since compose).
  const body = pushBodyFor(composed.items, c.s['push.names_in_notifications']);
  const ps = await pushStep(deps, c, d, { kind: 'digest', title: 'Yeackbot', body, url: '/today', tag: `digest-${c.date}` });

  const patch: Partial<Record<keyof DigestRow, string | number | null>> = {
    imessage_status: im.state,
    push_status: ps.state,
    skip_reason: im.state === 'sent' ? null : im.reason,
    delivery_checked_at: now,
  };
  if (ps.result?.sent) patch.push_sent_at = now;
  if (im.sent) {
    patch.sent_at = im.sentAt ?? now;
    patch.outbound_id = im.outboundId ?? null;
  }
  if (im.final) patch.status = im.state === 'sent' ? statusOnSent : im.state === 'failed' ? 'failed' : 'skipped';
  updateRow(db, d.id, patch);
  // iMessage marks each item as its text goes out (sendParts); the push puts every item in front of the owner.
  if (ps.result?.sent) markDelivered(db, sel.items.map((i) => i.suggestionId), now);

  const action: DeliveryAction = im.sent ? 'delivered' : im.final ? (im.state === 'failed' ? 'failed' : 'skipped') : ps.result?.sent ? 'delivered' : 'waiting';
  if (im.sent || im.final) deps.log?.info('digest.delivery', { ids: [d.id], counts: { items: composed.items.length, texts: composed.texts.length, imessage: im.sent ? 1 : 0, push: ps.result?.sent ?? 0 } });
  return { action, localDate: c.date, reason: patch.skip_reason as string | null, imessage: im.state, push: ps.state, pushed: ps.result };
}

/** Why today's digest wouldn't go out over iMessage right now (null = it would). For preview / Today. */
export function whyNotSent(
  db: DB,
  outboundConfigured: boolean,
  o: { localDate: string; now: number; itemCount: number; digest: DigestRow | null },
):
  | 'disabled'
  | 'paused'
  | 'empty'
  | 'quiet_hours'
  | 'catch_up_passed'
  | 'already_sent'
  | 'no_self_handle'
  | 'collector_unavailable'
  | null {
  const c = clockOf(db, o.now);
  if (o.digest?.sent_at || o.digest?.status === 'sent' || o.digest?.status === 'fallback_sent') return 'already_sent';
  if (!c.s['digest.enabled']) return 'disabled';
  if (c.paused) return 'paused';
  if (o.itemCount === 0) return 'empty';
  if (o.localDate < c.date || (o.localDate === c.date && c.pastCatchUp)) return 'catch_up_passed';
  if (o.localDate === c.date && c.quiet && c.hhmm >= c.s['digest.time']) return 'quiet_hours';
  if (!c.s.self_handles.length) return 'no_self_handle';
  if (!outboundConfigured) return 'collector_unavailable';
  return null;
}
