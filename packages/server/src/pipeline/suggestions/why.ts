/**
 * "Why this?" (GET /suggestions/:id/why, `why N` over iMessage) and the read helpers the routes share: people
 * chips through person_visible, evidence refs (short, identifier-free quotes; nothing quoted for sensitive items),
 * template headlines, the history list. Reads only.
 */
import {
  SUGGESTION_KINDS,
  WILDCARD_GENERATORS,
  type EvidenceRef,
  type LearnedFactor,
  type PersonChip,
  type SuggestionKind,
  type SuggestionList,
  type SuggestionListQuery,
  type WhySignal,
  type WhyThis,
  type WildcardGenerator,
} from '@yb/shared';
import type { DB } from '../../db/connection';
import { notFound } from '../../http/errors';
import { KIND_LABEL, readArm, type FactorDetail } from './learner';
import { canonOf, isVisible, PeopleCache, shortName } from './people';
import { armsOfRow } from './rewards';
import { getSuggestion, personIdsOf, type SuggestionRow } from './store';
import { templateHeadline, whySignals, whySummary, type TextInput } from './text';
import { KIND_POLICY, SELECTION } from './types';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|\b\d{10,11}\b/g;

/** A short quote safe to show: no phones or emails, ≤200 chars. */
export function safeQuote(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(EMAIL_RE, '<email>').replace(PHONE_RE, '<phone>').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length <= 200 ? t : `${t.slice(0, 199).trimEnd()}…`;
}

const SOURCE_LABEL: Record<string, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp', beeper: 'Instagram', instagram: 'Instagram', partiful: 'Partiful', calendar: 'Calendar' };
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** People of a suggestion as visible chips (canonical; hidden/merged-away people never appear). */
export function chipsOf(db: DB, r: SuggestionRow, people = new PeopleCache(db)): PersonChip[] {
  const out: PersonChip[] = [];
  for (const id of personIdsOf(r)) {
    const chip = people.chip(canonOf(db, id));
    if (chip && !out.some((c) => c.id === chip.id)) out.push(chip);
  }
  return out;
}

/** Whether the suggestion may be shown at all: its people (if any) are still visible. */
export function rowVisible(db: DB, r: SuggestionRow): boolean {
  const ids = personIdsOf(r);
  return ids.every((id) => isVisible(db, canonOf(db, id)));
}

