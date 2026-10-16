/**
 * Applying one validated window (intelligence §4.5 steps 6–10): one SQLite transaction and one journal batch per
 * window, so "undo" on the activity feed takes back everything a window taught the agent.
 *
 *   facts          gates pick the status (candidate = invisible; tentative / confirmed = shown):
 *                    interest / activity_pref / food_drink: shown at conf ≥0.85 with ≥2 supporting messages, or
 *                      ≥0.75 once support spans ≥2 days; confirmed at ≥2 messages on ≥2 days, or ≥0.9 (≥2 msgs);
 *                    location_*, employer, role, school, hometown, pet, travel_plan ≥0.80 ('other' ≥0.85);
 *                      confirmed at ≥0.9 or ≥2 messages on ≥2 days;
 *                    people who are only mentioned: at least 0.80;
 *                    0.5 ≤ conf < gate → candidate; a second independent sighting (another day) promotes it.
 *                  ADD dedups on (person, cat, value_norm) or Jaro–Winkler ≥0.92 → evidence + support instead of a
 *                  new row; fact_blocks and rejected rows are never re-added. UPDATE closes the old fact
 *                  (valid_to, superseded_by); INVALIDATE closes it; NOOP adds support. Single-valued categories
 *                  (location_current, employer): a later fact closes the earlier one (chronologically, so
 *                  out-of-order historical windows reconcile).
 *   relations      edge_labels (sticky 'rejected' respected); 'ex' always sensitive.
 *   commitments    the obligations module's upsertCommitmentFromExtraction (same batch).
 *   needs_reply    the obligations module's recordNeedsReplyFromExtraction (same batch).
 *   self_id        alias_obs (source 'self_id'; descriptor 'new_number' for new numbers): feeds the matcher,
 *                  never a direct merge.
 *   mentions       facts about unresolved mentions are held in pending_mention_facts (30 days) and applied when a
 *                  later window in the same conversation resolves the same name uniquely.
 *   summary/topics conversations.summary (tokenized; it is the next window's input), conversation_topics.
 *   watermark      conversations.extract_cursor_msg, windows.status = 'applied'.
 * prompt_version is stored on every row derived here.
 */
import { uuidv7 } from '@yb/shared';
import { normalizeNamePart } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { withBatch, type JournalTx, type Row } from '../journal/batch';
import type { Egress, TokenMap } from '../llm/types';
import { recordNeedsReplyFromExtraction, upsertCommitmentFromExtraction } from '../pipeline/obligations';
import { localStamp, type Env } from './env';
import type { Packet } from './packet';
import type { FactCat } from './schema';
import { isSensitiveText, jaroWinkler, normValue } from './text';
import { GATES, INTEREST_CATS, PENDING_MENTION_TTL_MS, type ValidatedWindow, type VFactCore } from './validate';

export const DEDUP_JW = 0.92;
export const SINGLE_VALUED: ReadonlySet<FactCat> = new Set(['location_current', 'employer']);
const LIVE = ['candidate', 'tentative', 'confirmed'] as const;
type LiveStatus = (typeof LIVE)[number];
const RANK: Record<LiveStatus, number> = { candidate: 0, tentative: 1, confirmed: 2 };

export interface ApplyContext {
  env: Env;
  egress: Egress;
  runId: string;
  now: number;
  /** custom_id of the request the result came from (facts.llm_request), or null for a sync re-run. */
  customId: string | null;
  promptVersion: string;
}

export interface ApplyStats {
  factsAdded: number;
  factsMerged: number;
  factsClosed: number;
  factsBlocked: number;
  candidates: number;
  pendingHeld: number;
  pendingApplied: number;
  relations: number;
  commitments: number;
  commitmentsClosed: number;
  needsReply: number;
  selfIds: number;
  topics: number;
  summary: number;
  batchId: string | null;
}

const emptyStats = (): ApplyStats => ({
  factsAdded: 0,
  factsMerged: 0,
  factsClosed: 0,
  factsBlocked: 0,
  candidates: 0,
  pendingHeld: 0,
  pendingApplied: 0,
  relations: 0,
  commitments: 0,
  commitmentsClosed: 0,
  needsReply: 0,
  selfIds: 0,
  topics: 0,
  summary: 0,
  batchId: null,
});

