/**
 * Nightly LLM adjudication of calendar attendees (PLAN "Calendar attendee inference" step 4).
 *
 * Submit (job 'intel-adjudicate', 03:20 — after the 03:00 occasions pass and the 03:10 extraction submit):
 *   - queue: live social occasions with candidates that the adjudicator hasn't seen since their last inference
 *     (pipeline/occasions/packet.ts occasionsAwaitingAdjudication), plus the DAY-AFTER re-run: occasions that ended
 *     20–72 h ago and were last adjudicated before their next-day messages ("great seeing you") could exist;
 *   - each occasion's packet (packet.ts buildAdjudicationPacket) is rendered with the cited messages, the owner's
 *     other plans around it and whether it is one week of a recurring listing (pipeline/occasions/plans.ts), and goes through
 *     the egress choke point: people become P… tokens, phones / emails / handles / street addresses are scrubbed,
 *     hidden people's names are blanked, excluded people and conversations never appear (an occasion that would
 *     need them is skipped). A raw identifier left anywhere skips that occasion (fail closed);
 *   - one Message Batch per budget pool on the 'adjudicate' route (llm/models.ts: Haiku 5.5, effort low, thinking
 *     off, the system prompt cached 1 h; NO fallbacks), custom_id `a{promptVersion}-{occasion}r{round}-{attempt}`.
 *     Without an API key or budget nothing is sent and the deterministic attendees stand.
 * Apply (the llm-collect job hands each result to this module's BatchConsumer; a refusal is final on Haiku 5.5 —
 * llm/batches.ts calls fail('refused') — and the deterministic attendees stand):
 *   - confidence ≥ 0.75 → counted ('attended' past / 'going' upcoming); 0.5–0.75 → 'possible'; lower, omitted or
 *     mentioned_only → the agent's own row is withdrawn — all as source 'llm' rows through the journal (one undoable
 *     'attendee' batch per occasion), which the deterministic step then leaves alone while the person is still a
 *     candidate there;
 *   - the verdict moves a message-only candidate up one tier at most: one the deterministic score kept below
 *     "possible" (nothing names them, not a name's or a group's person) can become possible, never counted;
 *   - never overwritten: the user's rows, legacy rows, 'rejected' rows (a sticky "wasn't there"), rows whose last
 *     change was an undo; explicit invites and Partiful guest-list rows are only ever upgraded (status and
 *     confidence; their source, role and the rest stay, so the deterministic pass keeps owning them), never
 *     downgraded or withdrawn;
 *   - a "not social" verdict with nobody attending reclassifies the occasion (classified_by 'llm'), unless it is a
 *     Partiful event, the owner holds a ticket to it (a live 'ticket' source), or the user classified it;
 *   - interactions and co_attend edges are re-derived afterwards (EFFECTS_DIRTY → job 'intel-effects').
 */
