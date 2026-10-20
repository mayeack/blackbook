/**
 * Validation of one window's parsed Extraction against its packet (intelligence §4.5 steps 2–7). Pure: no
 * database writes. Everything that fails a check is dropped and counted (counts only, never values).
 *
 *   refs        every Ref is ME, a packet token, or a declared M… mention; msg ids are the window's own; ADD,
 *               UPDATE, NOOP, INVALIDATE, commitments and relations need ≥1 NEW citation (CONTEXT-only items
 *               are dropped); targets / closes exist, belong to the subject and (facts) match the category.
 *   quotes      verbatim against the body AS SENT (NFKC, case, quotes, whitespace, edge punctuation), 3–200 chars;
 *               quotes ≥30 chars also pass at token-set ratio ≥0.9.
 *   plausible   the evidence author is the subject, or it's the subject's 1:1, or the line names them; else −0.2.
 *   dates       the model's due date vs chrono-node on the quote (reference = the message time, forward dates):
 *               >2 days apart with an explicit date in the quote → chrono wins; a due date before the message
 *               date −1 → vague.
 *   exclusions  life events are never facts; identifiers never stored; health/sex/money/breakup → sensitive.
 *   mentions    facts about non-participants apply only through a unique resolution at conf ≥0.8, otherwise
 *               they are held (pending_mention_facts, 30 days).
 *   historical  ADD-only; commitments and needs_reply dropped for messages older than 30 days before as_of.
 *   enums       items schema.ts parseExtraction already dropped for an out-of-set value arrive counted in x.dropped.
 * The confidence gates that pick candidate / tentative / confirmed run at apply time (they need support counts).
 */
import * as chrono from 'chrono-node';
import { DAY_MS, localDateEndMs, localDateToMs, localStamp, tzOffsetMinutes } from './env';
import type { Packet, PacketLine } from './packet';
import { SUMMARY_MAX_CHARS } from './prompt';
import type { CommitmentKind, ExtractedFact, FactCat, ParsedExtraction, RelationLabel } from './schema';
import { checkQuote, isLifeEventText, isSensitiveText, looksLikeIdentifier, lineText, normValue, truncateAtSentence } from './text';

export const GATES = {
  /** interest / activity_pref / food_drink: visible only at ≥0.85 with ≥2 supporting messages (PLAN). */
  interestApply: 0.85,
  /** …or at ≥0.75 once the support spans ≥2 days (a second independent window). */
  interestTentative: 0.75,
  /** location_*, employer, role, school, hometown, pet, travel_plan */
  fact: 0.8,
  other: 0.85,
  relation: 0.85,
  ex: 0.9,
  commitment: 0.7,
  selfId: 0.8,
  /** Facts about people who are only mentioned. */
  mention: 0.8,
  /** Below this nothing is kept; between it and the gate a fact is an invisible candidate. */
  candidateFloor: 0.5,
  plausibilityPenalty: 0.2,
} as const;

export const INTEREST_CATS: ReadonlySet<FactCat> = new Set(['interest', 'activity_pref', 'food_drink']);
export const HISTORICAL_OBLIGATION_MAX_AGE_MS = 30 * DAY_MS;
export const PENDING_MENTION_TTL_MS = 30 * DAY_MS;
export const MAX_VALUE_CHARS = 120;
export const MAX_WHAT_CHARS = 200;
export const MAX_TOPICS = 5;

export interface EvidenceRef {
  messageId: number;
  n: number;
  quote: string;
  at: number;
  role: 'new' | 'context';
}

export interface VFactCore {
  cat: FactCat;
  value: string;
  valueNorm: string;
  validFrom: number | null;
  validTo: number | null;
  sensitive: boolean;
  conf: number;
  evidence: EvidenceRef[];
}

export interface VFact extends VFactCore {
  op: ExtractedFact['op'];
  personId: string;
  targetFactId: string | null;
  /** The subject is not a participant (mentionable or resolved mention). */
  viaMention: boolean;
}

export interface VPendingFact {
  surface: string;
  descriptor: string | null;
  candidates: string[];
  messageId: number;
  fact: VFactCore;
}

