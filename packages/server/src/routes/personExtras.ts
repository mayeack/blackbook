/**
 * Person page extensions (DTOs in @yb/shared api/person.ts and api/loops.ts; the base /people routes stay in
 * people.ts):
 *
 *   GET    /people/:id/ties                         → TieStats        cadence ring + weekly sparkline
 *   GET    /people/:id/facts                        → PersonFacts     current facts with evidence; history
 *   POST   /people/:id/facts/:factId/wrong          FactWrong → BatchRef   retract + fact_blocks (never re-added)
 *   GET    /people/:id/loops                        → OpenLoopList    reply debts, promises, waiting-on
 *   GET    /people/:id/starters                     → Starters        copy-only drafts (the composer's, else templates)
 *   GET    /people/:id/connections                  → Connections     edges with evidence chips + the mini ego graph
 *   POST   /people/:id/connections/:otherId/wrong   ConnectionWrong → BatchRef   sticky block of one evidence type,
 *                                                                     the relation label, or the whole pair
 *   GET    /people/:id/notes  · POST /people/:id/notes · PATCH /notes/:noteId · DELETE /notes/:noteId (tombstone)
 *   GET    /people/:id/merges                       → MergeHistory    records merged into this person
 *   POST   /people/:id/merges/:mergeId/split        {} → BatchRef     undo of the merge (writes do_not_merge)
 *   GET    /people/:id/collections · POST /people/:id/collections   circles / tags / places membership
 *   GET    /people/:a/with/:b                       → PairView        the pair page
 *   GET    /people/:id/met                          → MetAtList       where the owner met them (intel/metAt links)
 *   POST   /people/:id/met/:linkId/wrong            {} → BatchRef     rejects that link (sticky: never re-created)
 *   GET    /loops?cursor=&limit=                    → OpenLoopList    everyone's (Today's expanded strip)
 *   POST   /loops/:type/:id                         LoopAction → BatchRef
 *
 * People come through person_visible (a merged-away id resolves to its survivor; hidden people answer 404). Every
 * write is the owner's (actor 'user'), one journal batch, undoable from Today. Nothing here calls the LLM or sends
 * anything: starters are drafts with a Copy button and no send path exists. Phones and emails are masked in every
 * title and quote.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  CollectionMembershipEdit,
  ConnectionWrong,
  FactWrong,
  LoopAction,
  NoteCreate,
  NoteUpdate,
  OpenLoopType,
  uuidv7,
  type BatchRef,
  type CollectionChip,
  type Connections,
  type ConnectionEdge,
  type EdgeChip,
  type EdgeLabelView,
  type EdgeTier,
  type EvidenceRef,
  type FactView,
  type MergeHistory,
  type MergeRecord,
  MetAtSignal,
  type MetAtLink,
  type MetAtList,
  type Note,
  type NoteList,
  type NoteWriteResult,
  type OpenLoopList,
  type PairEvidenceItem,
  type PairView,
  type PersonCollections,
  type PersonChip,
  type PersonFacts,
  type Starter,
  type Starters,
  type TieStats,
} from '@yb/shared';
import type { DB } from '../db/connection';
import { badRequest, HttpError, notFound } from '../http/errors';
import { metAtLinksForPerson, targetKeys as metTargetKeys, rejectMetAtLinks } from '../intel/metAt/store';
import { withBatch, type JournalTx } from '../journal/batch';
import { withRun } from '../journal/runs';
import { undoBatch } from '../journal/undo';
import { redact } from '../ops/redact';
import { addMembers, removeMembers, type CollectionKind } from '../pipeline/circles/collections';
import { circleColor } from '../pipeline/circles/run';
import { neighborEdges, pairEvidence, readEdge, rejectEdgeEvidence, type PairEvidenceRow } from '../pipeline/graph/view';
import { EVIDENCE_BLOCK_PREFIX, labelFamily, tierOf } from '../pipeline/graph/weights';
import { refreshEdgeStats } from '../pipeline/graph/run';
import { applyLoopAction, openLoops, personOpenLoops } from '../pipeline/obligations';
import { survivingOccasion } from '../pipeline/occasions/build';
import { shortDate } from '../pipeline/obligations/dates';
import { readTieStats } from '../pipeline/ties/view';
import { settingTimeZone } from '../settings/registry';
import type { RouteDeps } from './index';
import { hiddenNameRedactor, maskText, visiblePerson } from './people';

const DAY = 86_400_000;
const Id = z.string().regex(/^[0-9a-f-]{36}$/i);
const IdParam = z.object({ id: Id });
const PairParams = z.object({ a: Id, b: Id });
const FactParams = z.object({ id: Id, factId: Id });
const OtherParams = z.object({ id: Id, otherId: Id });
const NoteParam = z.object({ noteId: Id });
const MergeParams = z.object({ id: Id, mergeId: Id });
const LoopParams = z.object({ type: OpenLoopType, id: Id });
const MetParams = z.object({ id: Id, linkId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/) });
const LoopsQuery = z.object({ cursor: z.string().regex(/^o\d{1,6}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

const SOURCE_LABELS: Record<string, string> = {
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  beeper: 'Instagram',
  instagram: 'Instagram',
  instagram_dyi: 'Instagram',
  partiful: 'Partiful',
  calendar: 'Calendar',
};
const sourceLabel = (s: string | null) => (s ? (SOURCE_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)) : 'Messages');
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const quoteOf = (text: string | null, max = 160): string | null => (text ? redact(maskText(text), max) : null);

// ---------------------------------------------------------------------------------------------- people

function cluster(db: DB, canonical: string): string[] {
  const ids = db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(canonical) as string[];
  return ids.includes(canonical) ? ids : [canonical, ...ids];
}

function chipFor(db: DB, id: string): PersonChip {
  const r = db
    .prepare('SELECT v.id, v.display_name, v.first_name, s.state FROM person_visible v LEFT JOIN person_stats s ON s.person_id = v.id WHERE v.id = ?')
    .get(id) as { id: string; display_name: string; first_name: string | null; state: PersonChip['state'] } | undefined;
  if (!r) throw notFound('Person');
  return { id: r.id, displayName: maskText(r.display_name), firstName: r.first_name === null ? null : maskText(r.first_name), state: r.state ?? null };
}

function chipsFor(db: DB, ids: readonly string[]): Map<string, PersonChip> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT v.id, v.display_name, v.first_name, s.state FROM person_visible v LEFT JOIN person_stats s ON s.person_id = v.id
       WHERE v.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(ids)])) as { id: string; display_name: string; first_name: string | null; state: PersonChip['state'] }[];
  return new Map(rows.map((r) => [r.id, { id: r.id, displayName: maskText(r.display_name), firstName: r.first_name === null ? null : maskText(r.first_name), state: r.state ?? null }]));
}

/** Runs `fn` in a 'user' run and one journal batch; the batch id, or null when nothing changed. */
function userBatch(db: DB, meta: { kind: string; title: string; subjectPersonId: string | null }, fn: (t: JournalTx) => void, now = Date.now()): string | null {
  return withRun(
    db,
    'user',
    (runId) => {
      const b = withBatch(db, { runId, kind: meta.kind, title: meta.title, subjectPersonId: meta.subjectPersonId, actor: 'user' }, fn, { now });
      return b.changes ? b.batchId : null;
    },
    { now },
  );
}