// ---------------------------------------------------------------------------------------------- gates

/** The status a fact earns from its (max) confidence and support. null = keep nothing. */
export function gateStatus(cat: FactCat, conf: number, support: number, days: number, viaMention = false): LiveStatus | null {
  if (conf < GATES.candidateFloor) return null;
  if (INTEREST_CATS.has(cat)) {
    const shown = support >= 2 && (conf >= GATES.interestApply || (days >= 2 && conf >= GATES.interestTentative));
    if (!shown || (viaMention && conf < GATES.mention)) return 'candidate';
    return days >= 2 || conf >= 0.9 ? 'confirmed' : 'tentative';
  }
  const gate = Math.max(cat === 'other' ? GATES.other : GATES.fact, viaMention ? GATES.mention : 0);
  if (conf >= gate) return conf >= 0.9 || (support >= 2 && days >= 2) ? 'confirmed' : 'tentative';
  // A second independent sighting (another day) of a candidate promotes it.
  return support >= 2 && days >= 2 ? 'tentative' : 'candidate';
}

const maxStatus = (a: LiveStatus, b: LiveStatus): LiveStatus => (RANK[a] >= RANK[b] ? a : b);

// ---------------------------------------------------------------------------------------------- fact helpers

interface FactRow {
  id: string;
  person_id: string;
  type: string;
  value: string;
  value_norm: string;
  sensitive: number;
  confidence: number;
  support: number;
  status: string;
  valid_from: number | null;
  valid_to: number | null;
  superseded_at: number | null;
  retracted_at: number | null;
}

function factsOf(db: DB, personId: string, cat: string): FactRow[] {
  return db
    .prepare(
      `SELECT f.id, f.person_id, f.type, f.value, f.value_norm, f.sensitive, f.confidence, f.support, f.status, f.valid_from, f.valid_to,
              f.superseded_at, f.retracted_at
       FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE pc.canonical_id = ? AND f.type = ? ORDER BY f.created_at`,
    )
    .all(personId, cat) as FactRow[];
}

const isLive = (f: FactRow) => (LIVE as readonly string[]).includes(f.status) && f.superseded_at === null && f.retracted_at === null;
const similarValue = (a: string, b: string) => a === b || jaroWinkler(a, b) >= DEDUP_JW;