export interface VCommitment {
  personId: string;
  otherPersonIds: string[];
  owner: 'me' | 'them' | 'both';
  kind: CommitmentKind;
  what: string;
  dueStart: number | null;
  dueEnd: number | null;
  duePrecision: 'date' | 'range' | 'vague' | 'none';
  status: 'open' | 'done' | 'cancelled';
  closesCommitmentId: string | null;
  conf: number;
  evidence: EvidenceRef[];
  sourceAt: number;
  /** chrono overrode the model's due date */
  dateCorrected: boolean;
}

export interface VNeedsReply {
  /** The message that needs the reply (null for n_a). */
  messageId: number | null;
  /** The window's last NEW message: the verdict describes the conversation as of it. */
  throughMsgId: number;
  state: 'needs_reply' | 'no_reply_needed' | 'already_replied' | 'n_a';
  reason: 'question' | 'request' | 'invitation' | 'plan_confirm' | 'emotional' | 'other' | null;
  urgency: 'low' | 'normal' | 'high';
  conf: number;
}

export interface VRelation {
  op: 'ADD' | 'INVALIDATE';
  a: string;
  b: string;
  label: RelationLabel;
  sensitive: boolean;
  conf: number;
  evidence: EvidenceRef[];
}

export interface VSelfId {
  personId: string;
  identityId: string;
  name: string;
  context: string | null;
  basis: 'self_stated' | 'addressed_by_me' | 'third_party' | 'new_number';
  conf: number;
  evidence: EvidenceRef[];
}

export interface VMention {
  surface: string;
  resolvedPersonId: string | null;
  candidates: string[];
  descriptor: string | null;
  messageId: number | null;
}

export interface ValidatedWindow {
  summary: string | null;
  facts: VFact[];
  pending: VPendingFact[];
  commitments: VCommitment[];
  needsReply: VNeedsReply | null;
  relations: VRelation[];
  selfIds: VSelfId[];
  topics: string[];
  mentions: VMention[];
  dropped: Record<string, number>;
}

/** A historical window whose NEW messages all predate as_of − 30 days: its commitments and needs_reply are dropped. */
export function obligationsTooOld(packet: Pick<Packet, 'mode' | 'asOf' | 'lines'>): boolean {
  return packet.mode === 'historical' && Math.max(...packet.lines.filter((l) => l.role === 'new').map((l) => l.at), 0) < packet.asOf - HISTORICAL_OBLIGATION_MAX_AGE_MS;
}

/** Whether a window sends the obligations request at all (prompt.ts extractionParts): not when they'd be dropped. */
export const needsObligations = (packet: Pick<Packet, 'mode' | 'asOf' | 'lines'>): boolean => !obligationsTooOld(packet);

const MSG_RE = /^m:(\d{1,6})$/;
const okConf = (c: number) => Number.isFinite(c) && c >= 0 && c <= 1;

function nameRe(name: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}])`, 'iu');
}

/** chrono's reading of a quote, as local YYYY-MM-DD dates (reference = the message time in tz). */
export function chronoDates(quote: string, at: number, tz: string): { start: string; end: string | null; explicit: boolean } | null {
  const offset = tzOffsetMinutes(at, tz);
  // A Date whose UTC fields are the local wall clock, parsed at offset 0: components come out as local dates.
  const wall = new Date(at + offset * 60_000);
  let results: chrono.ParsedResult[];
  try {
    results = chrono.parse(quote, { instant: wall, timezone: 0 }, { forwardDate: true });
  } catch {
    return null;
  }
  const r = results[0];
  if (!r) return null;
  const ymd = (c: chrono.ParsedComponents) => {
    const y = c.get('year');
    const mo = c.get('month');
    const d = c.get('day');
    return y && mo && d ? `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  };
  const start = ymd(r.start);
  if (!start) return null;
  const explicit = r.start.isCertain('day') || r.start.isCertain('weekday');
  return { start, end: r.end ? ymd(r.end) : null, explicit };
}

const dayDiff = (a: string, b: string) => Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / DAY_MS;

