/**
 * What the extraction pipeline APPLIED from one window, read back from the database (the G1 snapshot and the
 * shadow baseline when the model output was purged): facts, commitments (+ their due dates), relation labels and
 * the needs_reply verdict whose evidence sits on the window's NEW messages. Plus the conversion of a validated
 * window (extraction/validate.ts output) into the same keyed form, so a replay can be compared claim by claim.
 */
import type { DB } from '../db/connection';
import type { ValidatedWindow } from '../extraction';
import { maskText } from '../routes/people';
import type { KeyedPrediction, StoredPrediction } from './types';
import { inList, localDate, normText, shortName, type PersonInfo } from './util';

export const INTEREST_CATS = new Set(['interest', 'activity_pref', 'food_drink']);

const CAT_LABEL: Record<string, string> = {
  interest: 'Interest',
  activity_pref: 'Likes to',
  food_drink: 'Food & drink',
  location_current: 'Lives in',
  location_next: 'Moving to',
  hometown: 'From',
  employer: 'Works at',
  role: 'Role',
  school: 'School',
  pet: 'Pet',
  travel_plan: 'Trip',
  other: 'Note',
  job: 'Job',
  education: 'Education',
  home_location: 'Home',
  address: 'Address',
  relationship_status: 'Relationship',
  family: 'Family',
  preference: 'Preference',
};

const STATE_LABEL: Record<string, string> = {
  needs_reply: 'Needs your reply',
  no_reply_needed: 'No reply needed',
  already_replied: 'Already replied',
};

const OWNER_LABEL: Record<string, string> = { me: 'You owe', them: 'They owe', both: 'Both' };

export const factKey = (personId: string, cat: string, valueNorm: string) => `fact|${personId}|${cat}|${normText(valueNorm)}`;
export const commitmentKey = (personId: string, kind: string, owner: string) => `commitment|${personId}|${kind}|${owner}`;
export const relationKey = (a: string, b: string, label: string) => (a < b ? `relation|${a}|${b}|${label}` : `relation|${b}|${a}|${label}`);
export const needsReplyKey = (state: string) => `needs_reply|${state}`;

export interface PredictionContext {
  db: DB;
  tz: string;
  canon: (id: string) => string;
  visible: (id: string | null | undefined) => PersonInfo | null;
  meId: string | null;
}

const nameOf = (c: PredictionContext, personId: string | null): string => {
  if (!personId) return 'someone';
  if (personId === c.meId) return 'You';
  const p = c.visible(personId);
  return p ? shortName(p) : 'someone';
};

/** Whether a claim about `personId` may be shown (the owner, or a visible person). */
const showable = (c: PredictionContext, personId: string | null): boolean => !personId || personId === c.meId || c.visible(personId) !== null;

const conf2 = (x: number | null | undefined) => (typeof x === 'number' ? x.toFixed(2) : '–');