export function textInputOf(db: DB, r: SuggestionRow, people = new PeopleCache(db)): TextInput {
  const ids = personIdsOf(r).map((id) => canonOf(db, id));
  const infos = ids.map((id) => people.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const circleName = r.circle_id ? ((db.prepare('SELECT name FROM circles WHERE id = ?').pluck().get(r.circle_id) as string | undefined) ?? null) : null;
  return {
    kind: r.kind as SuggestionKind,
    isWildcard: r.is_wildcard === 1,
    wildcardGenerator: (WILDCARD_GENERATORS as readonly string[]).includes(r.wildcard_generator ?? '') ? (r.wildcard_generator as WildcardGenerator) : null,
    names: infos.map(shortName),
    firstNames: infos.map((p) => (p.firstName ?? '').trim() || shortName(p).split(' ')[0]!),
    circleName,
    payload: JSON.parse(r.signals) as Record<string, unknown>,
  };
}

export function headlineOf(db: DB, r: SuggestionRow, people?: PeopleCache): string {
  return r.title ?? templateHeadline(textInputOf(db, r, people));
}

/** Evidence ids → refs (unknown ids are dropped). */
export function evidenceRefs(db: DB, ids: readonly string[], opts: { sensitive: boolean; personId: string | null }): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const ref of ids) {
    if (ref.startsWith('m:')) {
      const id = Number(ref.slice(2));
      if (!Number.isInteger(id)) continue;
      const m = db.prepare('SELECT id, source, sent_at, text FROM messages WHERE id = ?').get(id) as
        | { id: number; source: string; sent_at: number; text: string | null }
        | undefined;
      if (!m) continue;
      out.push({
        kind: 'message',
        ref,
        label: `${SOURCE_LABEL[m.source] ?? m.source} · ${shortDate(m.sent_at)}`,
        at: m.sent_at,
        quote: opts.sensitive ? null : safeQuote(m.text),
        source: m.source,
        href: opts.personId ? `/p/${opts.personId}?m=${m.id}` : null,
      });
    } else if (ref.startsWith('F')) {
      const f = db.prepare('SELECT id, person_id, type, value, sensitive, recorded_at FROM facts WHERE id = ?').get(ref.slice(1)) as
        | { id: string; person_id: string; type: string; value: string; sensitive: number; recorded_at: number }
        | undefined;
      if (!f) continue;
      const hide = opts.sensitive || f.sensitive === 1;
      out.push({
        kind: 'fact',
        ref,
        label: hide ? 'Something personal' : f.type.replace(/_/g, ' '),
        at: f.recorded_at,
        quote: hide ? null : safeQuote(f.value),
        source: null,
        href: `/p/${canonOf(db, f.person_id)}`,
      });
    } else if (ref.startsWith('occ:')) {
      const o = db.prepare('SELECT id, title, starts_at, sensitive FROM occasions WHERE id = ?').get(ref.slice(4)) as
        | { id: string; title: string | null; starts_at: number; sensitive: number }
        | undefined;
      if (!o) continue;
      out.push({
        kind: 'occasion',
        ref,
        label: o.sensitive || opts.sensitive ? 'An event' : (o.title ?? 'An event'),
        at: o.starts_at,
        quote: null,
        source: 'calendar',
        href: `/e/${o.id}`,
      });
    } else if (ref.startsWith('event:')) {
      const e = db.prepare('SELECT id, title, starts_at, source FROM events WHERE id = ?').get(ref.slice(6)) as
        | { id: string; title: string | null; starts_at: number | null; source: string }
        | undefined;
      if (!e) continue;
      out.push({ kind: 'event', ref, label: opts.sensitive ? 'An event' : (e.title ?? 'An event'), at: e.starts_at, quote: null, source: e.source, href: `/e/${e.id}` });
    } else if (ref.startsWith('K')) {
      const k = db.prepare('SELECT id, what, created_at FROM commitments WHERE id = ?').get(ref.slice(1)) as
        | { id: string; what: string; created_at: number }
        | undefined;
      if (!k) continue;
      out.push({ kind: 'commitment', ref, label: 'Promise', at: k.created_at, quote: opts.sensitive ? null : safeQuote(k.what), source: null, href: opts.personId ? `/p/${opts.personId}` : null });
    } else if (ref.startsWith('conv:')) {
      const c = db.prepare('SELECT id, source, kind, title, last_message_at FROM conversations WHERE id = ?').get(ref.slice(5)) as
        | { id: string; source: string; kind: string; title: string | null; last_message_at: number | null }
        | undefined;
      if (!c) continue;
      const label = c.kind === 'group' ? (opts.sensitive ? 'A group chat' : (c.title ?? 'A group chat')) : 'Direct messages';
      out.push({ kind: 'conversation', ref, label, at: c.last_message_at, quote: null, source: c.source, href: opts.personId ? `/p/${opts.personId}` : null });
    }
  }
  return out;
}

const ARM_TYPES = ['kind', 'bucket', 'circle', 'person', 'wildcard'] as const;

function factorsOf(db: DB, r: SuggestionRow, now: number): LearnedFactor[] {
  let details: FactorDetail[] = [];
  if (r.learned_factors) {
    try {
      details = ((JSON.parse(r.learned_factors) as { details?: FactorDetail[] }).details ?? []).filter((d) => (ARM_TYPES as readonly string[]).includes(d.arm));
    } catch {
      details = [];
    }
  }
  if (!details.length) {
    // Never ranked: current posteriors, neutral values.
    details = armsOfRow(db, r).map((a) => {
      const post = readArm(db, a.key, now);
      return { arm: a.arm, key: a.key, label: a.arm === 'kind' ? `${KIND_LABEL[r.kind]} overall` : a.key, value: 1, propensity: post.mean, n: post.n, sampled: false };
    });
  }
  const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  return details.map((d) => ({ arm: d.arm, label: d.label, value: round(d.value), propensity: round(d.propensity, 3), n: round(d.n, 1) }));
}