// ---------------------------------------------------------------------------------------------- ties

export function personTies(db: DB, id: string): TieStats {
  return readTieStats(db, visiblePerson(db, id).id);
}

// ---------------------------------------------------------------------------------------------- facts

interface FactRow {
  id: string;
  person_id: string;
  type: FactView['type'];
  value: string;
  value_norm: string;
  sensitive: number;
  confidence: number;
  support: number;
  status: FactView['status'];
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number;
  retracted_at: number | null;
  superseded_at: number | null;
  source: string;
}

function messageEvidence(db: DB, subjectType: string, subjectId: string, personId: string, sensitive: boolean, tz: string, now: number): EvidenceRef[] {
  const rows = db
    .prepare(
      `SELECT e.message_id, e.quote, m.sent_at, c.source FROM evidence e JOIN messages m ON m.id = e.message_id
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE e.subject_type = ? AND e.subject_id = ? ORDER BY m.sent_at DESC LIMIT 5`,
    )
    .all(subjectType, subjectId) as { message_id: number; quote: string | null; sent_at: number; source: string | null }[];
  return rows.map((r) => ({
    kind: 'message' as const,
    ref: `m:${r.message_id}`,
    label: `${sourceLabel(r.source)} · ${shortDate(r.sent_at, tz, now)}`,
    at: r.sent_at,
    quote: sensitive ? null : quoteOf(r.quote),
    source: r.source,
    href: `/p/${personId}?m=${r.message_id}`,
  }));
}

const isCurrent = (f: FactRow, now: number) =>
  (f.status === 'tentative' || f.status === 'confirmed') && f.retracted_at === null && f.superseded_at === null && (f.valid_to === null || f.valid_to > now);

export function personFacts(db: DB, id: string, now = Date.now()): PersonFacts {
  const p = visiblePerson(db, id);
  const tz = settingTimeZone(db);
  const rows = db
    .prepare(
      `SELECT id, person_id, type, value, value_norm, sensitive, confidence, support, status, valid_from, valid_to, recorded_at, retracted_at,
              superseded_at, source
       FROM facts WHERE person_id IN (SELECT value FROM json_each(?)) AND status <> 'candidate'
       ORDER BY recorded_at DESC, seq DESC LIMIT 400`,
    )
    .all(JSON.stringify(cluster(db, p.id))) as FactRow[];
  const view = (f: FactRow): FactView => ({
    id: f.id,
    type: f.type,
    value: maskText(f.value),
    status: f.status,
    sensitive: f.sensitive === 1,
    confidence: f.confidence,
    support: f.support,
    validFrom: f.valid_from,
    validTo: f.valid_to,
    recordedAt: f.recorded_at,
    retractedAt: f.retracted_at,
    source: f.source,
    evidence: messageEvidence(db, 'fact', f.id, p.id, f.sensitive === 1, tz, now),
  });
  const active = rows.filter((f) => isCurrent(f, now));
  const history = rows.filter((f) => !isCurrent(f, now)).slice(0, 50);
  return {
    active: active.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : b.confidence - a.confidence)).map(view),
    history: history.map(view),
  };
}

/** "Wrong": the fact is retracted and blocked (extraction, imports and `log:` never re-add it). */
export function factWrong(db: DB, id: string, factId: string, body: FactWrong, now = Date.now()): BatchRef {
  const p = visiblePerson(db, id);
  const f = db.prepare('SELECT id, person_id, type, value_norm, status FROM facts WHERE id = ?').get(factId) as
    | { id: string; person_id: string; type: string; value_norm: string; status: string }
    | undefined;
  if (!f || !cluster(db, p.id).includes(f.person_id)) throw notFound('Fact');
  if (f.status === 'rejected') return { batchId: null };
  const batchId = userBatch(
    db,
    { kind: 'fact', title: `Marked a fact about ${maskText(p.display_name)} wrong`, subjectPersonId: p.id },
    (t) => {
      t.tombstone('facts', { id: f.id });
      const block = { person_id: f.person_id, type: f.type, value_norm: f.value_norm };
      if (!t.get('fact_blocks', block)) t.insert('fact_blocks', { ...block, created_at: t.now });
    },
    now,
  );
  // The eval labels read the owner's verdicts from feedback (no free text kept beyond the note he typed).
  db.prepare(
    `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, created_at) VALUES (?, NULL, 'fact', ?, 'wrong', ?, 'web', ?)`,
  ).run(uuidv7(now), f.id, body.note ? JSON.stringify({ note: body.note.slice(0, 500) }) : null, now);
  return { batchId };
}

// ---------------------------------------------------------------------------------------------- starters

interface StarterFact {
  id: string;
  type: string;
  value: string;
  confidence: number;
}

const factRef = (personId: string, f: StarterFact): EvidenceRef => ({
  kind: 'fact',
  ref: `F${f.id}`,
  label: maskText(f.value),
  at: null,
  quote: null,
  source: null,
  href: `/p/${personId}`,
});

/** A short, safe fragment of a fact value for a template ("climbing", "Lisbon"). */
function fragment(v: string, max = 40): string | null {
  const t = maskText(v)
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > max || /[•@]/.test(t)) return null;
  return t;
}

function factStarter(first: string, f: StarterFact): string | null {
  const v = fragment(f.value);
  if (!v) return null;
  switch (f.type) {
    case 'interest':
    case 'activity_pref':
      return `Hey ${first}! Been doing any ${v.toLowerCase()} lately?`;
    case 'location_current':
    case 'home_location':
      return `Hey ${first}, how's life in ${v}?`;
    case 'location_next':
    case 'travel_plan':
      return `${first}! Is the ${v} trip still on? Would love to hear about it.`;
    case 'job':
    case 'role':
    case 'employer':
      return `Hey ${first}, how's work going${f.type === 'employer' ? ` at ${v}` : ''}?`;
    case 'pet':
      return `Hey ${first}! How's the ${v.toLowerCase()} doing?`;
    case 'food_drink':
      return `${first}, found any good ${v.toLowerCase()} spots lately?`;
    case 'school':
    case 'education':
      return `Hey ${first}, how's ${v} going?`;
    default:
      return null;
  }
}