function blocked(db: DB, personId: string, cat: string, valueNorm: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM fact_blocks b JOIN person_canon pc ON pc.person_id = b.person_id
         WHERE pc.canonical_id = ? AND b.type = ? AND b.value_norm = ? LIMIT 1`,
      )
      .pluck()
      .get(personId, cat, valueNorm) !== undefined
  );
}

function addEvidence(db: DB, subjectType: string, subjectId: string, ev: { messageId: number; quote: string }[], sensitive: boolean): void {
  const ins = db.prepare('INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote) VALUES (?, ?, ?, ?)');
  for (const e of ev) ins.run(subjectType, subjectId, e.messageId, sensitive ? null : e.quote.slice(0, 200));
}

/** Distinct supporting messages and local days of a fact's evidence; first/last evidence time. */
function support(db: DB, factId: string, tz: string): { messages: number; days: number; firstAt: number | null; lastAt: number | null } {
  const rows = db
    .prepare(`SELECT m.sent_at FROM evidence e JOIN messages m ON m.id = e.message_id WHERE e.subject_type = 'fact' AND e.subject_id = ?`)
    .pluck()
    .all(factId) as number[];
  const days = new Set(rows.map((at) => localStamp(at, tz).slice(0, 10)));
  return { messages: rows.length, days: days.size, firstAt: rows.length ? Math.min(...rows) : null, lastAt: rows.length ? Math.max(...rows) : null };
}

const startOf = (f: { valid_from: number | null }, s: { firstAt: number | null }) => f.valid_from ?? s.firstAt;

interface FactWrite {
  personId: string;
  core: VFactCore;
  viaMention: boolean;
}

type FactOutcome = { kind: 'inserted' | 'merged' | 'candidate'; factId: string; status: LiveStatus } | { kind: 'blocked' | 'skipped'; factId: null };

class FactWriter {
  constructor(
    private readonly t: JournalTx,
    private readonly ctx: ApplyContext,
    private readonly stats: ApplyStats,
    private readonly tokens: TokenMap,
  ) {}

  private get db() {
    return this.t.db;
  }

  /** ADD (also the new half of UPDATE): dedup into a live fact or insert. */
  add(w: FactWrite): FactOutcome {
    const { core } = w;
    const personId = this.ctx.env.canonical(w.personId);
    if (blocked(this.db, personId, core.cat, core.valueNorm)) {
      this.stats.factsBlocked++;
      return { kind: 'blocked', factId: null };
    }
    const all = factsOf(this.db, personId, core.cat);
    if (all.some((f) => f.status === 'rejected' && similarValue(f.value_norm, core.valueNorm))) {
      this.stats.factsBlocked++;
      return { kind: 'blocked', factId: null };
    }
    const match = all.find((f) => isLive(f) && similarValue(f.value_norm, core.valueNorm));
    if (match) return this.merge(match, core, w.viaMention);

    const id = uuidv7(this.ctx.now);
    const ev = core.evidence.map((e) => ({ messageId: e.messageId, quote: e.quote }));
    const sens = core.sensitive;
    const msgs = new Set(ev.map((e) => e.messageId)).size;
    const days = new Set(core.evidence.map((e) => localStamp(e.at, this.ctx.env.tz).slice(0, 10))).size;
    const status = gateStatus(core.cat, core.conf, msgs, days, w.viaMention);
    if (!status) return { kind: 'skipped', factId: null };
    this.t.insert('facts', {
      id,
      person_id: personId,
      type: core.cat,
      value: this.display(core.value),
      value_norm: core.valueNorm,
      sensitive: sens ? 1 : 0,
      confidence: round(core.conf),
      support: msgs,
      status,
      valid_from: core.validFrom,
      valid_to: core.validTo,
      recorded_at: this.ctx.now,
      source: 'llm',
      run_id: this.ctx.runId,
      llm_request: this.ctx.customId,
      prompt_version: this.ctx.promptVersion,
    });
    addEvidence(this.db, 'fact', id, ev, sens);
    if (status === 'candidate') this.stats.candidates++;
    else this.stats.factsAdded++;
    if (status !== 'candidate') this.reconcileSingleValued(personId, core.cat as FactCat, id);
    return { kind: status === 'candidate' ? 'candidate' : 'inserted', factId: id, status };
  }

  /** Evidence + support for an existing live fact; may promote it. */
  merge(f: FactRow, core: VFactCore, viaMention: boolean): FactOutcome {
    const sens = core.sensitive || f.sensitive === 1;
    addEvidence(this.db, 'fact', f.id, core.evidence, sens);
    const s = support(this.db, f.id, this.ctx.env.tz);
    const conf = Math.max(f.confidence, core.conf);
    const earned = gateStatus(core.cat, conf, s.messages, s.days, viaMention) ?? 'candidate';
    const status = maxStatus(f.status as LiveStatus, earned);
    const patch: Row = { support: s.messages, confidence: round(conf), status, prompt_version: this.ctx.promptVersion };
    if (sens && f.sensitive !== 1) patch.sensitive = 1;
    if (f.valid_from === null && core.validFrom !== null) patch.valid_from = core.validFrom;
    if (f.valid_to === null && core.validTo !== null) patch.valid_to = core.validTo;
    this.t.update('facts', { id: f.id }, patch);
    this.stats.factsMerged++;
    if (f.status === 'candidate' && status !== 'candidate') this.reconcileSingleValued(this.ctx.env.canonical(f.person_id), core.cat as FactCat, f.id);
    return { kind: 'merged', factId: f.id, status };
  }

  /** NOOP: the target restated. */
  noop(targetId: string, core: VFactCore, viaMention: boolean): FactOutcome {
    const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(targetId) as FactRow | undefined;
    if (!f || !isLive(f)) return { kind: 'skipped', factId: null };
    return this.merge(f, core, viaMention);
  }

  /** UPDATE: a new value replaces the target (closed once the new value is at least tentative). */
  update(w: FactWrite, targetId: string): FactOutcome {
    const target = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(targetId) as FactRow | undefined;
    if (target && isLive(target) && similarValue(target.value_norm, w.core.valueNorm)) return this.merge(target, w.core, w.viaMention);
    const out = this.add(w);
    // Re-read: adding a single-valued fact may already have closed the target.
    const fresh = target ? (this.db.prepare('SELECT * FROM facts WHERE id = ?').get(target.id) as FactRow | undefined) : undefined;
    if (out.factId && out.status !== 'candidate' && fresh && isLive(fresh) && fresh.id !== out.factId) {
      const at = w.core.validFrom ?? Math.min(...w.core.evidence.filter((e) => e.role === 'new').map((e) => e.at));
      this.close(fresh.id, at, out.factId);
    }
    return out;
  }

  /** INVALIDATE: the target stops being true at the cited message (gate by category). */
  invalidate(targetId: string, core: VFactCore): boolean {
    const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(targetId) as FactRow | undefined;
    if (!f || !isLive(f)) return false;
    const gate = INTEREST_CATS.has(core.cat) ? GATES.interestTentative : core.cat === 'other' ? GATES.other : GATES.fact;
    if (core.conf < gate) return false;
    const at = Math.min(...core.evidence.filter((e) => e.role === 'new').map((e) => e.at));
    this.close(f.id, at, null);
    return true;
  }

  private close(factId: string, validTo: number, supersededBy: string | null): void {
    this.t.update('facts', { id: factId }, {
      status: 'invalidated',
      valid_to: validTo,
      superseded_at: this.ctx.now,
      superseded_by: supersededBy,
    });
    this.stats.factsClosed++;
  }

  /**
   * Single-valued categories: of two live, shown values the one that started later stays current; the earlier
   * one is closed at the later one's start (works for out-of-order historical windows too).
   */
  reconcileSingleValued(personId: string, cat: FactCat, factId: string): void {
    if (!SINGLE_VALUED.has(cat)) return;
    const live = factsOf(this.db, personId, cat).filter((f) => isLive(f) && f.status !== 'candidate');
    if (live.length < 2) return;
    const me = live.find((f) => f.id === factId);
    if (!me) return;
    const tz = this.ctx.env.tz;
    const myStart = startOf(me, support(this.db, me.id, tz)) ?? this.ctx.now;
    for (const other of live) {
      if (other.id === me.id) continue;
      const otherStart = startOf(other, support(this.db, other.id, tz)) ?? 0;
      if (otherStart <= myStart) this.close(other.id, myStart, me.id);
      else {
        this.close(me.id, otherStart, other.id);
        return;
      }
    }
  }

  /** Model text → display text (tokens → names, locally). */
  display(s: string): string {
    return this.ctx.egress.detokenize(s, this.tokens).slice(0, 200);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function tokenMapOf(env: Env, packet: Packet | null): TokenMap {
  const map: TokenMap = {};
  if (packet) for (const [t, r] of Object.entries(packet.refs)) map[t] = { kind: 'person', id: r.personId };
  if (env.meId) map.ME = { kind: 'me', id: env.meId };
  return map;
}

// ---------------------------------------------------------------------------------------------- mentions & aliases

function holdPending(db: DB, packet: Packet, p: ValidatedWindow['pending'][number], now: number, promptVersion: string): void {
  db.prepare(
    `INSERT INTO pending_mention_facts (window_id, conversation_id, surface, descriptor, candidates, fact, message_id, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    packet.windowId,
    packet.conversationId,
    p.surface,
    p.descriptor,
    JSON.stringify(p.candidates),
    JSON.stringify({ ...p.fact, promptVersion }),
    p.messageId,
    now + PENDING_MENTION_TTL_MS,
    now,
    now,
  );
}