function adjustmentsOf(r: SuggestionRow): WhySignal[] {
  const out: WhySignal[] = [];
  const kind = r.kind as SuggestionKind;
  const d = r.rank_details ? (JSON.parse(r.rank_details) as Record<string, unknown>) : {};
  out.push({ label: 'Kind weight', value: `×${typeof d.weight === 'number' ? d.weight : KIND_POLICY[kind].weight}` });
  if (d.priority === true) out.push({ label: 'Priority person', value: '×1.3' });
  if (d.party === true) out.push({ label: 'In Party invites', value: `×${1 + SELECTION.partyBoost}` });
  if (d.fatigue === true) out.push({ label: 'In a brief in the last 3 days', value: '×0.5' });
  if (d.penalized === true) out.push({ label: 'Second item of this kind', value: '×0.6' });
  if (d.forced === true) out.push({ label: 'Time-critical', value: 'forced in' });
  if (d.relaxedFloor === true) out.push({ label: 'Quiet day', value: 'lower bar (0.15)' });
  if (Array.isArray(d.merged) && d.merged.length) {
    out.push({ label: 'Also about', value: (d.merged as { kind: SuggestionKind }[]).map((m) => KIND_LABEL[m.kind] ?? m.kind).join(', ') });
  }
  if (d.learnerEnabled === false) out.push({ label: 'Learning', value: 'off' });
  if (d.credit === 'counterfactual') out.push({ label: 'Credit', value: 'none (you were already talking)' });
  const cd = KIND_POLICY[kind].cooldownDays;
  out.push({ label: 'Rests after showing', value: cd === null ? 'shown once' : `${cd} days` });
  return out;
}

/** "Why this?" for a suggestion; 404 when it doesn't exist or its people are no longer visible. */
export function buildWhy(db: DB, suggestionId: string, now = Date.now()): WhyThis {
  const r = getSuggestion(db, suggestionId);
  if (!r || !(SUGGESTION_KINDS as readonly string[]).includes(r.kind) || !rowVisible(db, r)) throw notFound('Suggestion');
  const people = new PeopleCache(db);
  const t = textInputOf(db, r, people);
  const primary = personIdsOf(r)[0] ? canonOf(db, personIdsOf(r)[0]!) : null;
  return {
    suggestionId: r.id,
    kind: r.kind as SuggestionKind,
    summary: whySummary(t),
    base: Math.round((r.base_score ?? 0) * 1000) / 1000,
    score: Math.round(r.score * 1000) / 1000,
    factors: factorsOf(db, r, now),
    signals: whySignals(t.payload),
    evidence: evidenceRefs(db, JSON.parse(r.evidence_ids) as string[], { sensitive: r.sensitive === 1, personId: primary }),
    adjustments: adjustmentsOf(r),
  };
}

// ---------------------------------------------------------------------------------------------- history list

const OPEN = `('candidate','selected','delivered','snoozed')`;

function encodeCursor(r: Pick<SuggestionRow, 'created_at' | 'id'>): string {
  return `${r.created_at}.${r.id}`;
}

export function listSuggestions(db: DB, q: SuggestionListQuery): SuggestionList {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status === 'open') where.push(`status IN ${OPEN}`);
  else if (q.status === 'acted') where.push(`(status = 'done' OR acted_at IS NOT NULL)`);
  if (q.kind) {
    where.push('kind = ?');
    params.push(q.kind);
  }
  if (q.personId) {
    where.push('EXISTS (SELECT 1 FROM json_each(person_ids) j WHERE j.value = ?)');
    params.push(canonOf(db, q.personId));
  }
  let after: { created_at: number; id: string } | null = null;
  const m = q.cursor ? /^(\d{1,15})\.([0-9a-f-]{36})$/i.exec(q.cursor) : null;
  if (m) after = { created_at: Number(m[1]), id: m[2]! };
  // Rows about people who are no longer visible are skipped (never shown): read in batches until the page is full.
  const BATCH = 100;
  const picked: SuggestionRow[] = [];
  for (let guard = 0; guard < 50 && picked.length <= q.limit; guard++) {
    const w = [...where];
    const p = [...params];
    if (after) {
      w.push('(created_at < ? OR (created_at = ? AND id < ?))');
      p.push(after.created_at, after.created_at, after.id);
    }
    const rows = db
      .prepare(`SELECT * FROM suggestions ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${BATCH}`)
      .all(...p) as SuggestionRow[];
    for (const r of rows) {
      if ((SUGGESTION_KINDS as readonly string[]).includes(r.kind) && rowVisible(db, r)) picked.push(r);
      if (picked.length > q.limit) break;
    }
    if (rows.length < BATCH) break;
    after = rows[rows.length - 1]!;
  }
  const page = picked.slice(0, q.limit);
  const people = new PeopleCache(db);
  return {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind as SuggestionKind,
      isWildcard: r.is_wildcard === 1,
      people: chipsOf(db, r, people),
      headline: headlineOf(db, r, people),
      status: r.status,
      score: Math.round(r.score * 1000) / 1000,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at ?? r.selected_at,
      actedAt: r.acted_at,
    })),
    nextCursor: picked.length > q.limit && page.length ? encodeCursor(page[page.length - 1]!) : null,
  };
}