const STARTER_FACT_TYPES = ['interest', 'activity_pref', 'location_next', 'travel_plan', 'location_current', 'home_location', 'job', 'role', 'employer', 'pet', 'food_drink', 'school', 'education'];

export function personStarters(db: DB, id: string, now = Date.now()): Starters {
  const p = visiblePerson(db, id);
  const first = maskText(p.first_name ?? p.nickname ?? p.display_name.split(' ')[0] ?? p.display_name);
  const ids = cluster(db, p.id);
  const json = JSON.stringify(ids);
  const out: Starter[] = [];
  const seen = new Set<string>();
  const push = (s: Starter) => {
    const key = s.text.toLowerCase();
    if (seen.has(key) || s.text.length > 160) return;
    seen.add(key);
    out.push(s);
  };

  // 1. The digest composer's grounded drafts for this person (last 7 days; never for sensitive items).
  const composed = db
    .prepare(
      `SELECT s.id, s.openers, s.evidence_ids FROM suggestions s
       WHERE s.person_id IN (SELECT value FROM json_each(?)) AND s.sensitive = 0 AND s.openers IS NOT NULL AND s.openers <> '[]'
         AND s.updated_at >= ? AND s.status NOT IN ('wrong','superseded')
       ORDER BY s.updated_at DESC LIMIT 3`,
    )
    .all(json, now - 7 * DAY) as { id: string; openers: string; evidence_ids: string }[];
  for (const r of composed) {
    let openers: unknown = [];
    try {
      openers = JSON.parse(r.openers);
    } catch {
      openers = [];
    }
    for (const o of Array.isArray(openers) ? openers : []) {
      if (typeof o !== 'string' || !o.trim()) continue;
      push({ text: maskText(o.trim()), basis: [], source: 'llm' });
    }
  }

  // 2. Templates grounded in what you know (non-sensitive, current facts) and the last event together.
  const facts = db
    .prepare(
      `SELECT id, type, value, confidence FROM facts
       WHERE person_id IN (SELECT value FROM json_each(?)) AND status IN ('tentative','confirmed') AND sensitive = 0
         AND retracted_at IS NULL AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > ?) AND confidence >= 0.6
         AND type IN (SELECT value FROM json_each(?))
       ORDER BY confidence DESC, recorded_at DESC LIMIT 20`,
    )
    .all(json, now, JSON.stringify(STARTER_FACT_TYPES)) as StarterFact[];
  const byType = (t: string[]) => facts.filter((f) => t.includes(f.type));
  for (const group of [['location_next', 'travel_plan'], ['interest', 'activity_pref'], ['location_current', 'home_location'], ['job', 'role', 'employer'], ['pet', 'food_drink', 'school', 'education']]) {
    const f = byType(group)[0];
    if (!f) continue;
    const text = factStarter(first, f);
    if (text) push({ text, basis: [factRef(p.id, f)], source: 'template' });
  }
  const redactTitle = hiddenNameRedactor(db);
  const last = db
    .prepare(
      `SELECT o.id, o.title, o.starts_at FROM occasions o JOIN event_attendees a ON a.occasion_id = o.id
       WHERE a.person_id IN (SELECT value FROM json_each(?)) AND a.status IN ('going','approved','checked_in','attended','host') AND a.confidence >= 0.75
         AND o.status = 'active' AND o.merged_into_id IS NULL AND o.sensitive = 0 AND coalesce(o.is_social, 1) = 1
         AND o.starts_at < ? AND o.starts_at >= ?
       ORDER BY o.starts_at DESC LIMIT 1`,
    )
    .get(json, now, now - 60 * DAY) as { id: string; title: string | null; starts_at: number } | undefined;
  if (last) {
    const title = last.title ? fragment(redactTitle(last.title) ?? '', 40) : null;
    push({
      text: title ? `So fun seeing you at ${title}, ${first}! Let's do it again soon.` : `So good seeing you the other day, ${first}!`,
      basis: [{ kind: 'occasion', ref: `occ:${last.id}`, label: title, at: last.starts_at, quote: null, source: null, href: `/e/${last.id}` }],
      source: 'template',
    });
  }
  const state = db.prepare('SELECT state FROM person_stats WHERE person_id = ?').pluck().get(p.id) as string | undefined;
  push({
    text: state === 'fading' || state === 'dormant' || state === 'cooling' ? `Hey ${first}! It's been a while — how have you been?` : `Hey ${first}, how's your week going?`,
    basis: [],
    source: 'template',
  });
  return { starters: out.slice(0, 5), generatedAt: now, neverSent: true };
}

// ---------------------------------------------------------------------------------------------- edges

interface LabelRow {
  id: string;
  label: string;
  confidence: number;
  origin: 'llm' | 'user' | 'legacy';
  sensitive: number;
}