const surfaceKey = (s: string) => normalizeNamePart(s).replace(/^(?:my|our|the)\s+/, '');

/** Self-identification → an alias observation (source 'self_id'): the matcher scores it; nothing merges here. */
function recordSelfId(db: DB, s: ValidatedWindow['selfIds'][number], at: number): boolean {
  const norm = normalizeNamePart(s.name);
  if (!norm) return false;
  const descriptor = s.basis === 'new_number' ? 'new_number' : (s.context ?? s.basis).slice(0, 60);
  return (
    db
      .prepare(
        `INSERT INTO alias_obs (identity_id, name_raw, name_norm, descriptor, source, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, 'self_id', ?, ?, 1)
         ON CONFLICT (identity_id, name_norm, source) DO UPDATE SET
           descriptor = CASE WHEN excluded.descriptor = 'new_number' THEN 'new_number' ELSE coalesce(alias_obs.descriptor, excluded.descriptor) END,
           first_seen_at = min(alias_obs.first_seen_at, excluded.first_seen_at),
           seen_count = alias_obs.seen_count + (excluded.last_seen_at > alias_obs.last_seen_at),
           last_seen_at = max(alias_obs.last_seen_at, excluded.last_seen_at)`,
      )
      .run(s.identityId, s.name.slice(0, 80), norm, descriptor, at, at).changes > 0
  );
}