import { localDate, localParts, uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { withBatch } from '../journal/batch';
import { finishRun, getRun, startRun } from '../journal/runs';
import { registerBatchConsumer, type BatchConsumer, type BatchFailure, type StoredBatchItem } from '../llm/batches';
import { schemaJson } from '../llm/caching';
import { personIdsIn } from '../llm/egress';
import { llmExclusions } from '../llm/ledger';
import { estimatePromptTokens, estimateRouteUsd, resolveRoute, type RouteParams } from '../llm/models';
import {
  customId,
  EgressBlocked,
  routePromptVersion,
  type BudgetPool,
  type Egress,
  type EgressPerson,
  type LlmBatchItem,
  type LlmClient,
} from '../llm/types';
import { nullLogger, type Logger } from '../ops/logger';
import { lastChangeWasUndo } from '../pipeline/occasions/attendees';
import { occasionChain, survivingOccasion } from '../pipeline/occasions/build';
import { AdjudicationResult, buildAdjudicationPacket, occasionsAwaitingAdjudication } from '../pipeline/occasions/packet';
import { isStandingOccasion, plansNear } from '../pipeline/occasions/plans';
import { CAPPED, COUNTED, NAMED, POSSIBLE, type SignalType } from '../pipeline/occasions/signals';
import { hasLiveTicket } from '../pipeline/occasions/tickets';
import { hiddenNameRedactor } from '../routes/people';
import { settingTimeZone } from '../settings/registry';
import { ADJUDICATION_SYSTEM } from './adjudicationPrompt';
import { DAY, EFFECTS_DIRTY, HOUR, ownerId, setFlag, visibleCanonical } from './common';

export const ADJUDICATION_PURPOSE = 'calendar_adjudication';
/** Nightly submit time (local). */
export const ADJUDICATE_AT = '03:20';
export const ADJUDICATION = {
  maxPerNight: 150,
  /** Occasions that ended longer ago than this pay from the one-time backfill pool. */
  backfillAfterMs: 30 * DAY,
  /** Day-after re-run window (end of the occasion → now). */
  dayAfterFromMs: 20 * HOUR,
  dayAfterToMs: 72 * HOUR,
  /** A submitted request with no result yet blocks a resubmit for this long. */
  inFlightMs: 26 * HOUR,
  maxMessages: 40,
  maxMessageChars: 280,
  maxNoteChars: 800,
} as const;

/** prompt_version of the adjudication request (system ‖ schema ‖ model ‖ effort of the route's defaults). */
export const ADJUDICATION_VERSION = routePromptVersion('adjudicate', ADJUDICATION_SYSTEM, schemaJson(AdjudicationResult));

/** What one request was allowed to cite, mapped back to local ids (stored locally, never sent). */
export interface AdjudicationRefs {
  /** P… token → person id. */
  tokens: Record<string, string>;
  /** Person ids that were direct candidates (P lines). */
  candidates: string[];
  /** Message ids shown in the packet. */
  messages: number[];
}

export type QueueReason = 'new' | 'changed' | 'day_after';

// ---------------------------------------------------------------------------------------------- queue

/** Occasions to adjudicate tonight (day-after re-runs first, then the newest), minus ones still in flight. */
export function adjudicationQueue(db: DB, now: number, limit: number = ADJUDICATION.maxPerNight): { occasionId: string; reason: QueueReason }[] {
  const inFlight = new Set(
    db.prepare(`SELECT occasion_id FROM occasion_adjudications WHERE status = 'submitted' AND submitted_at > ?`).pluck().all(now - ADJUDICATION.inFlightMs) as string[],
  );
  const out: { occasionId: string; reason: QueueReason }[] = [];
  const seen = new Set<string>();
  const add = (id: string, reason: QueueReason) => {
    if (seen.has(id) || inFlight.has(id) || out.length >= limit) return;
    seen.add(id);
    out.push({ occasionId: id, reason });
  };
  const dayAfter = db
    .prepare(
      `SELECT id FROM occasions
       WHERE merged_into_id IS NULL AND status = 'active' AND is_social = 1 AND sensitive = 0 AND candidate_count > 0
         AND coalesce(ends_at, starts_at) BETWEEN @from AND @to
         AND adjudicated_at IS NOT NULL AND adjudicated_at < coalesce(ends_at, starts_at) + @gap
       ORDER BY starts_at DESC`,
    )
    .pluck()
    .all({ from: now - ADJUDICATION.dayAfterToMs, to: now - ADJUDICATION.dayAfterFromMs, gap: ADJUDICATION.dayAfterFromMs }) as string[];
  for (const id of dayAfter) add(id, 'day_after');
  const adjudicated = db.prepare('SELECT adjudicated_at FROM occasions WHERE id = ?').pluck();
  for (const id of occasionsAwaitingAdjudication(db, limit * 2)) add(id, adjudicated.get(id) == null ? 'new' : 'changed');
  return out;
}

// ---------------------------------------------------------------------------------------------- packet

export interface RenderedPacket {
  occasionId: string;
  /** The pseudonymized user turn. */
  text: string;
  refs: AdjudicationRefs;
  endsAt: number;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};
const localStamp = (ms: number, tz: string) => {
  const p = localParts(ms, tz);
  return `${p.date} ${p.hhmm}`;
};
/** A written name, first name + last initial (unresolved names are not known people the egress could shorten). */
const shortSurface = (s: string | null) => {
  const words = (s ?? '').replace(/["\n]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'someone';
  return words.length === 1 ? words[0]! : `${words[0]} ${[...words[words.length - 1]!][0]!.toUpperCase()}.`;
};

interface MessageRow {
  id: number;
  sent_at: number;
  is_from_me: number;
  text: string | null;
  kind: string;
  conversation_id: string;
  conv_kind: string;
  sender: string | null;
}

/**
 * The pseudonymized user turn for one occasion, or null when there is nothing to adjudicate (no live packet, no
 * candidate left after exclusions, or a candidate/message that may not leave the Mac).
 */
export function renderPacket(
  db: DB,
  egress: Egress,
  occasionId: string,
  o: { now: number; timeZone: string; excludedPeople: ReadonlySet<string>; excludedConversations: ReadonlySet<string> },
): RenderedPacket | null {
  const packet = buildAdjudicationPacket(db, occasionId);
  if (!packet) return null;
  const me = ownerId(db);
  const redact = hiddenNameRedactor(db);
  const nameOf = db.prepare('SELECT first_name, last_name, display_name FROM person_visible WHERE id = ?');
  const people = new Map<string, EgressPerson>();
  const tokens: Record<string, string> = {};
  /** The person's token; `cite` = it may be answered as an attendee (candidate section only, not message senders). */
  const tokenOf = (rawId: string, cite = true): string | null => {
    const pid = visibleCanonical(db, rawId);
    if (!pid || pid === me || o.excludedPeople.has(pid) || o.excludedPeople.has(rawId)) return null;
    const r = nameOf.get(pid) as { first_name: string | null; last_name: string | null; display_name: string } | undefined;
    if (!r) return null;
    if (!people.has(pid)) people.set(pid, { personId: pid, firstName: r.first_name ?? r.display_name.split(/\s+/)[0] ?? null, lastName: r.last_name });
    const t = egress.tokenFor(pid);
    if (cite) tokens[t] = pid;
    return t;
  };
  const firstName = (pid: string) => people.get(pid)?.firstName ?? 'someone';

  const candidates: string[] = [];
  const messageIds = new Set<number>();
  const lines: string[] = [];
  let n = 0;
  let g = 0;
  for (const c of packet.candidates) {
    if (c.kind === 'person') {
      const t = tokenOf(c.ref.replace(/^p:/, ''));
      if (!t) continue;
      candidates.push(tokens[t]!);
      const signals = c.evidence.map((e) => {
        const ids = e.evidence_ids.filter((x) => /^m:\d+$/.test(x));
        for (const x of ids) messageIds.add(Number(x.slice(2)));
        return `${e.type} ${e.weight.toFixed(2)}${ids.length ? ` [${ids.slice(0, 6).join(' ')}]` : ''}`;
      });
      lines.push(`${t} ${firstName(tokens[t]!)} · score ${c.score.toFixed(2)} · role ${c.role ?? 'companion'}${signals.length ? ` · ${signals.join('; ')}` : ''}`);
    } else if (c.kind === 'name') {
      const alts = c.alternatives.map((a) => tokenOf(a.replace(/^p:/, ''))).filter((x): x is string => !!x);
      lines.push(`N${++n} "${redact(shortSurface(c.label)) ?? 'someone'}"${alts.length ? ` · could be ${alts.map((t) => `${t} (${firstName(tokens[t]!)})`).join(', ')}` : ''}`);
    } else {
      const members = c.alternatives.map((a) => tokenOf(a.replace(/^p:/, ''))).filter((x): x is string => !!x);
      if (!members.length) continue;
      lines.push(`G${++g} "${redact(clip(c.label ?? 'a group', 60)) ?? 'a group'}" · members ${members.join(', ')}`);
    }
  }
  if (!Object.keys(tokens).length) return null;

  // the cited messages (never from excluded conversations or people)
  const msgLines: string[] = [];
  const shown: number[] = [];
  if (messageIds.size) {
    const rows = db
      .prepare(
        `SELECT m.id, m.sent_at, m.is_from_me, m.text, m.kind, m.conversation_id, c.kind AS conv_kind, pc.canonical_id AS sender
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN identities i ON i.id = m.sender_identity_id LEFT JOIN person_canon pc ON pc.person_id = i.person_id
         WHERE m.id IN (SELECT value FROM json_each(?)) AND m.retracted_at IS NULL AND m.is_bot = 0
         ORDER BY m.sent_at, m.id`,
      )
      .all(JSON.stringify([...messageIds])) as MessageRow[];
    const partner = db.prepare(
      `SELECT pc.canonical_id FROM conversation_members cm JOIN identities i ON i.id = cm.identity_id JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE cm.conversation_id = ? AND pc.canonical_id IS NOT ? ORDER BY cm.last_seen_at DESC LIMIT 1`,
    ).pluck();
    for (const m of rows.slice(-ADJUDICATION.maxMessages)) {
      if (o.excludedConversations.has(m.conversation_id)) continue;
      if (m.sender && o.excludedPeople.has(m.sender)) continue;
      const sender = m.is_from_me ? 'ME' : m.sender ? (tokenOf(m.sender, false) ?? 'someone') : 'someone';
      let to = 'group';
      if (m.conv_kind === 'direct') {
        if (m.is_from_me) {
          const p = partner.get(m.conversation_id, me) as string | undefined;
          to = (p && tokenOf(p, false)) ?? 'them';
        } else to = 'ME';
      }
      const body = m.kind === 'attachment' && !m.text ? '<attachment>' : clip(m.text ?? '', ADJUDICATION.maxMessageChars) || '<no text>';
      msgLines.push(`[m:${m.id}|${localStamp(m.sent_at, o.timeZone)}|${sender}→${to}] ${body}`);
      shown.push(m.id);
    }
  }

  const occ = packet.occasion;
  const endsAt = occ.ends_at ?? occ.starts_at;
  const occasionId0 = occ.ref.replace(/^o:/, '');
  const standing = isStandingOccasion(db, occasionId0);
  const plans = plansNear(db, occasionId0).map(
    (p) =>
      `- ${redact(clip(p.title ?? '(untitled)', 80)) ?? '(untitled)'} · ${localStamp(p.startsAt, o.timeZone)} → ${localStamp(p.endsAt, o.timeZone)}${p.standing ? ' · recurring listing' : ''}`,
  );
  const occLines = [
    `title: ${redact(clip(occ.title ?? '(untitled)', 200)) ?? '(untitled)'}`,
    `venue: ${occ.venue ? clip(occ.venue, 200) : 'none'}`,
    `when: ${localStamp(occ.starts_at, o.timeZone)}${occ.ends_at ? ` → ${localStamp(occ.ends_at, o.timeZone)}` : ''}${occ.all_day ? ' (all day)' : ''} · ${endsAt <= o.now ? 'past' : 'upcoming'}`,
    `rules kind: ${occ.kind}`,
    `tickets: ${occ.ticket_count ?? 'none'}`,
    `listing: ${standing ? 'yes, one week of a recurring listing on a calendar of things to do' : 'no'}`,
    `notes: ${occ.notes.length ? redact(clip(occ.notes.join(' / '), ADJUDICATION.maxNoteChars)) : 'none'}`,
  ];
  const sections = [
    { name: 'occasion', text: occLines.join('\n') },
    { name: 'other plans', text: plans.length ? plans.join('\n') : 'none' },
    { name: 'candidates', text: lines.join('\n') },
    { name: 'messages', text: msgLines.length ? msgLines.join('\n') : 'none' },
  ];
  const pseudo = egress.pseudonymize({ purpose: 'calendar', sections, people: [...people.values(), ...(me ? [{ personId: me, firstName: null, isMe: true }] : [])] });
  const text = `tz=${o.timeZone}\n${pseudo.text}`;
  egress.scan(text);
  // A scrubbed phone number can name someone too: an excluded person anywhere means this occasion stays home.
  if (o.excludedPeople.size && personIdsIn(egress, text).some((id) => o.excludedPeople.has(id))) return null;
  return { occasionId, text, refs: { tokens, candidates, messages: shown }, endsAt };
}

/** Rough batch cost of one request (input incl. a cached system prompt, ~700 output tokens). */
const PREFIX_TOKENS = estimatePromptTokens(ADJUDICATION_SYSTEM.length + schemaJson(AdjudicationResult).length);
/** One request's estimate at batch prices on the route's model (the system prompt read from the 1 h cache). */
export const estimateUsd = (text: string, p: RouteParams = resolveRoute('adjudicate')): number =>
  estimateRouteUsd(p, { userTokens: estimatePromptTokens(text), systemTokens: PREFIX_TOKENS, mode: 'batch' });

// ---------------------------------------------------------------------------------------------- submit

export interface SubmitResult {
  status: 'ok' | 'skipped' | 'partial';
  reason: string | null;
  stats: Record<string, number>;
}

const subjectRefOf = (occasionId: string, round: number) => `occ:${occasionId}#${round}`;
export function parseSubjectRef(ref: string): { occasionId: string; round: number } | null {
  const m = /^occ:([0-9a-f-]{36})#(\d+)$/i.exec(ref);
  return m ? { occasionId: m[1]!.toLowerCase(), round: Number(m[2]) } : null;
}

/** Builds and submits tonight's adjudication batches. Never throws for LLM outcomes. */
export async function submitAdjudications(
  db: DB,
  services: { llm: LlmClient; egress: Egress },
  o: {
    now: number;
    timeZone?: string;
    jobRunId?: number | null;
    log?: Logger;
    signal?: AbortSignal;
    limit?: number;
    /** Only these occasions (when queued): a targeted re-run. */
    only?: readonly string[];
  },
): Promise<SubmitResult> {
  const log = o.log ?? nullLogger;
  const stats: Record<string, number> = { queued: 0, rendered: 0, skipped_empty: 0, skipped_egress: 0, submitted: 0, unavailable: 0 };
  const { llm, egress } = services;
  if (!llm.configured) return { status: 'skipped', reason: 'no_key', stats };
  const spend = llm.canSpend('steady');
  if (!spend.ok && llm.canSpend('backfill').ok === false) return { status: 'skipped', reason: spend.reason, stats };
  const only = o.only ? new Set(o.only) : null;
  const queue = adjudicationQueue(db, o.now, o.limit).filter((q) => !only || only.has(q.occasionId));
  stats.queued = queue.length;
  if (!queue.length) return { status: 'ok', reason: null, stats };
  const timeZone = o.timeZone ?? settingTimeZone(db);
  const ex = llmExclusions(db);
  const runId = startRun(db, 'nightly', { jobRunId: o.jobRunId ?? null, now: o.now });
  const groups = new Map<BudgetPool, { items: LlmBatchItem[]; rows: { occasionId: string; round: number; customId: string; reason: QueueReason; refs: AdjudicationRefs }[] }>();
  const nextRound = db.prepare('SELECT coalesce(max(round), 0) + 1 FROM occasion_adjudications WHERE occasion_id = ?').pluck();
  const params = llm.params('adjudicate');
  for (const [i, q] of queue.entries()) {
    if (o.signal?.aborted) break;
    let rendered: RenderedPacket | null;
    try {
      rendered = renderPacket(db, egress, q.occasionId, { now: o.now, timeZone, excludedPeople: ex.people, excludedConversations: ex.conversations });
    } catch (e) {
      if (!(e instanceof EgressBlocked)) throw e;
      stats.skipped_egress!++;
      continue;
    }
    if (!rendered) {
      stats.skipped_empty!++;
      continue;
    }
    stats.rendered!++;
    const round = nextRound.get(q.occasionId) as number;
    const pool: BudgetPool = rendered.endsAt < o.now - ADJUDICATION.backfillAfterMs ? 'backfill' : 'steady';
    const cid = customId('calendar', ADJUDICATION_VERSION, `${q.occasionId.replace(/-/g, '')}r${round}`, 0);
    const g = groups.get(pool) ?? { items: [], rows: [] };
    g.items.push({
      customId: cid,
      kind: 'calendar',
      route: 'adjudicate',
      subjectRef: subjectRefOf(q.occasionId, round),
      promptVersion: ADJUDICATION_VERSION,
      system: ADJUDICATION_SYSTEM,
      messages: [{ role: 'user', content: rendered.text }],
      pool,
      estimateUsd: estimateUsd(rendered.text, params),
      runId,
      schema: AdjudicationResult,
    });
    g.rows.push({ occasionId: q.occasionId, round, customId: cid, reason: q.reason, refs: rendered.refs });
    groups.set(pool, g);
    if (i % 10 === 9) await new Promise<void>((r) => setImmediate(r));
  }
  for (const [pool, g] of groups) {
    if (!g.items.length) continue;
    const est = g.items.reduce((s, it) => s + (it.estimateUsd ?? 0), 0);
    const check = llm.canSpend(pool, est);
    if (!check.ok) {
      stats.unavailable! += g.items.length;
      log.info('intel.adjudication_skipped', { counts: { items: g.items.length }, error_class: check.reason });
      continue;
    }
    // Ledger rows first (a result always finds its refs), removed again if the submit doesn't go out.
    tx(db, () => {
      const ins = db.prepare(
        `INSERT INTO occasion_adjudications (occasion_id, round, custom_id, pool, reason, status, refs, submitted_at) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      );
      for (const r of g.rows) ins.run(r.occasionId, r.round, r.customId, pool, r.reason, JSON.stringify(r.refs), o.now);
    });
    const res = await llm.submitBatch(g.items, { purpose: ADJUDICATION_PURPOSE, runId });
    if (res.status !== 'submitted') {
      tx(db, () => {
        const del = db.prepare(`DELETE FROM occasion_adjudications WHERE custom_id = ? AND status = 'submitted'`);
        for (const r of g.rows) del.run(r.customId);
      });
      stats.unavailable! += g.items.length;
      log.info('intel.adjudication_not_submitted', { counts: { items: g.items.length }, error_class: res.reason });
      continue;
    }
    tx(db, () => {
      const mark = db.prepare('UPDATE occasions SET adjudicated_at = ?, llm_request = ? WHERE id = ?');
      for (const r of g.rows) mark.run(o.now, r.customId, r.occasionId);
    });
    stats.submitted! += res.count;
  }
  finishRun(db, runId, 'ok', { summary: { stage: 'intel-adjudicate', ...stats }, now: o.now });
  log.info('intel.adjudication_submitted', { counts: stats });
  return { status: stats.unavailable && !stats.submitted ? 'partial' : 'ok', reason: null, stats };
}

// ---------------------------------------------------------------------------------------------- apply

interface AttRow {
  id: string;
  occasion_id: string;
  person_id: string;
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  evidence: string;
}

interface AdjRow {
  occasion_id: string;
  round: number;
  custom_id: string;
  status: string;
  refs: string;
  submitted_at: number;
}

const COUNTED_STATUSES = new Set(['going', 'attended', 'approved', 'checked_in', 'host']);
const levelOf = (r: Pick<AttRow, 'status' | 'confidence'>): number =>
  COUNTED_STATUSES.has(r.status) && r.confidence >= COUNTED ? 2 : r.status === 'possible' || r.status === 'maybe' || COUNTED_STATUSES.has(r.status) ? 1 : 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function evidenceWith(llm: { conf: number; ev: number[] } | null, previous: string | null): string {
  let prior: unknown[] = [];
  try {
    const p = previous ? (JSON.parse(previous) as unknown) : [];
    if (Array.isArray(p)) prior = p.filter((e) => (e as { t?: unknown })?.t !== 'llm');
  } catch {
    prior = [];
  }
  const own = llm ? [{ t: 'llm', w: r2(llm.conf), ...(llm.ev.length ? { m: llm.ev } : {}) }] : [{ t: 'llm', w: 0 }];
  return JSON.stringify([...own, ...prior]);
}

function finishAdj(db: DB, row: AdjRow, status: 'applied' | 'rejected' | 'failed', result: Record<string, number | string>, now: number) {
  db.prepare('UPDATE occasion_adjudications SET status = ?, result = ?, decided_at = ? WHERE occasion_id = ? AND round = ?').run(
    status,
    JSON.stringify(result),
    now,
    row.occasion_id,
    row.round,
  );
}

function ensureRun(db: DB, runId: string | null, now: number): string {
  if (runId && getRun(db, runId)) return runId;
  const id = startRun(db, 'nightly', { now });
  finishRun(db, id, 'ok', { summary: { stage: 'intel-adjudicate-apply' }, now });
  return id;
}

/**
 * The highest confidence a verdict may give each person on an occasion: anyone named (title, notes, invite,
 * Partiful), a name's or a group's possible people, or already "possible" on messages alone can be raised to any
 * level; a message-only candidate below "possible" (or no longer a candidate) at most to possible (CAPPED).
 */
function verdictCeiling(db: DB, occasionId: string): (personId: string) => number {
  const rows = db.prepare('SELECT kind, person_id, score, signals, alternatives FROM occasion_candidates WHERE occasion_id = ?').all(occasionId) as {
    kind: string;
    person_id: string | null;
    score: number;
    signals: string;
    alternatives: string;
  }[];
  const open = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'person') {
      for (const id of JSON.parse(r.alternatives) as string[]) open.add(visibleCanonical(db, id) ?? id);
      continue;
    }
    const types = (JSON.parse(r.signals) as { t: string }[]).map((x) => x.t as SignalType);
    if (r.person_id && (r.score >= POSSIBLE || types.some((t) => NAMED.has(t)))) open.add(visibleCanonical(db, r.person_id) ?? r.person_id);
  }
  return (personId) => (open.has(personId) ? 1 : CAPPED);
}

/** Applies one adjudication answer (see the module header). 'rejected' when it no longer applies. */
export function applyAdjudication(db: DB, subjectRef: string, value: AdjudicationResult, o: { now: number; runId: string | null }): 'applied' | 'rejected' {
  const ref = parseSubjectRef(subjectRef);
  if (!ref) return 'rejected';
  const row = db.prepare('SELECT * FROM occasion_adjudications WHERE occasion_id = ? AND round = ?').get(ref.occasionId, ref.round) as AdjRow | undefined;
  if (!row) return 'rejected';
  if (row.status === 'applied') return 'applied';
  const refs = JSON.parse(row.refs) as AdjudicationRefs;
  const occId = survivingOccasion(db, ref.occasionId);
  const occ = db.prepare('SELECT id, kind, starts_at, ends_at, status, is_social, sensitive, event_id, classified_by FROM occasions WHERE id = ?').get(occId) as
    | { id: string; kind: string; starts_at: number; ends_at: number | null; status: string; is_social: number | null; sensitive: number; event_id: string | null; classified_by: string | null }
    | undefined;
  if (!occ || occ.status !== 'active' || occ.sensitive === 1 || occ.is_social !== 1) {
    finishAdj(db, row, 'rejected', { reason: 'not_live' }, o.now);
    return 'rejected';
  }
  const tz = settingTimeZone(db);
  const allowed = new Set(refs.messages);
  const verdicts = new Map<string, { role: string; conf: number; ev: number[] }>();
  const rank = (v: { role: string; conf: number }) => (v.role === 'mentioned_only' ? 0 : 10) + v.conf;
  for (const a of value.attendees) {
    const raw = refs.tokens[a.ref];
    const pid = raw ? visibleCanonical(db, raw) : null;
    if (!pid) continue;
    const v = {
      role: a.role,
      conf: clamp01(a.confidence),
      ev: [...new Set(a.evidence_ids.map((e) => /^m:(\d+)$/.exec(e)?.[1]).filter((x): x is string => !!x).map(Number).filter((id) => allowed.has(id)))].slice(0, 20),
    };
    const cur = verdicts.get(pid);
    if (!cur || rank(v) > rank(cur)) verdicts.set(pid, v);
  }
  const attending = [...verdicts.values()].some((v) => v.role !== 'mentioned_only' && v.conf >= POSSIBLE);
  const chain = occasionChain(db, occ.id);
  const rows = db
    .prepare(`SELECT id, occasion_id, person_id, status, role, source, confidence, evidence FROM event_attendees WHERE occasion_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(chain)) as AttRow[];
  const canon = (id: string) => (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(id) as string | undefined) ?? id;
  const day = localDate(occ.starts_at, tz);
  const runId = () => ensureRun(db, o.runId, o.now);
  const counts = { inserted: 0, updated: 0, withdrawn: 0, kept: 0, blocked: 0, reclassified: 0 };

  // "Not a get-together": reclassify (derived) and take back the adjudicator's own rows only. A show he holds tickets
  // to stays social (like a Partiful event); the verdict then only settles its attendees.
  if (!value.is_social && value.kind !== 'social' && !occ.event_id && !attending && !hasLiveTicket(db, occ.id)) {
    const own = rows.filter((r) => r.source === 'llm' && r.status !== 'withdrawn' && r.status !== 'rejected' && !lastChangeWasUndo(db, r.id));
    tx(db, () => {
      if (occ.classified_by !== 'user') {
        db.prepare(`UPDATE occasions SET kind = ?, is_social = 0, classified_by = 'llm', classification_confidence = 0.8, adjudicated_at = coalesce(adjudicated_at, ?), updated_at = ? WHERE id = ?`).run(
          value.kind === 'unknown' ? 'unknown' : value.kind,
          row.submitted_at,
          o.now,
          occ.id,
        );
        counts.reclassified = 1;
      }
      if (own.length) {
        withBatch(
          db,
          { runId: runId(), kind: 'attendee', title: `Not a get-together after all (${day})`, actor: 'agent', confidence: null },
          (t) => {
            for (const r of own) if (t.update('event_attendees', { id: r.id }, { status: 'withdrawn' })) counts.withdrawn++;
          },
          { now: o.now },
        );
      }
      finishAdj(db, row, 'applied', counts, o.now);
    });
    setFlag(db, EFFECTS_DIRTY, o.now, o.now);
    return 'applied';
  }

  const blocked = new Set(rows.filter((r) => r.status === 'rejected').map((r) => canon(r.person_id)));
  const mine = new Map<string, AttRow>();
  for (const r of rows) if (r.occasion_id === occ.id && r.status !== 'rejected' && !mine.has(canon(r.person_id))) mine.set(canon(r.person_id), r);
  const candidateIds = new Set(refs.candidates.map((id) => visibleCanonical(db, id)).filter((x): x is string => !!x));
  const signalsOf = db.prepare('SELECT signals FROM occasion_candidates WHERE occasion_id = ? AND cand_key = ?').pluck();
  const ceiling = verdictCeiling(db, occ.id);
  const ended = (occ.ends_at ?? occ.starts_at) <= o.now;

  type Op = { kind: 'insert'; personId: string; patch: Record<string, unknown> } | { kind: 'update'; row: AttRow; personId: string; patch: Record<string, unknown> };
  const ops: Op[] = [];
  for (const pid of new Set([...candidateIds, ...verdicts.keys()])) {
    if (blocked.has(pid)) {
      counts.blocked++;
      continue;
    }
    const said = verdicts.get(pid) ?? null;
    const v = said && { ...said, conf: Math.min(said.conf, ceiling(pid)) };
    const target = v && v.role !== 'mentioned_only' ? (v.conf >= COUNTED ? 2 : v.conf >= POSSIBLE ? 1 : 0) : 0;
    const row = mine.get(pid);
    const status = target === 2 ? (ended ? 'attended' : 'going') : 'possible';
    if (!row) {
      if (target === 0) continue;
      const prior = (signalsOf.get(occ.id, `p:${pid}`) as string | undefined) ?? null;
      ops.push({ kind: 'insert', personId: pid, patch: { status, role: v!.role, source: 'llm', confidence: r2(v!.conf), evidence: evidenceWith(v, prior) } });
      continue;
    }
    if (row.source === 'user' || row.source === 'legacy' || lastChangeWasUndo(db, row.id)) {
      counts.kept++;
      continue;
    }
    // Explicit invites and Partiful guest-list rows stay the deterministic pass's: the verdict can only raise their
    // status (never withdraw, downgrade or re-source them), so a later RSVP change or removed invite still applies.
    const strong = row.source === 'calendar_explicit' || row.source === 'partiful';
    if (strong) {
      if (target <= levelOf(row)) {
        counts.kept++;
        continue;
      }
      if (row.status === status) {
        counts.kept++;
        continue;
      }
      ops.push({ kind: 'update', row, personId: pid, patch: { status, confidence: r2(Math.max(row.confidence, v!.conf)), evidence: evidenceWith(v, row.evidence) } });
      continue;
    }
    if (target === 0) {
      if (row.status === 'withdrawn') continue;
      ops.push({ kind: 'update', row, personId: pid, patch: { status: 'withdrawn', source: 'llm', evidence: evidenceWith(v, row.evidence) } });
      continue;
    }
    const material = row.status !== status || row.role !== v!.role || row.source !== 'llm' || Math.abs(row.confidence - v!.conf) >= 0.05;
    if (!material) continue;
    ops.push({ kind: 'update', row, personId: pid, patch: { status, role: v!.role, source: 'llm', confidence: r2(v!.conf), evidence: evidenceWith(v, row.evidence) } });
  }
  // the adjudicator's rows left on occasions merged into this one
  for (const r of rows) {
    if (r.occasion_id === occ.id || r.source !== 'llm' || r.status === 'withdrawn' || r.status === 'rejected' || lastChangeWasUndo(db, r.id)) continue;
    ops.push({ kind: 'update', row: r, personId: canon(r.person_id), patch: { status: 'withdrawn' } });
  }

  tx(db, () => {
    if (ops.length) {
      const subjects = [...new Set(ops.map((x) => x.personId))];
      const best = Math.max(0, ...ops.map((x) => Number(x.patch.confidence ?? 0)));
      withBatch(
        db,
        {
          runId: runId(),
          kind: 'attendee',
          title: `Checked who was at a get-together on ${day}`,
          subjectPersonId: subjects.length === 1 ? subjects[0]! : null,
          confidence: best > 0 ? best : null,
          actor: 'agent',
        },
        (t) => {
          const run = runId();
          for (const op of ops) {
            if (op.kind === 'insert') {
              t.insert('event_attendees', { id: uuidv7(o.now), occasion_id: occ.id, person_id: op.personId, ...op.patch, run_id: run });
              counts.inserted++;
            } else if (t.update('event_attendees', { id: op.row.id }, { ...op.patch, run_id: run })) {
              if (op.patch.status === 'withdrawn') counts.withdrawn++;
              else counts.updated++;
            }
          }
        },
        { now: o.now },
      );
    }
    db.prepare('UPDATE occasions SET adjudicated_at = max(coalesce(adjudicated_at, 0), ?), llm_request = ? WHERE id = ?').run(row.submitted_at, row.custom_id, occ.id);
    finishAdj(db, row, 'applied', counts, o.now);
  });
  if (ops.length) setFlag(db, EFFECTS_DIRTY, o.now, o.now);
  return 'applied';
}

/** A request that will never get a usable answer (refused, invalid twice, dead-lettered). */
export function failAdjudication(db: DB, subjectRef: string, why: BatchFailure, now: number): void {
  const ref = parseSubjectRef(subjectRef);
  if (!ref) return;
  const row = db.prepare('SELECT * FROM occasion_adjudications WHERE occasion_id = ? AND round = ?').get(ref.occasionId, ref.round) as AdjRow | undefined;
  if (!row || row.status !== 'submitted') return;
  finishAdj(db, row, 'failed', { reason: why }, now);
}

// ---------------------------------------------------------------------------------------------- consumer

/** Code-side checks the API can't enforce (bounds). Unknown refs are dropped at apply time, not rejected. */
export function validateAdjudication(v: AdjudicationResult): string[] {
  const problems: string[] = [];
  if (v.attendees.length > 100) problems.push('too many attendees');
  for (const a of v.attendees) {
    if (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) problems.push('confidence out of range');
    if (a.evidence_ids.length > 50) problems.push('too many evidence ids');
  }
  return problems;
}

export function adjudicationConsumer(o: { now?: () => number } = {}): BatchConsumer<AdjudicationResult> {
  const now = o.now ?? Date.now;
  return {
    purpose: ADJUDICATION_PURPOSE,
    schema: () => AdjudicationResult,
    validate: (v) => validateAdjudication(v),
    apply: (db: DB, item: StoredBatchItem, value: AdjudicationResult) => applyAdjudication(db, item.subjectRef, value, { now: now(), runId: item.runId }),
    fail: (db: DB, item: StoredBatchItem, why: BatchFailure) => failAdjudication(db, item.subjectRef, why, now()),
  };
}

/** Registers the consumer the llm-collect job hands adjudication results to (idempotent per purpose). */
export function registerAdjudicationConsumer(o: { now?: () => number } = {}): () => void {
  return registerBatchConsumer(adjudicationConsumer(o));
}