/** Predictions with evidence on `msgIds` (the window's NEW messages) plus its needs_reply verdict. */
export function appliedPredictions(c: PredictionContext, windowId: string, msgIds: readonly number[]): StoredPrediction[] {
  const db = c.db;
  const out: StoredPrediction[] = [];
  if (msgIds.length) {
    const ids = [...msgIds];
    // ---- facts
    const facts = db
      .prepare(
        `SELECT f.id, f.person_id, f.type, f.value, f.value_norm, f.status, f.confidence, f.sensitive, e.message_id, e.quote
         FROM evidence e JOIN facts f ON f.id = e.subject_id
         WHERE e.subject_type = 'fact' AND e.message_id IN (${inList(ids.length)}) ORDER BY f.created_at, f.id, e.message_id`,
      )
      .all(...ids) as {
      id: string;
      person_id: string;
      type: string;
      value: string;
      value_norm: string;
      status: string;
      confidence: number;
      sensitive: number;
      message_id: number;
      quote: string | null;
    }[];
    const byFact = new Map<string, typeof facts>();
    for (const r of facts) {
      let arr = byFact.get(r.id);
      if (!arr) byFact.set(r.id, (arr = []));
      arr.push(r);
    }
    for (const [id, rows] of byFact) {
      const f = rows[0]!;
      const person = c.canon(f.person_id);
      if (!showable(c, person)) continue;
      out.push({
        id: `f:${id}`,
        kind: 'fact',
        label: `${CAT_LABEL[f.type] ?? f.type}: ${maskText(f.value)}`,
        detail: `${nameOf(c, person)} · ${f.status}${f.sensitive ? ' · sensitive' : ''} · conf ${conf2(f.confidence)}`,
        refs: rows.map((r) => `m:${r.message_id}`),
        m: {
          cat: f.type,
          applied: f.status !== 'candidate',
          subjectId: id,
          personId: person,
          key: factKey(person, f.type, f.value_norm),
          value: f.value_norm,
          conf: f.confidence,
          evidence: rows.map((r) => ({ msgId: r.message_id, quote: r.quote })),
        },
      });
    }
    // ---- commitments (+ due dates)
    const ks = db
      .prepare(
        `SELECT k.id, k.person_id, k.owner, k.kind, k.what, k.due_start, k.due_end, k.due_precision, k.status, k.confidence, e.message_id, e.quote
         FROM evidence e JOIN commitments k ON k.id = e.subject_id
         WHERE e.subject_type = 'commitment' AND e.message_id IN (${inList(ids.length)}) ORDER BY k.created_at, k.id, e.message_id`,
      )
      .all(...ids) as {
      id: string;
      person_id: string;
      owner: string;
      kind: string;
      what: string;
      due_start: number | null;
      due_end: number | null;
      due_precision: string | null;
      status: string;
      confidence: number;
      message_id: number;
      quote: string | null;
    }[];
    const byK = new Map<string, typeof ks>();
    for (const r of ks) {
      let arr = byK.get(r.id);
      if (!arr) byK.set(r.id, (arr = []));
      arr.push(r);
    }
    for (const [id, rows] of byK) {
      const k = rows[0]!;
      const person = c.canon(k.person_id);
      if (!showable(c, person)) continue;
      const refs = rows.map((r) => `m:${r.message_id}`);
      out.push({
        id: `k:${id}`,
        kind: 'commitment',
        label: `${OWNER_LABEL[k.owner] ?? k.owner} · ${k.kind}: ${maskText(k.what)}`,
        detail: `${nameOf(c, person)} · ${k.status} · conf ${conf2(k.confidence)}`,
        refs,
        m: {
          cat: k.kind,
          applied: true,
          subjectId: id,
          personId: person,
          key: commitmentKey(person, k.kind, k.owner),
          value: normText(k.what),
          conf: k.confidence,
          evidence: rows.map((r) => ({ msgId: r.message_id, quote: r.quote })),
        },
      });
      if ((k.due_precision === 'date' || k.due_precision === 'range') && (k.due_start ?? k.due_end) !== null) {
        const start = localDate((k.due_start ?? k.due_end)!, c.tz);
        const end = k.due_precision === 'range' && k.due_end !== null ? localDate(k.due_end, c.tz) : null;
        out.push({
          id: `d:${id}`,
          kind: 'due_date',
          label: `Due ${start}${end && end !== start ? ` – ${end}` : ''}`,
          detail: `for "${maskText(k.what).slice(0, 80)}" · correct if within a day`,
          refs,
          m: { cat: 'due_date', applied: true, subjectId: id, personId: person },
        });
      }
    }
    // ---- relation labels
    const rels = db
      .prepare(
        `SELECT l.id, l.a_id, l.b_id, l.label, l.status, l.confidence, l.sensitive, e.message_id, e.quote
         FROM evidence e JOIN edge_labels l ON l.id = e.subject_id
         WHERE e.subject_type = 'edge_label' AND e.message_id IN (${inList(ids.length)}) ORDER BY l.created_at, l.id, e.message_id`,
      )
      .all(...ids) as {
      id: string;
      a_id: string;
      b_id: string;
      label: string;
      status: string;
      confidence: number;
      sensitive: number;
      message_id: number;
      quote: string | null;
    }[];
    const byR = new Map<string, typeof rels>();
    for (const r of rels) {
      let arr = byR.get(r.id);
      if (!arr) byR.set(r.id, (arr = []));
      arr.push(r);
    }
    for (const [id, rows] of byR) {
      const r = rows[0]!;
      const a = c.canon(r.a_id);
      const b = c.canon(r.b_id);
      if (!showable(c, a) || !showable(c, b)) continue;
      out.push({
        id: `r:${id}`,
        kind: 'relation',
        label: `${nameOf(c, a)} & ${nameOf(c, b)}: ${r.label}`,
        detail: `${r.status}${r.sensitive ? ' · sensitive' : ''} · conf ${conf2(r.confidence)}`,
        refs: rows.map((x) => `m:${x.message_id}`),
        m: {
          cat: r.label,
          applied: r.status === 'active',
          subjectId: id,
          personId: a,
          key: relationKey(a, b, r.label),
          value: r.label,
          conf: r.confidence,
          evidence: rows.map((x) => ({ msgId: x.message_id, quote: x.quote })),
        },
      });
    }
  }
  // ---- needs_reply verdict (the window's own; n_a is not a claim)
  const v = db
    .prepare(`SELECT state, msg_id, reason, urgency, confidence FROM reply_verdicts WHERE window_id = ? AND state <> 'n_a' ORDER BY through_at DESC LIMIT 1`)
    .get(windowId) as { state: string; msg_id: number | null; reason: string | null; urgency: string; confidence: number } | undefined;
  if (v) {
    out.push({
      id: `n:${windowId}`,
      kind: 'needs_reply',
      label: STATE_LABEL[v.state] ?? v.state,
      detail: `${v.reason ?? 'no reason'} · ${v.urgency} · conf ${conf2(v.confidence)}`,
      refs: v.msg_id !== null ? [`m:${v.msg_id}`] : [],
      m: { cat: v.state, applied: true, subjectId: windowId, key: needsReplyKey(v.state), value: v.state, conf: v.confidence },
    });
  }
  return out;
}