// ---------------------------------------------------------------------------------------------- the window

/** Applies a validated window in one transaction + one journal batch. Marks the window applied. */
export function applyWindow(ctx: ApplyContext, packet: Packet, v: ValidatedWindow): ApplyStats {
  const db = ctx.env.db;
  const env = ctx.env;
  const stats = emptyStats();
  const usable = (id: string) => id === env.meId || !env.excludedPeople.has(env.canonical(id));
  const map = tokenMapOf(env, packet);
  return tx(db, () => {
    {
      const subject = packet.dmCounterpart ? env.canonical(packet.dmCounterpart) : null;
      const r = withBatch(
        db,
        { runId: ctx.runId, kind: 'extraction', title: 'Read a conversation', subjectPersonId: subject, actor: 'agent', confidence: null },
        (t) => {
          const fw = new FactWriter(t, ctx, stats, map);
          // ---- facts
          for (const f of v.facts) {
            if (!usable(f.personId)) continue;
            const w: FactWrite = { personId: f.personId, core: f, viaMention: f.viaMention };
            if (f.op === 'ADD') fw.add(w);
            else if (f.op === 'NOOP' && f.targetFactId) fw.noop(f.targetFactId, f, f.viaMention);
            else if (f.op === 'UPDATE' && f.targetFactId) fw.update(w, f.targetFactId);
            else if (f.op === 'INVALIDATE' && f.targetFactId) fw.invalidate(f.targetFactId, f);
          }
          // ---- held facts about unresolved mentions; earlier held facts this window resolves
          for (const p of v.pending) {
            holdPending(db, packet, p, ctx.now, ctx.promptVersion);
            stats.pendingHeld++;
          }
          for (const m of v.mentions) {
            if (!m.resolvedPersonId || m.candidates.length || !usable(m.resolvedPersonId)) continue;
            const key = surfaceKey(m.surface);
            if (!key) continue;
            const rows = db
              .prepare(`SELECT id, surface, fact FROM pending_mention_facts WHERE conversation_id = ? AND status = 'pending' AND expires_at > ? AND window_id <> ?`)
              .all(packet.conversationId, ctx.now, packet.windowId) as { id: number; surface: string; fact: string }[];
            for (const row of rows) {
              if (surfaceKey(row.surface) !== key) continue;
              const core = JSON.parse(row.fact) as VFactCore;
              const out = fw.add({ personId: m.resolvedPersonId, core: { ...core, valueNorm: core.valueNorm || normValue(core.value, core.cat) }, viaMention: true });
              db.prepare(`UPDATE pending_mention_facts SET status = ?, updated_at = ? WHERE id = ?`).run(out.factId ? 'applied' : 'dropped', ctx.now, row.id);
              if (out.factId) stats.pendingApplied++;
            }
          }
          // ---- relations
          for (const rel of v.relations) {
            const a0 = env.canonical(rel.a);
            const b0 = env.canonical(rel.b);
            if (a0 === b0 || !usable(a0) || !usable(b0)) continue;
            const [a, b] = a0 < b0 ? [a0, b0] : [b0, a0];
            const existing = db.prepare('SELECT id, status, confidence FROM edge_labels WHERE a_id = ? AND b_id = ? AND label = ?').get(a, b, rel.label) as
              | { id: string; status: string; confidence: number }
              | undefined;
            if (rel.op === 'INVALIDATE') {
              if (existing?.status === 'active') {
                t.update('edge_labels', { id: existing.id }, { status: 'rejected', prompt_version: ctx.promptVersion });
                addEvidence(db, 'edge_label', existing.id, rel.evidence, true);
                stats.relations++;
              }
              continue;
            }
            if (existing?.status === 'rejected') continue; // sticky
            if (existing) {
              if (rel.conf > existing.confidence) t.update('edge_labels', { id: existing.id }, { confidence: round(rel.conf), prompt_version: ctx.promptVersion });
              addEvidence(db, 'edge_label', existing.id, rel.evidence, rel.sensitive);
              continue;
            }
            const id = uuidv7(ctx.now);
            t.insert('edge_labels', {
              id,
              a_id: a,
              b_id: b,
              label: rel.label,
              directed: 0,
              sensitive: rel.sensitive ? 1 : 0,
              confidence: round(rel.conf),
              status: 'active',
              origin: 'llm',
              run_id: ctx.runId,
              prompt_version: ctx.promptVersion,
            });
            addEvidence(db, 'edge_label', id, rel.evidence, rel.sensitive);
            stats.relations++;
          }
          // ---- commitments (obligations module, same batch)
          for (const c of v.commitments) {
            if (!usable(c.personId)) continue;
            const what = ctx.egress.detokenize(c.what, map).slice(0, 200);
            const res = upsertCommitmentFromExtraction(t, {
              personId: c.personId,
              otherPersonIds: c.otherPersonIds.filter(usable),
              owner: c.owner,
              kind: c.kind,
              what,
              due: { precision: c.duePrecision, start: c.dueStart, end: c.dueEnd },
              status: c.status,
              closes: c.closesCommitmentId,
              conversationId: packet.conversationId,
              evidence: c.evidence.map((e) => ({ messageId: e.messageId, quote: e.quote })),
              confidence: c.conf,
              sensitive: isSensitiveText(what) || c.evidence.some((e) => isSensitiveText(e.quote)),
              promptVersion: ctx.promptVersion,
              madeAt: c.sourceAt,
              timeZone: env.tz,
            });
            if (res.action === 'inserted' || res.action === 'updated') stats.commitments++;
            else if (res.action === 'closed') stats.commitmentsClosed++;
          }
          // ---- needs_reply (obligations module, same batch)
          if (v.needsReply) {
            const nr = v.needsReply;
            const out = recordNeedsReplyFromExtraction(t, {
              conversationId: packet.conversationId,
              throughMsgId: nr.throughMsgId,
              state: nr.state,
              msgId: nr.messageId,
              reason: nr.reason,
              urgency: nr.urgency,
              confidence: nr.conf,
              windowId: packet.windowId,
              promptVersion: ctx.promptVersion,
            });
            if (out.stored) stats.needsReply++;
          }
        },
        { now: ctx.now },
      );
      stats.batchId = r.changes ? r.batchId : null;
      if (stats.batchId) db.prepare('UPDATE change_batches SET title = ? WHERE id = ?').run(feedTitle(stats), stats.batchId);

      // ---- non-journaled bookkeeping (episodes/derived/system tables), same transaction
      for (const s of v.selfIds) {
        const at = Math.max(...s.evidence.map((e) => e.at));
        if (recordSelfId(db, s, at)) stats.selfIds++;
      }
      const lastNew = packet.lines.filter((l) => l.role === 'new').reduce((m, l) => Math.max(m, l.msgId), 0);
      const lastNewAt = packet.lines.filter((l) => l.role === 'new').reduce((m, l) => Math.max(m, l.at), 0);
      if (v.topics.length) {
        const up = db.prepare(
          `INSERT INTO conversation_topics (conversation_id, topic, seen_count, last_seen_at, prompt_version) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (conversation_id, topic) DO UPDATE SET seen_count = seen_count + 1, last_seen_at = max(last_seen_at, excluded.last_seen_at),
             prompt_version = excluded.prompt_version`,
        );
        for (const topic of v.topics) up.run(packet.conversationId, topic, lastNewAt, ctx.promptVersion);
        stats.topics = v.topics.length;
      }
      if (v.summary) {
        // Steady windows always advance the rolling summary; a historical one only fills in an older/empty one.
        const cur = db
          .prepare(
            `SELECT c.summary_through_msg AS through, m.sent_at AS at FROM conversations c LEFT JOIN messages m ON m.id = c.summary_through_msg WHERE c.id = ?`,
          )
          .get(packet.conversationId) as { through: number | null; at: number | null } | undefined;
        if (packet.mode === 'steady' || !cur?.through || (cur.at ?? 0) < lastNewAt) {
          db.prepare('UPDATE conversations SET summary = ?, summary_through_msg = ?, updated_at = ? WHERE id = ?').run(v.summary, lastNew, ctx.now, packet.conversationId);
          stats.summary = 1;
        }
      }
      db.prepare('UPDATE conversations SET extract_cursor_msg = max(coalesce(extract_cursor_msg, 0), ?) WHERE id = ?').run(lastNew, packet.conversationId);
      db.prepare(`UPDATE windows SET status = 'applied', prompt_version = ?, updated_at = ? WHERE id = ?`).run(ctx.promptVersion, ctx.now, packet.windowId);
      const { batchId: _b, ...counts } = stats;
      db.prepare('UPDATE extraction_packets SET result = ?, updated_at = ? WHERE window_id = ?').run(
        JSON.stringify({ applied: counts, dropped: v.dropped, batchId: stats.batchId }),
        ctx.now,
        packet.windowId,
      );
      return stats;
    }
  });
}