/** The pair's relation label (never 'ex', never sensitive, never an evidence block row), strongest first. */
function pairLabel(db: DB, a: string, b: string, tz: string, now: number): EdgeLabelView | null {
  const ca = JSON.stringify(cluster(db, a));
  const cb = JSON.stringify(cluster(db, b));
  const rows = db
    .prepare(
      `SELECT id, label, confidence, origin, sensitive FROM edge_labels
       WHERE status = 'active' AND sensitive = 0 AND label NOT LIKE '${EVIDENCE_BLOCK_PREFIX}%'
         AND ((a_id IN (SELECT value FROM json_each(@ca)) AND b_id IN (SELECT value FROM json_each(@cb)))
           OR (a_id IN (SELECT value FROM json_each(@cb)) AND b_id IN (SELECT value FROM json_each(@ca))))
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all({ ca, cb }) as LabelRow[];
  const r = rows.find((x) => labelFamily(x.label) !== 'ex');
  if (!r) return null;
  return { id: r.id, label: labelFamily(r.label), confidence: r.confidence, origin: r.origin, evidence: messageEvidence(db, 'edge_label', r.id, a, false, tz, now) };
}

interface RefInfo {
  ref: EvidenceRef;
  title: string | null;
}

/** An evidence ref ('conv:', 'event:', 'occ:', 'm:') as an EvidenceRef with a masked, hidden-name-safe title. */
function refInfo(db: DB, r: PairEvidenceRow, personId: string, redactTitle: (t: string | null) => string | null, tz: string, now: number): RefInfo {
  const at = r.at;
  const label = (s: string | null) => (s ? clip(redactTitle(s) ?? '', 60) || null : null);
  let m: RegExpExecArray | null;
  if ((m = /^conv:(.+)$/.exec(r.ref))) {
    const c = db.prepare('SELECT title, source FROM conversations WHERE id = ?').get(m[1]) as { title: string | null; source: string } | undefined;
    const title = label(c?.title ?? null);
    return { ref: { kind: 'conversation', ref: r.ref, label: title, at, quote: null, source: c?.source ?? null, href: null }, title };
  }
  if ((m = /^occ:(.+)$/.exec(r.ref))) {
    const o = db.prepare('SELECT title, sensitive FROM occasions WHERE id = ?').get(m[1]) as { title: string | null; sensitive: number } | undefined;
    const title = o && !o.sensitive ? label(o.title) : null;
    return { ref: { kind: 'occasion', ref: r.ref, label: title, at, quote: null, source: 'calendar', href: o && !o.sensitive ? `/e/${m[1]}` : null }, title };
  }
  if ((m = /^event:(.+)$/.exec(r.ref))) {
    const e = db.prepare('SELECT title, source FROM events WHERE id = ?').get(m[1]) as { title: string | null; source: string } | undefined;
    const title = label(e?.title ?? null);
    return { ref: { kind: 'event', ref: r.ref, label: title, at, quote: null, source: e?.source ?? null, href: e ? `/e/${m[1]}` : null }, title };
  }
  if ((m = /^m:(\d{1,15})$/.exec(r.ref))) {
    const msg = db
      .prepare('SELECT m.text, m.sent_at, c.source FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?')
      .get(Number(m[1])) as { text: string | null; sent_at: number; source: string | null } | undefined;
    return {
      ref: {
        kind: 'message',
        ref: r.ref,
        label: msg ? `${sourceLabel(msg.source)} · ${shortDate(msg.sent_at, tz, now)}` : null,
        at: msg?.sent_at ?? at,
        quote: quoteOf(msg?.text ?? null),
        source: msg?.source ?? null,
        href: `/p/${personId}?m=${m[1]}`,
      },
      title: null,
    };
  }
  return { ref: { kind: 'edge', ref: r.ref, label: null, at, quote: null, source: null, href: null }, title: null };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function chipText(type: string, n: number, latestTitle: string | null): string {
  const most = latestTitle ? ` · latest “${latestTitle}”` : '';
  switch (type) {
    case 'co_group':
      return `${plural(n, 'shared group chat')}${most}`;
    case 'group_reply':
      return `${plural(n, 'reply', 'replies')} to each other in groups`;
    case 'co_attend':
      return `${plural(n, 'event')} together${most}`;
    case 'invited_by':
      return `${plural(n, 'invite')} between them`;
    case 'plus_one':
      return `${plural(n, 'plus-one')}`;
    case 'co_host':
      return `Co-hosted ${plural(n, 'event')}${most}`;
    case 'met_via':
      return 'Met through each other';
    case 'mentioned_together':
      return `Mentioned together ${n}×`;
    default:
      return `${type.replace(/_/g, ' ')} · ${n}`;
  }
}

function edgeChips(db: DB, a: string, b: string, rows: PairEvidenceRow[], redactTitle: (t: string | null) => string | null, tz: string, now: number): EdgeChip[] {
  const by = new Map<string, PairEvidenceRow[]>();
  for (const r of rows) by.set(r.type, [...(by.get(r.type) ?? []), r]);
  const chips: EdgeChip[] = [];
  for (const [type, rs] of by) {
    const latest = rs[0]!; // newest first
    const info = refInfo(db, latest, a, redactTitle, tz, now);
    chips.push({ type, text: chipText(type, rs.length, info.title), count: rs.length, latest: info.ref, wrongable: true });
  }
  return chips.sort((x, y) => y.count - x.count || (x.type < y.type ? -1 : 1));
}

export function personConnections(db: DB, id: string, now = Date.now()): Connections {
  const p = visiblePerson(db, id);
  const tz = settingTimeZone(db);
  const redactTitle = hiddenNameRedactor(db);
  const edges = neighborEdges(db, p.id, { minStrength: 0.01, limit: 60 });
  const others = edges.map((e) => (e.a === p.id ? e.b : e.a));
  const chips = chipsFor(db, others);
  const out: ConnectionEdge[] = [];
  for (const e of edges) {
    const other = e.a === p.id ? e.b : e.a;
    const person = chips.get(other);
    if (!person) continue;
    const ev = pairEvidence(db, p.id, other, 200);
    out.push({
      person,
      strength: e.strength,
      tier: e.tier as EdgeTier,
      dominantType: e.dominantType,
      label: pairLabel(db, p.id, other, tz, now),
      chips: edgeChips(db, p.id, other, ev, redactTitle, tz, now),
      lastAt: e.lastAt,
    });
  }
  const shown = new Set(out.map((e) => e.person.id));
  const among = shown.size
    ? (db
        .prepare(
          `SELECT a_id AS a, b_id AS b, strength FROM edge_stats
           WHERE a_id IN (SELECT value FROM json_each(@ids)) AND b_id IN (SELECT value FROM json_each(@ids)) AND strength >= 0.15
           ORDER BY strength DESC LIMIT 300`,
        )
        .all({ ids: JSON.stringify([...shown]) }) as { a: string; b: string; strength: number }[])
    : [];
  return { personId: p.id, edges: out, among };
}

/** Wrong on a connection: one evidence type, the relation label, or (neither) "they don't know each other". */
export function connectionWrong(db: DB, id: string, otherId: string, body: ConnectionWrong, now = Date.now()): BatchRef {
  const p = visiblePerson(db, id);
  const o = visiblePerson(db, otherId);
  if (p.id === o.id) throw badRequest('That is the same person.');
  if (body.labelId) {
    const label = db.prepare('SELECT id, a_id, b_id, status FROM edge_labels WHERE id = ?').get(body.labelId) as
      | { id: string; a_id: string; b_id: string; status: string }
      | undefined;
    const ca = cluster(db, p.id);
    const cb = cluster(db, o.id);
    if (!label || !((ca.includes(label.a_id) && cb.includes(label.b_id)) || (cb.includes(label.a_id) && ca.includes(label.b_id)))) throw notFound('Relationship');
    if (label.status !== 'active') return { batchId: null };
    const batchId = userBatch(
      db,
      { kind: 'edge_label', title: `Removed a relationship between ${maskText(p.display_name)} and ${maskText(o.display_name)}`, subjectPersonId: p.id },
      (t) => void t.tombstone('edge_labels', { id: label.id }),
      now,
    );
    if (batchId) refreshEdgeStats(db, now);
    return { batchId };
  }
  const type = body.type ?? '*';
  if (!/^[a-z_*]{1,30}$/.test(type)) throw badRequest('Unknown evidence type.');
  const batchId = userBatch(
    db,
    {
      kind: 'edge_label',
      title:
        type === '*'
          ? `${maskText(p.display_name)} and ${maskText(o.display_name)} don't know each other`
          : `Not a real connection (${type.replace(/_/g, ' ')}): ${maskText(p.display_name)} and ${maskText(o.display_name)}`,
      subjectPersonId: p.id,
    },
    (t) => void rejectEdgeEvidence(t, p.id, o.id, type, 'user'),
    now,
  );
  if (batchId) refreshEdgeStats(db, now);
  return { batchId };
}