/** Stored predictions → keyed claims (facts, commitments, relations, needs_reply; due dates fold into commitments). */
export function keyedFromStored(preds: readonly StoredPrediction[]): KeyedPrediction[] {
  const out: KeyedPrediction[] = [];
  for (const p of preds) {
    if (!p.m.key || (p.kind !== 'fact' && p.kind !== 'commitment' && p.kind !== 'relation' && p.kind !== 'needs_reply')) continue;
    if (p.kind === 'fact' && p.m.applied === false) continue; // candidates aren't claims the owner sees
    out.push({ kind: p.kind, cat: p.m.cat ?? '', personId: p.m.personId ?? null, key: p.m.key, value: p.m.value ?? '', label: p.label, conf: p.m.conf ?? null, refs: p.refs });
  }
  return out;
}

/**
 * A validated window → keyed claims. NOOP / UPDATE assert the (target's / new) value; INVALIDATE ops and held
 * mention facts are not claims about what is true. `factNorm` maps a card fact id to its value_norm.
 */
export function keyedFromValidated(v: ValidatedWindow, canon: (id: string) => string, factNorm: (factId: string) => string | null): KeyedPrediction[] {
  const out: KeyedPrediction[] = [];
  const refs = (ev: readonly { messageId: number }[]) => ev.map((e) => `m:${e.messageId}`);
  for (const f of v.facts) {
    if (f.op === 'INVALIDATE') continue;
    const person = canon(f.personId);
    const norm = f.op === 'NOOP' && f.targetFactId ? (factNorm(f.targetFactId) ?? f.valueNorm) : f.valueNorm;
    out.push({ kind: 'fact', cat: f.cat, personId: person, key: factKey(person, f.cat, norm), value: norm, label: `${CAT_LABEL[f.cat] ?? f.cat}: ${f.value}`, conf: f.conf, refs: refs(f.evidence) });
  }
  for (const k of v.commitments) {
    if (k.status !== 'open') continue;
    const person = canon(k.personId);
    out.push({
      kind: 'commitment',
      cat: k.kind,
      personId: person,
      key: commitmentKey(person, k.kind, k.owner),
      value: normText(k.what),
      label: `${OWNER_LABEL[k.owner] ?? k.owner} · ${k.kind}: ${k.what}`,
      conf: k.conf,
      refs: refs(k.evidence),
    });
  }
  for (const r of v.relations) {
    if (r.op !== 'ADD') continue;
    const a = canon(r.a);
    const b = canon(r.b);
    out.push({ kind: 'relation', cat: r.label, personId: a, key: relationKey(a, b, r.label), value: r.label, label: `relation: ${r.label}`, conf: r.conf, refs: refs(r.evidence) });
  }
  if (v.needsReply && v.needsReply.state !== 'n_a') {
    const s = v.needsReply.state;
    out.push({ kind: 'needs_reply', cat: s, personId: null, key: needsReplyKey(s), value: s, label: STATE_LABEL[s] ?? s, conf: v.needsReply.conf, refs: v.needsReply.messageId !== null ? [`m:${v.needsReply.messageId}`] : [] });
  }
  return out;
}