export function validateExtraction(x: ParsedExtraction, packet: Packet, _o: { now: number } = { now: Date.now() }): ValidatedWindow {
  const dropped: Record<string, number> = { ...x.dropped };
  const drop = (reason: string) => void (dropped[reason] = (dropped[reason] ?? 0) + 1);
  const historical = packet.mode === 'historical';
  const tz = packet.tz;
  const byN = new Map<number, PacketLine>(packet.lines.map((l) => [l.n, l]));
  const tokenOfPerson = new Map<string, string>(Object.entries(packet.refs).map(([t, r]) => [r.personId, t]));
  const participants = new Set(Object.entries(packet.refs).filter(([, r]) => r.role === 'participant').map(([t]) => t));
  const tooOld = obligationsTooOld(packet);

  // ---- evidence
  const evidence = (evs: { msg: string; quote: string }[]): EvidenceRef[] => {
    const out: EvidenceRef[] = [];
    const seen = new Set<number>();
    for (const e of evs) {
      const m = MSG_RE.exec(e.msg.trim());
      const line = m ? byN.get(Number(m[1])) : undefined;
      if (!line) {
        drop('ev_bad_msg');
        continue;
      }
      if (checkQuote(e.quote, line.body) !== 'ok') {
        drop('ev_quote');
        continue;
      }
      if (seen.has(line.n)) continue;
      seen.add(line.n);
      out.push({ messageId: line.msgId, n: line.n, quote: e.quote.trim().slice(0, 200), at: line.at, role: line.role });
    }
    return out;
  };
  const hasNew = (ev: EvidenceRef[]) => ev.some((e) => e.role === 'new');
  const newOnly = (ev: EvidenceRef[]) => ev.filter((e) => e.role === 'new');

  // ---- mentions
  const mentions = new Map<string, VMention>();
  for (const m of x.mentions) {
    const id = m.id.trim();
    if (!/^M\d{1,3}$/.test(id) || mentions.has(id)) {
      drop('mention_bad_id');
      continue;
    }
    const line = MSG_RE.exec(m.msg.trim()) ? byN.get(Number(MSG_RE.exec(m.msg.trim())![1])) : undefined;
    const resolved = m.resolved && packet.refs[m.resolved] ? packet.refs[m.resolved]!.personId : null;
    const candidates = m.candidates.map((c) => packet.refs[c]?.personId).filter((c): c is string => !!c && c !== resolved);
    const surface = lineText(m.surface, 60);
    mentions.set(id, {
      surface,
      resolvedPersonId: resolved,
      candidates,
      descriptor: m.descriptor && !looksLikeIdentifier(m.descriptor) ? lineText(m.descriptor, 80) : null,
      messageId: line?.msgId ?? null,
    });
  }

  type Subject = { kind: 'person'; personId: string; token: string; viaMention: boolean; unique: boolean } | { kind: 'pending'; mention: VMention };
  const subjectOf = (ref: string): Subject | null => {
    const r = ref.trim();
    if (r === 'ME') return packet.meId ? { kind: 'person', personId: packet.meId, token: 'ME', viaMention: false, unique: true } : null;
    if (packet.refs[r]) {
      const viaMention = packet.refs[r]!.role !== 'participant';
      // A mentionable used directly is unique unless a mention for it lists rivals.
      const rival = [...mentions.values()].some((mm) => mm.resolvedPersonId === packet.refs[r]!.personId && mm.candidates.length > 0);
      return { kind: 'person', personId: packet.refs[r]!.personId, token: r, viaMention, unique: !rival };
    }
    const m = mentions.get(r);
    if (!m) return null;
    if (m.resolvedPersonId && m.candidates.length === 0) {
      const token = tokenOfPerson.get(m.resolvedPersonId) ?? r;
      return { kind: 'person', personId: m.resolvedPersonId, token, viaMention: !participants.has(token), unique: true };
    }
    return { kind: 'pending', mention: m };
  };

  const plausible = (s: { personId: string; token: string }, ev: EvidenceRef[]): boolean => {
    if (packet.chat === 'dm' && (s.personId === packet.dmCounterpart || s.token === 'ME')) return true;
    const first = packet.refs[s.token]?.firstName;
    const re = first && first.length >= 2 ? nameRe(first) : null;
    for (const e of ev) {
      const line = byN.get(e.n)!;
      if (line.author === s.token) return true;
      if (re && re.test(line.body)) return true;
      for (const m of mentions.values()) if (m.messageId === line.msgId && m.resolvedPersonId === s.personId) return true;
    }
    return false;
  };

  // ---- facts
  const facts: VFact[] = [];
  const pending: VPendingFact[] = [];
  for (const f of x.facts) {
    if (historical && f.op !== 'ADD') {
      drop('fact_historical_op');
      continue;
    }
    if (!okConf(f.conf)) {
      drop('fact_bad_conf');
      continue;
    }
    const value = lineText(f.value, 400).trim();
    if (!value || value.length > MAX_VALUE_CHARS || looksLikeIdentifier(value)) {
      drop('fact_bad_value');
      continue;
    }
    if (isLifeEventText(value)) {
      drop('fact_excluded');
      continue;
    }
    const ev = evidence(f.ev);
    if (!hasNew(ev)) {
      drop('fact_no_new_evidence');
      continue;
    }
    const sensitive = f.sensitive || isSensitiveText(value) || ev.some((e) => isSensitiveText(e.quote));
    const core: VFactCore = {
      cat: f.cat,
      value,
      valueNorm: normValue(value, f.cat),
      validFrom: localDateToMs(f.valid_from, tz),
      validTo: localDateEndMs(f.valid_to, tz),
      sensitive,
      conf: f.conf,
      evidence: ev,
    };
    if (!core.valueNorm) {
      drop('fact_bad_value');
      continue;
    }
    const s = subjectOf(f.subject);
    if (!s) {
      drop('fact_bad_subject');
      continue;
    }
    if (s.kind === 'pending') {
      if (f.op !== 'ADD' || f.conf < GATES.candidateFloor) {
        drop('fact_pending_unusable');
        continue;
      }
      pending.push({ surface: s.mention.surface, descriptor: s.mention.descriptor, candidates: s.mention.candidates, messageId: ev[0]!.messageId, fact: core });
      continue;
    }
    if (s.token === 'ME' && !ev.some((e) => byN.get(e.n)!.author === 'ME')) {
      drop('fact_me_not_stated');
      continue;
    }
    if (s.viaMention && !s.unique) {
      const m = [...mentions.values()].find((mm) => mm.resolvedPersonId === s.personId);
      if (f.op === 'ADD' && m) pending.push({ surface: m.surface, descriptor: m.descriptor, candidates: [s.personId, ...m.candidates], messageId: ev[0]!.messageId, fact: core });
      else drop('fact_ambiguous_subject');
      continue;
    }
    let targetFactId: string | null = null;
    if (f.op !== 'ADD') {
      const t = f.target ? packet.facts[f.target.trim()] : undefined;
      if (!t || t.personId !== s.personId || t.cat !== f.cat) {
        drop('fact_bad_target');
        continue;
      }
      targetFactId = t.factId;
    }
    let conf = f.conf;
    if (!plausible(s, ev)) conf = Math.max(0, conf - GATES.plausibilityPenalty);
    if (conf < GATES.candidateFloor) {
      drop('fact_low_conf');
      continue;
    }
    facts.push({ ...core, conf, op: f.op, personId: s.personId, targetFactId, viaMention: s.viaMention });
  }

  // ---- commitments
  const commitments: VCommitment[] = [];
  for (const c of x.commitments) {
    if (tooOld) {
      drop('commitment_too_old');
      continue;
    }
    if (!okConf(c.conf) || c.conf < GATES.commitment) {
      drop('commitment_low_conf');
      continue;
    }
    const ev = evidence(c.ev);
    if (!hasNew(ev)) {
      drop('commitment_no_new_evidence');
      continue;
    }
    const firstNew = ev.filter((e) => e.role === 'new').sort((a, b) => a.at - b.at)[0]!;
    if (historical && firstNew.at < packet.asOf - HISTORICAL_OBLIGATION_MAX_AGE_MS) {
      drop('commitment_too_old');
      continue;
    }
    const what = lineText(c.what, 400).trim();
    if (!what || what.length > MAX_WHAT_CHARS || looksLikeIdentifier(what)) {
      drop('commitment_bad_what');
      continue;
    }
    const people: string[] = [];
    for (const w of c.with) {
      const s = subjectOf(w);
      if (s?.kind === 'person' && s.token !== 'ME' && !people.includes(s.personId)) people.push(s.personId);
    }
    if (!people.length) {
      if (packet.chat === 'dm' && packet.dmCounterpart) people.push(packet.dmCounterpart);
      else {
        const author = byN.get(firstNew.n)!.authorPersonId;
        if (author) people.push(author);
      }
    }
    if (!people.length) {
      drop('commitment_no_counterpart');
      continue;
    }
    let closesCommitmentId: string | null = null;
    if (c.status !== 'open') {
      const k = c.closes ? packet.commitments[c.closes.trim()] : undefined;
      if (!k || !people.includes(k.personId)) {
        drop('commitment_bad_close');
        continue;
      }
      closesCommitmentId = k.commitmentId;
    }
    // Dates: the model's, checked against chrono on the quotes (reference = message time).
    let precision = c.due.kind;
    let start = c.due.start;
    let end = c.due.end;
    let dateCorrected = false;
    if (precision === 'date' || precision === 'range') {
      if (!start || localDateToMs(start, tz) === null) {
        precision = 'vague';
        start = end = null;
      }
    } else {
      start = end = null;
    }
    for (const e of ev) {
      const parsed = chronoDates(e.quote, e.at, tz);
      if (!parsed?.explicit) continue;
      if (start && dayDiff(start, parsed.start) > 2) {
        start = parsed.start;
        end = parsed.end;
        precision = end ? 'range' : 'date';
        dateCorrected = true;
      }
      break;
    }
    const msgDate = localStamp(firstNew.at, tz).slice(0, 10);
    if (start && dayDiffSigned(start, msgDate) < -1) {
      precision = 'vague';
      start = end = null;
    }
    const dueStart = start ? localDateToMs(start, tz) : null;
    let dueEnd = end ? localDateEndMs(end, tz) : start ? localDateEndMs(start, tz) : null;
    if (dueStart !== null && dueEnd !== null && dueEnd < dueStart) dueEnd = localDateEndMs(start, tz);
    if (precision === 'range' && !end) precision = 'date';
    commitments.push({
      personId: people[0]!,
      otherPersonIds: people.slice(1),
      owner: c.owner === 'ME' ? 'me' : c.owner === 'THEM' ? 'them' : 'both',
      kind: c.kind,
      what,
      dueStart,
      dueEnd,
      duePrecision: precision,
      status: c.status,
      closesCommitmentId,
      conf: c.conf,
      evidence: ev,
      sourceAt: firstNew.at,
      dateCorrected,
    });
  }

  // ---- needs_reply
  let needsReply: VNeedsReply | null = null;
  const nr = x.needs_reply;
  const newSorted = packet.lines.filter((l) => l.role === 'new').sort((a, b) => a.at - b.at || a.msgId - b.msgId);
  const through = newSorted[newSorted.length - 1];
  if (!nr) {
    // dropped while parsing (counted there)
  } else if (tooOld || !through) {
    if (nr.state !== 'n_a') drop('needs_reply_too_old');
  } else if (!okConf(nr.conf)) {
    drop('needs_reply_bad');
  } else if (nr.state === 'n_a') {
    needsReply = { messageId: null, throughMsgId: through.msgId, state: 'n_a', reason: null, urgency: nr.urgency, conf: nr.conf };
  } else {
    const m = nr.msg ? MSG_RE.exec(nr.msg.trim()) : null;
    const line = m ? byN.get(Number(m[1])) : undefined;
    if (!line || line.role !== 'new' || line.author === 'ME') drop('needs_reply_bad');
    else
      needsReply = {
        messageId: line.msgId,
        throughMsgId: through.msgId,
        state: nr.state,
        reason: nr.state === 'needs_reply' ? (nr.reason ?? 'other') : nr.reason,
        urgency: nr.urgency,
        conf: nr.conf,
      };
  }

  // ---- relations
  const relations: VRelation[] = [];
  for (const r of x.relations) {
    if (historical && r.op !== 'ADD') {
      drop('relation_historical_op');
      continue;
    }
    const gate = r.label === 'ex' ? GATES.ex : GATES.relation;
    if (!okConf(r.conf) || r.conf < gate) {
      drop('relation_low_conf');
      continue;
    }
    const a = subjectOf(r.a);
    const b = subjectOf(r.b);
    if (a?.kind !== 'person' || b?.kind !== 'person' || a.personId === b.personId || !a.unique || !b.unique) {
      drop('relation_bad_ref');
      continue;
    }
    const ev = evidence(r.ev);
    if (!hasNew(ev)) {
      drop('relation_no_new_evidence');
      continue;
    }
    relations.push({ op: r.op, a: a.personId, b: b.personId, label: r.label, sensitive: r.sensitive || r.label === 'ex', conf: r.conf, evidence: ev });
  }

  // ---- self identification
  const selfIds: VSelfId[] = [];
  for (const sid of x.self_id) {
    if (!okConf(sid.conf) || sid.conf < GATES.selfId) {
      drop('self_id_low_conf');
      continue;
    }
    const s = subjectOf(sid.ref);
    if (s?.kind !== 'person' || s.token === 'ME' || !participants.has(s.token)) {
      drop('self_id_bad_ref');
      continue;
    }
    const name = lineText(sid.name, 80).trim();
    if (!name || name.length > 60 || !/\p{L}/u.test(name) || looksLikeIdentifier(name) || /^(?:ME|P[0-9a-z]+)$/.test(name)) {
      drop('self_id_bad_name');
      continue;
    }
    const ev = newOnly(evidence(sid.ev));
    if (!ev.length) {
      drop('self_id_no_new_evidence');
      continue;
    }
    // The identity the name belongs to: the person's own line (stated / new number / introduced), or, when ME
    // greets them in a DM, their identity in this conversation.
    let identityId: string | null = null;
    if (sid.basis === 'addressed_by_me') {
      if (!ev.some((e) => byN.get(e.n)!.author === 'ME')) {
        drop('self_id_bad_basis');
        continue;
      }
      identityId = packet.lines.find((l) => l.author === s.token && l.identityId)?.identityId ?? null;
    } else if (sid.basis === 'third_party') {
      identityId = packet.lines.find((l) => l.author === s.token && l.identityId)?.identityId ?? null;
    } else {
      identityId = ev.map((e) => byN.get(e.n)!).find((l) => l.author === s.token && l.identityId)?.identityId ?? null;
    }
    if (!identityId) {
      drop('self_id_no_identity');
      continue;
    }
    selfIds.push({
      personId: s.personId,
      identityId,
      name,
      context: sid.context && !looksLikeIdentifier(sid.context) ? lineText(sid.context, 60) : null,
      basis: sid.basis,
      conf: sid.conf,
      evidence: ev,
    });
  }

  // ---- topics + summary
  const topics = [
    ...new Set(
      x.topics
        .map((t) => lineText(t, 60).toLowerCase().trim())
        .filter((t) => t.length >= 2 && t.length <= 40 && !looksLikeIdentifier(t) && !isLifeEventText(t)),
    ),
  ].slice(0, MAX_TOPICS);
  let summary: string | null = truncateAtSentence(lineText(x.summary, 4000), SUMMARY_MAX_CHARS) || null;
  if (summary && /<(?:phone|email|handle|addr|num)\b/i.test(summary)) summary = summary.replace(/<(?:phone|email|handle|addr|num)[^>]*>/gi, '').replace(/\s{2,}/g, ' ').trim() || null;

  return { summary, facts, pending, commitments, needsReply, relations, selfIds, topics, mentions: [...mentions.values()], dropped };
}

function dayDiffSigned(a: string, b: string): number {
  return (Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / DAY_MS;
}

/** Quick self-check helper for tests and the eval UI: why items were dropped, as counts. */
export const droppedTotal = (v: ValidatedWindow): number => Object.values(v.dropped).reduce((a, b) => a + b, 0);