// ---------------------------------------------------------------------------------------------- notes

interface NoteRow {
  id: string;
  person_id: string | null;
  content: string;
  origin: Note['origin'];
  status: string;
  created_at: number;
  updated_at: number;
}

const toNote = (db: DB, r: NoteRow): Note => ({
  id: r.id,
  personId: r.person_id === null ? null : ((db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(r.person_id) as string | undefined) ?? r.person_id),
  content: r.content,
  origin: r.origin,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function personNotes(db: DB, id: string): NoteList {
  const p = visiblePerson(db, id);
  const rows = db
    .prepare(`SELECT * FROM notes WHERE person_id IN (SELECT value FROM json_each(?)) AND status = 'active' ORDER BY created_at DESC, seq DESC LIMIT 500`)
    .all(JSON.stringify(cluster(db, p.id))) as NoteRow[];
  return { notes: rows.map((r) => toNote(db, r)) };
}

export function createNote(db: DB, id: string, body: NoteCreate, now = Date.now()): NoteWriteResult {
  const p = visiblePerson(db, id);
  const noteId = uuidv7(now);
  const batchId = userBatch(
    db,
    { kind: 'note', title: `Added a note on ${maskText(p.display_name)}`, subjectPersonId: p.id },
    (t) => void t.insert('notes', { id: noteId, person_id: p.id, content: body.content, origin: 'user', status: 'active' }),
    now,
  );
  return { note: toNote(db, db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow), batchId };
}

function liveNote(db: DB, noteId: string): NoteRow {
  const r = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
  if (!r || r.status !== 'active') throw notFound('Note');
  if (r.person_id !== null) visiblePerson(db, r.person_id); // a hidden person's notes stay out of reach
  return r;
}

export function updateNote(db: DB, noteId: string, body: NoteUpdate, now = Date.now()): NoteWriteResult {
  const r = liveNote(db, noteId);
  const batchId =
    r.content === body.content
      ? null
      : userBatch(db, { kind: 'note', title: 'Edited a note', subjectPersonId: r.person_id }, (t) => void t.update('notes', { id: noteId }, { content: body.content }), now);
  return { note: toNote(db, db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow), batchId };
}

export function deleteNote(db: DB, noteId: string, now = Date.now()): BatchRef {
  const r = liveNote(db, noteId);
  return { batchId: userBatch(db, { kind: 'note', title: 'Deleted a note', subjectPersonId: r.person_id }, (t) => void t.tombstone('notes', { id: noteId }), now) };
}

// ---------------------------------------------------------------------------------------------- merges

const FAMILY_LABEL: Record<string, string> = { name: 'name', handle: 'IG handle', self_id: 'self-intro', context: 'same city' };
const IDENTITY_LABEL: Record<string, string> = {
  phone: 'same phone',
  email: 'same email',
  whatsapp_jid: 'same WhatsApp',
  whatsapp_lid: 'same WhatsApp',
  instagram_id: 'same Instagram',
  instagram_username: 'same Instagram',
  partiful_user: 'same Partiful profile',
  beeper_user: 'same Instagram',
};

/** Human reasons from a merge's evidence JSON (counts and kinds only). */
export function mergeReasons(raw: string | null): string[] {
  let ev: Record<string, unknown> = {};
  try {
    ev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    ev = {};
  }
  const out: string[] = [];
  const families = Array.isArray(ev.families) ? (ev.families as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  const counts = (ev.counts && typeof ev.counts === 'object' ? ev.counts : {}) as { shared_groups?: number; shared_events?: number };
  for (const f of families) {
    if (f === 'graph') {
      if (counts.shared_groups) out.push(plural(counts.shared_groups, 'shared group'));
      if (counts.shared_events) out.push(plural(counts.shared_events, 'shared event'));
      if (!counts.shared_groups && !counts.shared_events) out.push('shared friends');
    } else if (FAMILY_LABEL[f]) out.push(FAMILY_LABEL[f]!);
  }
  if (typeof ev.identity_kind === 'string') out.push(IDENTITY_LABEL[ev.identity_kind] ?? 'same account');
  if (ev.via === 'addressbook') out.push(ev.cards === 2 ? 'linked Contacts cards' : 'your Contacts');
  if (ev.rule === 'partiful_instagram') out.push('Partiful profile ↔ Instagram');
  if (typeof ev.verdict === 'string' && ev.verdict === 'same') out.push('Claude tie-break');
  return [...new Set(out)];
}

export function personMerges(db: DB, id: string): MergeHistory {
  const p = visiblePerson(db, id);
  const rows = db
    .prepare(
      `SELECT m.*, pm.display_name AS merged_name, pm.is_hidden AS merged_hidden, cb.undone_at AS batch_undone, cb.undoable
       FROM merges m JOIN people pm ON pm.id = m.merged_id JOIN change_batches cb ON cb.id = m.batch_id
       WHERE m.survivor_id IN (SELECT value FROM json_each(?)) ORDER BY m.created_at DESC LIMIT 200`,
    )
    .all(JSON.stringify(cluster(db, p.id))) as {
    id: string;
    merged_id: string;
    method: MergeRecord['method'];
    score: number | null;
    evidence: string | null;
    batch_id: string;
    created_at: number;
    undone_at: number | null;
    merged_name: string;
    merged_hidden: number;
    batch_undone: number | null;
    undoable: number;
  }[];
  return {
    merges: rows
      // A split-off record the owner has since hidden never shows up here (hidden people live in Settings only).
      .filter((r) => !(r.merged_hidden === 1 && r.undone_at !== null))
      .map((r) => ({
        id: r.id,
        merged: { id: r.merged_id, displayName: maskText(r.merged_name) },
        method: r.method,
        score: r.score,
        reasons: mergeReasons(r.evidence),
        batchId: r.batch_id,
        createdAt: r.created_at,
        undoneAt: r.undone_at ?? r.batch_undone,
        canSplit: r.undone_at === null && r.batch_undone === null && r.undoable === 1,
      })),
  };
}

/** Split = undo of the merge batch (the undo handler re-homes evidence and writes do_not_merge). */
export function splitMerge(db: DB, id: string, mergeId: string, now = Date.now()): BatchRef {
  const p = visiblePerson(db, id);
  const m = db.prepare('SELECT survivor_id, batch_id, undone_at FROM merges WHERE id = ?').get(mergeId) as
    | { survivor_id: string; batch_id: string; undone_at: number | null }
    | undefined;
  if (!m || !cluster(db, p.id).includes(m.survivor_id)) throw notFound('Merge');
  if (m.undone_at !== null) throw new HttpError(409, 'ALREADY_UNDONE', 'That merge was already split.');
  const r = undoBatch(db, m.batch_id, { actor: 'user', now });
  return { batchId: r.undone.find((u) => u.batchId === m.batch_id)?.undoBatchId ?? r.undone[0]?.undoBatchId ?? null };
}

// ---------------------------------------------------------------------------------------------- collections

type CircleChip = PersonCollections['circles'][number];

function collectionsOf(db: DB, ids: readonly string[]): PersonCollections {
  const json = JSON.stringify(ids);
  const circles = db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.color_hex, c.icon, min(CASE cm.origin WHEN 'user' THEN 0 WHEN 'legacy' THEN 1 ELSE 2 END) AS o
       FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
       WHERE cm.person_id IN (SELECT value FROM json_each(?)) AND cm.excluded = 0 AND c.status = 'active'
       GROUP BY c.id ORDER BY c.kind = 'auto' DESC, c.name COLLATE NOCASE`,
    )
    .all(json) as { id: string; name: string; kind: 'auto' | 'user'; color_hex: string | null; icon: string | null; o: number }[];
  const tags = db
    .prepare(
      `SELECT DISTINCT t.id, t.name, t.color_hex FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.person_id IN (SELECT value FROM json_each(?)) AND t.status = 'active' ORDER BY t.name COLLATE NOCASE`,
    )
    .all(json) as { id: string; name: string; color_hex: string | null }[];
  const locations = db
    .prepare(
      `SELECT DISTINCT l.id, l.name, l.color_hex, l.icon FROM person_locations pl JOIN locations l ON l.id = pl.location_id
       WHERE pl.person_id IN (SELECT value FROM json_each(?)) AND l.status = 'active' ORDER BY l.name COLLATE NOCASE`,
    )
    .all(json) as { id: string; name: string; color_hex: string | null; icon: string | null }[];
  const ORIGIN = ['user', 'legacy', 'auto'] as const;
  return {
    circles: circles.map(
      (c): CircleChip => ({ type: 'circle', id: c.id, name: maskText(c.name), kind: c.kind, color: c.color_hex, icon: c.icon, origin: ORIGIN[c.o] ?? 'auto' }),
    ),
    tags: tags.map((t): CollectionChip => ({ type: 'tag', id: t.id, name: maskText(t.name), kind: null, color: t.color_hex, icon: null })),
    locations: locations.map((l): CollectionChip => ({ type: 'location', id: l.id, name: maskText(l.name), kind: null, color: l.color_hex, icon: l.icon })),
  };
}

export function personCollections(db: DB, id: string): PersonCollections {
  const p = visiblePerson(db, id);
  return collectionsOf(db, cluster(db, p.id));
}

const TABLE: Record<CollectionKind, 'circles' | 'tags' | 'locations'> = { circle: 'circles', tag: 'tags', location: 'locations' };

/** Adds (by id, or find-or-create by name) and removes this person's circles, tags and places in one batch. */
export function editPersonCollections(db: DB, id: string, edit: CollectionMembershipEdit, now = Date.now()): BatchRef {
  const p = visiblePerson(db, id);
  if (!edit.add.length && !edit.remove.length) return { batchId: null };
  const activeRow = (type: CollectionKind, cid: string) => {
    const r = db.prepare(`SELECT id, status${type === 'circle' ? ', kind' : ''} FROM ${TABLE[type]} WHERE id = ?`).get(cid) as { id: string; status: string } | undefined;
    if (!r || r.status !== 'active') throw notFound(type === 'circle' ? 'Circle' : type === 'tag' ? 'Tag' : 'Location');
    return r.id;
  };
  for (const a of edit.add) if (a.id) activeRow(a.type, a.id);
  for (const r of edit.remove) activeRow(r.type, r.id);
  const n = edit.add.length + edit.remove.length;
  const name = maskText(p.display_name);
  return {
    batchId: userBatch(
      db,
      {
        kind: 'user_edit',
        title: n === 1 ? (edit.add.length ? `Added ${name} to a ${edit.add[0]!.type}` : `Removed ${name} from a ${edit.remove[0]!.type}`) : `Changed ${name}'s circles, tags and places`,
        subjectPersonId: p.id,
      },
      (t) => {
        for (const a of edit.add) {
          const cid = a.id ?? findOrCreate(t, a.type, a.name!);
          addMembers(t, a.type, cid, [p.id], 'user');
        }
        for (const r of edit.remove) removeMembers(t, r.type, r.id, [p.id]);
      },
      now,
    ),
  };
}