/** Activity-feed line for a window's batch (counts only, never names or content). */
export function feedTitle(s: ApplyStats): string {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => k && parts.push(`${k} ${k === 1 ? one : many}`);
  n(s.factsAdded, 'new fact', 'new facts');
  n(s.factsMerged, 'confirmation', 'confirmations');
  n(s.factsClosed, 'update', 'updates');
  n(s.relations, 'relationship', 'relationships');
  n(s.commitments, 'promise', 'promises');
  n(s.commitmentsClosed, 'promise kept', 'promises kept');
  n(s.needsReply, 'reply check', 'reply checks');
  return parts.length ? `Read a conversation: ${parts.join(', ')}` : 'Read a conversation';
}

/** Expires held mention facts older than 30 days. */
export function expirePendingMentions(db: DB, now: number): number {
  return db.prepare(`UPDATE pending_mention_facts SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(now, now).changes;
}

/**
 * Chronological reconcile (after the historical backfill): for every person with two or more shown values in a
 * single-valued category, the later one closes the earlier one. One journal batch. Returns facts closed.
 */
export function reconcileChronology(ctx: Omit<ApplyContext, 'customId'>, o: { personIds?: readonly string[] } = {}): number {
  const db = ctx.env.db;
  const cats = [...SINGLE_VALUED];
  const rows = db
    .prepare(
      `SELECT pc.canonical_id AS person, f.type AS cat, f.id AS id FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE f.type IN (${cats.map(() => '?').join(',')}) AND f.status IN ('tentative','confirmed') AND f.superseded_at IS NULL AND f.retracted_at IS NULL
       ORDER BY pc.canonical_id, f.type, f.created_at`,
    )
    .all(...cats) as { person: string; cat: FactCat; id: string }[];
  const groups = new Map<string, { person: string; cat: FactCat; ids: string[] }>();
  const only = o.personIds ? new Set(o.personIds.map((p) => ctx.env.canonical(p))) : null;
  for (const r of rows) {
    if (only && !only.has(r.person)) continue;
    const k = `${r.person}|${r.cat}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { person: r.person, cat: r.cat, ids: [] }));
    g.ids.push(r.id);
  }
  const multi = [...groups.values()].filter((g) => g.ids.length > 1);
  if (!multi.length) return 0;
  const stats = emptyStats();
  withBatch(
    db,
    { runId: ctx.runId, kind: 'fact', title: 'Put places and jobs in order', actor: 'agent' },
    (t) => {
      const fw = new FactWriter(t, { ...ctx, customId: null }, stats, tokenMapOf(ctx.env, null));
      for (const g of multi) {
        // Newest start last: reconciling it closes everything that started before it.
        const tz = ctx.env.tz;
        const ordered = g.ids
          .map((id) => {
            const f = db.prepare('SELECT valid_from FROM facts WHERE id = ?').get(id) as { valid_from: number | null };
            return { id, start: startOf(f, support(db, id, tz)) ?? 0 };
          })
          .sort((a, b) => a.start - b.start);
        fw.reconcileSingleValued(g.person, g.cat, ordered[ordered.length - 1]!.id);
      }
    },
    { now: ctx.now },
  );
  return stats.factsClosed;
}