/** An active collection with that name (a retracted tag comes back), else a new one (user circles only). */
function findOrCreate(t: JournalTx, type: CollectionKind, name: string): string {
  const db = t.db;
  if (type === 'tag') {
    const same = db.prepare('SELECT id, status FROM tags WHERE name = ? COLLATE NOCASE').get(name) as { id: string; status: string } | undefined;
    if (same) {
      if (same.status !== 'active') t.update('tags', { id: same.id }, { status: 'active' });
      return same.id;
    }
    const id = uuidv7(t.now);
    t.insert('tags', { id, name, color_hex: null, status: 'active' });
    return id;
  }
  if (type === 'location') {
    const same = db.prepare(`SELECT id FROM locations WHERE name = ? COLLATE NOCASE AND status = 'active'`).pluck().get(name) as string | undefined;
    if (same) return same;
    const id = uuidv7(t.now);
    t.insert('locations', { id, name, color_hex: null, icon: null, status: 'active' });
    return id;
  }
  const same = db.prepare(`SELECT id FROM circles WHERE name = ? COLLATE NOCASE AND status = 'active' AND kind = 'user'`).pluck().get(name) as string | undefined;
  if (same) return same;
  const id = uuidv7(t.now);
  t.insert('circles', { id, name, kind: 'user', description: null, color_hex: circleColor(id), icon: null, locked: 0, status: 'active' });
  return id;
}

// ---------------------------------------------------------------------------------------------- pair page

const PAIR_TITLE: Record<string, (title: string | null) => string> = {
  co_group: (t) => (t ? `In the group chat “${t}”` : 'In a group chat together'),
  group_reply: (t) => (t ? `Replied to each other in “${t}”` : 'Replied to each other in a group'),
  co_attend: (t) => (t ? `Both at ${t}` : 'At an event together'),
  invited_by: (t) => (t ? `Invited to ${t}` : 'An invite'),
  plus_one: (t) => (t ? `Plus-one at ${t}` : 'A plus-one'),
  co_host: (t) => (t ? `Co-hosted ${t}` : 'Co-hosted an event'),
  met_via: () => 'Met through each other',
  mentioned_together: () => 'Mentioned together',
};

export function pairView(db: DB, aId: string, bId: string, now = Date.now()): PairView {
  const a = visiblePerson(db, aId);
  const b = visiblePerson(db, bId);
  if (a.id === b.id) throw badRequest('That is the same person.');
  const tz = settingTimeZone(db);
  const redactTitle = hiddenNameRedactor(db);
  const edge = readEdge(db, a.id, b.id);
  const ev = pairEvidence(db, a.id, b.id, 500);
  const label = pairLabel(db, a.id, b.id, tz, now);
  const timeline: PairEvidenceItem[] = ev.slice(0, 100).map((r) => {
    const info = refInfo(db, r, a.id, redactTitle, tz, now);
    return { type: r.type, at: r.at, title: (PAIR_TITLE[r.type] ?? ((t: string | null) => t ?? r.type.replace(/_/g, ' ')))(info.title), quote: info.ref.quote, ref: info.ref };
  });
  if (label) {
    for (const e of label.evidence) {
      timeline.push({ type: 'label', at: e.at, title: `Mentioned as ${label.label.replace(/_/g, ' ')}`, quote: e.quote, ref: e });
    }
  }
  timeline.sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
  const ca = collectionsOf(db, cluster(db, a.id));
  const cb = collectionsOf(db, cluster(db, b.id));
  const all = (c: PersonCollections): CollectionChip[] => [
    ...c.circles.map(({ origin: _o, ...x }) => x),
    ...c.tags,
    ...c.locations,
  ];
  const keyOf = (c: CollectionChip) => `${c.type}:${c.id}`;
  const inB = new Set(all(cb).map(keyOf));
  const inA = new Set(all(ca).map(keyOf));
  const strength = edge?.strength ?? 0;
  const labelIds = db
    .prepare(
      `SELECT id FROM edge_labels WHERE ((a_id IN (SELECT value FROM json_each(@ca)) AND b_id IN (SELECT value FROM json_each(@cb)))
         OR (a_id IN (SELECT value FROM json_each(@cb)) AND b_id IN (SELECT value FROM json_each(@ca))))`,
    )
    .pluck()
    .all({ ca: JSON.stringify(cluster(db, a.id)), cb: JSON.stringify(cluster(db, b.id)) }) as string[];
  const batchIds = labelIds.length
    ? (db
        .prepare(
          `SELECT DISTINCT cl.batch_id FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
           WHERE cl.entity = 'edge_labels' AND cl.entity_key IN (SELECT value FROM json_each(?)) AND cb.undone_at IS NULL AND cb.kind <> 'undo'
           ORDER BY cb.seq DESC LIMIT 20`,
        )
        .pluck()
        .all(JSON.stringify(labelIds)) as string[])
    : [];
  return {
    a: chipFor(db, a.id),
    b: chipFor(db, b.id),
    strength,
    tier: (edge?.tier as EdgeTier | undefined) ?? tierOf(strength),
    weight: edge?.weight ?? 0,
    label,
    chips: edgeChips(db, a.id, b.id, ev, redactTitle, tz, now),
    sharedCircles: {
      both: all(ca).filter((c) => inB.has(keyOf(c))),
      onlyA: all(ca).filter((c) => !inB.has(keyOf(c))),
      onlyB: all(cb).filter((c) => !inA.has(keyOf(c))),
    },
    timeline,
    batchIds,
  };
}

// ---------------------------------------------------------------------------------------------- met at

type MetTarget = Pick<MetAtLink, 'target' | 'title' | 'startsAt' | 'venue' | 'href'>;

/**
 * The happening a met-at link points at, as the person page names it: an occasion resolves to its survivor (title
 * through the hidden-name redactor); a Partiful event that a live occasion now covers is shown as that occasion.
 * Sensitive, missing or undated targets are null (never shown).
 */
function metTarget(db: DB, target: { type: string; id: string }, redactTitle: (t: string | null) => string | null): MetTarget | null {
  const occasion = (id: string): MetTarget | null => {
    const o = db.prepare('SELECT id, title, starts_at, venue_text, sensitive FROM occasions WHERE id = ?').get(survivingOccasion(db, id)) as
      | { id: string; title: string | null; starts_at: number; venue_text: string | null; sensitive: number }
      | undefined;
    if (!o || o.sensitive === 1) return null;
    return { target: { type: 'occasion', id: o.id }, title: redactTitle(o.title), startsAt: o.starts_at, venue: o.venue_text && maskText(o.venue_text), href: `/e/${o.id}` };
  };
  if (target.type === 'occasion') return occasion(target.id);
  if (target.type !== 'event') return null;
  const covering = db
    .prepare(`SELECT id FROM occasions WHERE event_id = ? AND merged_into_id IS NULL AND status IN ('active', 'candidate') ORDER BY starts_at, id LIMIT 1`)
    .pluck()
    .get(target.id) as string | undefined;
  if (covering) return occasion(covering);
  const e = db.prepare('SELECT id, title, starts_at, location_text FROM events WHERE id = ?').get(target.id) as
    | { id: string; title: string | null; starts_at: number | null; location_text: string | null }
    | undefined;
  if (!e || e.starts_at == null) return null;
  return { target: { type: 'event', id: e.id }, title: e.title && maskText(e.title), startsAt: e.starts_at, venue: e.location_text && maskText(e.location_text), href: `/e/${e.id}` };
}

/**
 * Active met-at links of the person (intel/metAt reads every record merged into them), earliest event first: one per
 * happening as the page names it (a Partiful event and the get-together that covers it are one), the surest kept.
 */
export function personMetAt(db: DB, id: string): MetAtList {
  const p = visiblePerson(db, id);
  const redactTitle = hiddenNameRedactor(db);
  const best = new Map<string, MetAtLink>();
  for (const l of metAtLinksForPerson(db, p.id)) {
    const signal = MetAtSignal.safeParse(l.signal);
    const t = signal.success ? metTarget(db, l.target, redactTitle) : null;
    if (!t || !signal.success) continue;
    const link: MetAtLink = { id: l.id, ...t, signal: signal.data, signalAt: l.signalAt, confidence: l.confidence, screenshot: l.screenshot };
    const k = `${t.target.type}:${t.target.id}`;
    const cur = best.get(k);
    if (!cur || link.confidence > cur.confidence || (link.confidence === cur.confidence && link.id < cur.id)) best.set(k, link);
  }
  const links = [...best.values()].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  return { personId: p.id, links };
}

/**
 * "Wrong" on a met-at link: it (and any other active link of the person's records to the same happening) is rejected
 * in one journaled batch, undoable from Today, and never re-created by intel/metAt.
 */
export function metAtWrong(db: DB, id: string, linkId: string, now = Date.now()): BatchRef {
  const p = visiblePerson(db, id);
  const members = cluster(db, p.id);
  type Row = { id: string; person_id: string; status: string; occasion_id: string | null; event_id: string | null };
  const row = db.prepare('SELECT id, person_id, status, occasion_id, event_id FROM person_met_at WHERE id = ?').get(linkId) as Row | undefined;
  if (!row || !members.includes(row.person_id)) throw notFound('Met-at link');
  if (row.status !== 'active') return { batchId: null };
  // The page shows one link per happening; another record of this person (merged in later) may hold its own active
  // link to the same one (its merge chain, or the Partiful event an occasion stands for). "Wrong" means all of them.
  const keys = metTargetKeys(db, row);
  const ids = [
    linkId,
    ...(
      db
        .prepare(`SELECT id, person_id, status, occasion_id, event_id FROM person_met_at WHERE status = 'active' AND id <> ? AND person_id IN (SELECT value FROM json_each(?))`)
        .all(linkId, JSON.stringify(members)) as Row[]
    )
      .filter((r) => [...metTargetKeys(db, r)].some((k) => keys.has(k)))
      .map((r) => r.id),
  ];
  return withRun(
    db,
    'user',
    (runId) => {
      if (!rejectMetAtLinks(db, ids, { runId, actor: 'user', now })) return { batchId: null };
      const batchId = db.prepare('SELECT id FROM change_batches WHERE run_id = ? ORDER BY seq DESC LIMIT 1').pluck().get(runId) as string | undefined;
      return { batchId: batchId ?? null };
    },
    { now },
  );
}

// ---------------------------------------------------------------------------------------------- routes

export function personExtrasRoutes({ db }: RouteDeps): Router {
  const r = Router();
  const tz = () => settingTimeZone(db);

  r.get('/people/:id/ties', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personTies(db, id) satisfies TieStats);
  });

  r.get('/people/:id/facts', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personFacts(db, id) satisfies PersonFacts);
  });

  r.post('/people/:id/facts/:factId/wrong', (req, res) => {
    const { id, factId } = FactParams.parse(req.params);
    res.json(factWrong(db, id, factId, FactWrong.parse(req.body ?? {})) satisfies BatchRef);
  });

  r.get('/people/:id/loops', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const p = visiblePerson(db, id);
    res.json(personOpenLoops(db, p.id, { now: Date.now(), timeZone: tz() }) satisfies OpenLoopList);
  });

  r.get('/people/:id/starters', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personStarters(db, id) satisfies Starters);
  });

  r.get('/people/:id/connections', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personConnections(db, id) satisfies Connections);
  });

  r.post('/people/:id/connections/:otherId/wrong', (req, res) => {
    const { id, otherId } = OtherParams.parse(req.params);
    res.json(connectionWrong(db, id, otherId, ConnectionWrong.parse(req.body ?? {})) satisfies BatchRef);
  });

  r.get('/people/:id/notes', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personNotes(db, id) satisfies NoteList);
  });

  r.post('/people/:id/notes', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(createNote(db, id, NoteCreate.parse(req.body ?? {})) satisfies NoteWriteResult);
  });

  r.patch('/notes/:noteId', (req, res) => {
    const { noteId } = NoteParam.parse(req.params);
    res.json(updateNote(db, noteId, NoteUpdate.parse(req.body ?? {})) satisfies NoteWriteResult);
  });

  r.delete('/notes/:noteId', (req, res) => {
    const { noteId } = NoteParam.parse(req.params);
    res.json(deleteNote(db, noteId) satisfies BatchRef);
  });

  r.get('/people/:id/merges', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personMerges(db, id) satisfies MergeHistory);
  });

  r.post('/people/:id/merges/:mergeId/split', (req, res) => {
    const { id, mergeId } = MergeParams.parse(req.params);
    res.json(splitMerge(db, id, mergeId) satisfies BatchRef);
  });

  r.get('/people/:id/collections', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personCollections(db, id) satisfies PersonCollections);
  });

  r.post('/people/:id/collections', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(editPersonCollections(db, id, CollectionMembershipEdit.parse(req.body ?? {})) satisfies BatchRef);
  });

  r.get('/people/:a/with/:b', (req, res) => {
    const { a, b } = PairParams.parse(req.params);
    res.json(pairView(db, a, b) satisfies PairView);
  });

  r.get('/people/:id/met', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personMetAt(db, id) satisfies MetAtList);
  });

  r.post('/people/:id/met/:linkId/wrong', (req, res) => {
    const { id, linkId } = MetParams.parse(req.params);
    res.json(metAtWrong(db, id, linkId) satisfies BatchRef);
  });

  r.get('/loops', (req, res) => {
    const q = LoopsQuery.parse(req.query);
    res.json(openLoops(db, { cursor: q.cursor ?? null, limit: q.limit, now: Date.now(), timeZone: tz() }) satisfies OpenLoopList);
  });

  r.post('/loops/:type/:id', (req, res) => {
    const { type, id } = LoopParams.parse(req.params);
    const action = LoopAction.parse(req.body ?? {});
    const out = applyLoopAction(db, type, id, action, { channel: 'web', actor: 'user' });
    res.json({ batchId: out.batchId } satisfies BatchRef);
  });

  return r;
}
