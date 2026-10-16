/**
 * Renders a window into the user turn the model sees (intelligence §4.1 line format + §4.2 pseudonymization) and
 * the local packet that maps everything back: m:N → message, P… → person, F…/K… → fact/commitment.
 *
 * Only egress-pseudonymized text goes into the user turn: every message body, card body, title and summary is a
 * section passed through Egress.pseudonymize (phones/emails/handles/addresses/digit runs scrubbed, known last
 * names collapsed to an initial). Line headers carry only window-local ids, local timestamps and person tokens.
 * The bodies AS SENT are stored in the packet, so the quote check runs against exactly what the model saw.
 */
import type { DB } from '../db/connection';
import type { Egress, EgressPerson } from '../llm/types';
import { openCommitmentsForPeople } from '../pipeline/obligations';
import { cardFirstName, localDateToMs, localStamp, type Env } from './env';
import { estimateTokens, SUMMARY_MAX_CHARS } from './prompt';
import { attachmentTokens, lineText, MESSAGE_CHARS, reactionGlyph, truncateAtSentence } from './text';
import { contextMessages, type ConvRow, type Eligibility, type MsgRow, type WindowMode } from './windows';

/*
 * Window size knobs (cost pass 2026-10-16: every window re-sends these, so they are kept tight; NEW is never cut).
 * CONTEXT is for understanding only (nothing is extracted from it): 10 messages / ~500 tokens. The rolling summary
 * goes back in as SUMMARY at ≤800 characters (≈200 tokens). One message line is cut at MESSAGE_CHARS.
 */
export const CONTEXT_MESSAGES = 10;
export const CONTEXT_BUDGET = 500;
export const MAX_CARDS = 8;
export const CARD_FACTS = 6;
export const CARD_COMMITMENTS = 4;
export const CARD_CHARS = 400;
export const MAX_MENTIONABLES = 6;
export const MENTIONABLE_STRENGTH = 0.15;
export const MENTIONABLE_T = 20;
export const SUMMARY_CHARS = SUMMARY_MAX_CHARS;
export { MESSAGE_CHARS };

export interface PacketLine {
  /** window-local message number (m:N) */
  n: number;
  msgId: number;
  role: 'new' | 'context';
  at: number;
  /** 'ME' or a P… token */
  author: string;
  /** canonical person id of the author (null = ME) */
  authorPersonId: string | null;
  identityId: string | null;
  /** the message body exactly as sent (pseudonymized) */
  body: string;
}

export interface PacketRef {
  personId: string;
  role: 'participant' | 'mentionable';
  firstName: string | null;
}

export interface Packet {
  v: 1;
  windowId: string;
  conversationId: string;
  mode: WindowMode;
  chat: 'dm' | 'group';
  memberCount: number;
  asOf: number;
  tz: string;
  meId: string | null;
  dmCounterpart: string | null;
  lines: PacketLine[];
  refs: Record<string, PacketRef>;
  facts: Record<string, { factId: string; personId: string; cat: string; valueNorm: string }>;
  commitments: Record<string, { commitmentId: string; personId: string }>;
}

export interface RenderedWindow {
  packet: Packet;
  userText: string;
  tokens: number;
  /** Lines actually rendered as NEW (0 → nothing to send). */
  newLines: number;
}

interface FactRow {
  id: string;
  person_id: string;
  type: string;
  value: string;
  value_norm: string;
}

interface CommitRow {
  id: string;
  kind: string;
  what: string;
}

const COMMON_WORD_NAMES = new Set([
  'will', 'may', 'june', 'april', 'august', 'mark', 'bill', 'rose', 'grace', 'hope', 'joy', 'faith', 'sunny', 'summer', 'art',
  'max', 'jack', 'pat', 'sue', 'ray', 'dean', 'drew', 'chase', 'hunter', 'page', 'rob', 'sky', 'star', 'king', 'guy', 'lane',
  'reed', 'wade', 'cash', 'miles', 'frank', 'honey', 'love', 'baby', 'angel', 'crystal', 'amber', 'ivy', 'dawn', 'eve', 'kit',
]);

function activeFacts(db: DB, personId: string, limit: number): FactRow[] {
  return db
    .prepare(
      `SELECT f.id, f.person_id, f.type, f.value, f.value_norm FROM facts f
       JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE pc.canonical_id = ? AND f.status IN ('tentative','confirmed') AND f.retracted_at IS NULL AND f.superseded_at IS NULL
         AND f.sensitive = 0
       ORDER BY f.status = 'confirmed' DESC, f.support DESC, f.updated_at DESC LIMIT ?`,
    )
    .all(personId, limit) as FactRow[];
}

/** Open commitments with a person for their card (the obligations module's live set; never sensitive ones). */
function openCommitments(db: DB, personId: string, limit: number): CommitRow[] {
  return openCommitmentsForPeople(db, [personId])
    .filter((c) => !c.sensitive)
    .slice(0, limit)
    .map((c) => ({ id: c.id, kind: c.kind, what: c.what }));
}

function cityOf(db: DB, personId: string): string | null {
  return (
    (db
      .prepare(
        `SELECT f.value FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
         WHERE pc.canonical_id = ? AND f.type IN ('location_current','home_location') AND f.status IN ('tentative','confirmed')
           AND f.retracted_at IS NULL AND f.superseded_at IS NULL AND f.sensitive = 0
         ORDER BY f.updated_at DESC LIMIT 1`,
      )
      .pluck()
      .get(personId) as string | undefined) ?? null
  );
}

function circleOf(db: DB, personId: string): string | null {
  return (
    (db
      .prepare(
        `SELECT c.name FROM circle_members cm JOIN circles c ON c.id = cm.circle_id JOIN person_canon pc ON pc.person_id = cm.person_id
         WHERE pc.canonical_id = ? AND cm.excluded = 0 AND c.status = 'active' ORDER BY cm.score DESC LIMIT 1`,
      )
      .pluck()
      .get(personId) as string | undefined) ?? null
  );
}

/** First-name / nickname index over visible people (lowercase name → canonical ids). Built once per run. */
export class NameIndex {
  private idx: Map<string, string[]> | null = null;
  constructor(private readonly env: Env) {}
  lookup(word: string): string[] {
    if (!this.idx) {
      this.idx = new Map();
      const rows = this.env.db.prepare('SELECT id, first_name, nickname FROM person_visible').all() as {
        id: string;
        first_name: string | null;
        nickname: string | null;
      }[];
      for (const r of rows) {
        for (const n of [r.first_name, r.nickname]) {
          const k = n?.trim().toLowerCase();
          if (!k || k.length < 3 || COMMON_WORD_NAMES.has(k) || /\s/.test(k)) continue;
          let arr = this.idx.get(k);
          if (!arr) this.idx.set(k, (arr = []));
          const c = this.env.canonical(r.id);
          if (!arr.includes(c)) arr.push(c);
        }
      }
    }
    return this.idx.get(word.toLowerCase()) ?? [];
  }
}

/** Mentionables: known people named in NEW text, tied (strength ≥0.15) to a participant, or T ≥20, or priority. */
function mentionables(env: Env, names: NameIndex, newText: string, participants: Set<string>): string[] {
  const words = new Set((newText.match(/\p{L}[\p{L}'’-]{2,}/gu) ?? []).map((w) => w.toLowerCase()));
  const cands = new Set<string>();
  for (const w of words) for (const id of names.lookup(w)) if (!participants.has(id) && env.usable(id)) cands.add(id);
  if (!cands.size) return [];
  const strength = env.db.prepare('SELECT max(strength) FROM edge_stats WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)').pluck();
  const tie = env.db.prepare('SELECT tie_strength FROM person_stats WHERE person_id = ?').pluck();
  const scored: { id: string; score: number }[] = [];
  for (const id of cands) {
    let best = 0;
    for (const p of participants) {
      const s = (strength.get(id, p, p, id) as number | null) ?? 0;
      if (s > best) best = s;
    }
    const t = (tie.get(id) as number | null | undefined) ?? 0;
    const priority = env.person(id)?.priority ?? false;
    if (best >= MENTIONABLE_STRENGTH || t >= MENTIONABLE_T || priority) scored.push({ id, score: Math.max(best * 100, t, priority ? 50 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_MENTIONABLES)
    .map((s) => s.id);
}

export interface RenderInput {
  env: Env;
  egress: Egress;
  names: NameIndex;
  windowId: string;
  conv: ConvRow;
  elig: Eligibility;
  mode: WindowMode;
  /** NEW messages, oldest first */
  messages: MsgRow[];
}

/** Builds the packet and the pseudonymized user turn for one window. */
export function renderWindow(i: RenderInput): RenderedWindow {
  const { env, egress } = i;
  const db = env.db;
  const authorOf = (m: MsgRow): string | null | undefined => {
    if (m.is_from_me === 1) return null; // ME
    const p = env.personOfIdentity(m.sender_identity_id);
    if (p && p === env.meId) return null; // one of my own handles (another device)
    return p && env.usable(p) ? p : undefined; // undefined = not renderable
  };

  // CONTEXT: the previous CONTEXT_MESSAGES renderable messages within ~CONTEXT_BUDGET tokens.
  const first = i.messages[0]!;
  let ctx = contextMessages(db, i.conv.id, { sentAt: first.sent_at, id: first.id }, CONTEXT_MESSAGES * 2).filter((m) => authorOf(m) !== undefined);
  ctx = ctx.slice(-CONTEXT_MESSAGES);
  let ctxTok = ctx.reduce((n, m) => n + estimateTokens(lineText(m.text, MESSAGE_CHARS)) + 12, 0);
  while (ctx.length && ctxTok > CONTEXT_BUDGET) {
    ctxTok -= estimateTokens(lineText(ctx[0]!.text, MESSAGE_CHARS)) + 12;
    ctx = ctx.slice(1);
  }
  const fresh = i.messages.filter((m) => authorOf(m) !== undefined);
  const all = [...ctx.map((m) => ({ m, role: 'context' as const })), ...fresh.map((m) => ({ m, role: 'new' as const }))];

  // Participants: DM counterpart first, then NEW posters by count, then CONTEXT posters.
  const counts = new Map<string, number>();
  for (const { m, role } of all) {
    const a = authorOf(m);
    if (a) counts.set(a, (counts.get(a) ?? 0) + (role === 'new' ? 1000 : 1));
  }
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
  if (i.elig.counterpart) {
    const at = order.indexOf(i.elig.counterpart);
    if (at >= 0) order.splice(at, 1);
    order.unshift(i.elig.counterpart);
  }
  const participants = new Set(order);

  const refs: Record<string, PacketRef> = {};
  const egressPeople: EgressPerson[] = [];
  const tokenOf = new Map<string, string>();
  const addRef = (personId: string, role: PacketRef['role']) => {
    const p = env.person(personId);
    const token = egress.tokenFor(personId);
    tokenOf.set(personId, token);
    refs[token] = { personId, role, firstName: p ? cardFirstName(p) : null };
    egressPeople.push({ personId, firstName: p?.firstName ?? null, lastName: p?.lastName ?? null });
    return token;
  };
  for (const id of order) addRef(id, 'participant');
  if (env.meId) egressPeople.push({ personId: env.meId, firstName: env.meFirstName, isMe: true });

  // Mentionables (from the raw NEW text; the names themselves are kept by egress).
  const newText = fresh.map((m) => m.text ?? '').join('\n');
  const ment = mentionables(env, i.names, newText, new Set([...participants, ...(env.meId ? [env.meId] : [])]));
  for (const id of ment) addRef(id, 'mentionable');

  // Cards (≤8): first name, ≤6 active facts (F aliases), open commitments (K aliases).
  const facts: Packet['facts'] = {};
  const commitments: Packet['commitments'] = {};
  let fN = 0;
  let kN = 0;
  const sections: { name: string; text: string }[] = [];
  const cardTokens: string[] = [];
  for (const id of order.slice(0, MAX_CARDS)) {
    const token = tokenOf.get(id)!;
    const p = env.person(id);
    const parts: string[] = [];
    const name = p ? cardFirstName(p) : null;
    if (name) parts.push(name);
    const fs = activeFacts(db, id, CARD_FACTS);
    if (fs.length) {
      parts.push(
        `facts: ${fs
          .map((f) => {
            const alias = `F${++fN}`;
            facts[alias] = { factId: f.id, personId: id, cat: f.type, valueNorm: f.value_norm };
            return `${alias} ${f.type}: ${lineText(f.value, 80)}`;
          })
          .join('; ')}`,
      );
    }
    const cs = openCommitments(db, id, CARD_COMMITMENTS);
    if (cs.length) {
      parts.push(
        `open: ${cs
          .map((c) => {
            const alias = `K${++kN}`;
            commitments[alias] = { commitmentId: c.id, personId: id };
            return `${alias} ${c.kind} "${lineText(c.what, 80)}"`;
          })
          .join('; ')}`,
      );
    }
    let body = parts.join(' · ');
    if (body.length > CARD_CHARS) body = `${body.slice(0, CARD_CHARS - 1)}…`;
    sections.push({ name: `card:${token}`, text: body });
    cardTokens.push(token);
  }
  const mentTokens: string[] = [];
  for (const id of ment) {
    const token = tokenOf.get(id)!;
    const p = env.person(id);
    const bits: string[] = [];
    const first = p ? cardFirstName(p) : null;
    bits.push(first ? `${first}${p?.lastName ? ` ${p.lastName.trim()[0]?.toUpperCase()}.` : ''}` : '?');
    const city = cityOf(db, id);
    if (city) bits.push(lineText(city, 40));
    const circle = circleOf(db, id);
    if (circle) bits.push(`circle: ${lineText(circle, 40)}`);
    sections.push({ name: `ment:${token}`, text: bits.join(' · ') });
    mentTokens.push(token);
  }

  // Lines.
  const nOf = new Map<number, number>();
  all.forEach(({ m }, idx) => nOf.set(m.id, idx + 1));
  for (const { m } of all) sections.push({ name: `m:${nOf.get(m.id)}`, text: [lineText(m.text, MESSAGE_CHARS), ...attachmentTokens(m.attachments)].filter(Boolean).join(' ') });
  if (i.conv.title && i.elig.chat === 'group') sections.push({ name: 'title', text: lineText(i.conv.title, 120) });
  const summary = i.mode === 'steady' && i.conv.summary ? truncateAtSentence(i.conv.summary, SUMMARY_CHARS) : '';
  if (summary) sections.push({ name: 'summary', text: summary });

  const pz = egress.pseudonymize({ purpose: i.mode === 'steady' ? 'extract' : 'historical', sections, people: egressPeople });
  const out = new Map(pz.sections.map((s) => [s.name, s.text]));

  // Reactions folded into their lines.
  const ids = all.map(({ m }) => m.id);
  const reactions = new Map<number, string[]>();
  if (ids.length) {
    const rows = db
      .prepare(
        `SELECT message_id, actor_identity_id, is_from_me, type, emoji FROM message_reactions
         WHERE removed = 0 AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY at`,
      )
      .all(...ids) as { message_id: number; actor_identity_id: string | null; is_from_me: number; type: string; emoji: string | null }[];
    for (const r of rows) {
      let who: string | null = null;
      if (r.is_from_me === 1) who = 'ME';
      else {
        const p = env.personOfIdentity(r.actor_identity_id);
        if (p && tokenOf.has(p)) who = tokenOf.get(p)!;
        else if (p && env.usable(p)) who = '?';
      }
      if (!who) continue;
      let arr = reactions.get(r.message_id);
      if (!arr) reactions.set(r.message_id, (arr = []));
      arr.push(`${reactionGlyph(r.type, r.emoji)} ${who}`);
    }
  }

  const lines: PacketLine[] = [];
  const render = (m: MsgRow, role: 'new' | 'context'): string => {
    const n = nOf.get(m.id)!;
    const authorId = authorOf(m) ?? null;
    const author = authorId ? tokenOf.get(authorId)! : 'ME';
    const body = out.get(`m:${n}`) ?? '';
    lines.push({ n, msgId: m.id, role, at: m.sent_at, author, authorPersonId: authorId, identityId: m.sender_identity_id, body });
    let head = `[m:${n}|${localStamp(m.sent_at, env.tz)}|${author}`;
    if (i.elig.chat === 'dm') {
      const other = i.elig.counterpart ? tokenOf.get(i.elig.counterpart) : undefined;
      head += author === 'ME' ? `→${other ?? '?'}` : '→ME';
    }
    head += ']';
    if (m.reply_to_msg_id !== null) head += nOf.has(m.reply_to_msg_id) ? ` ↩m:${nOf.get(m.reply_to_msg_id)}` : ' ↩earlier';
    const rx = reactions.get(m.id);
    return `${head} ${body}${rx?.length ? ` {${rx.join(', ')}}` : ''}`.trimEnd();
  };
  const ctxLines = all.filter((x) => x.role === 'context').map(({ m }) => render(m, 'context'));
  const newLines = all.filter((x) => x.role === 'new').map(({ m }) => render(m, 'new'));

  const asOf = localStamp(env.now, env.tz).slice(0, 10);
  const parts: string[] = [`mode=${i.mode} as_of=${asOf} tz=${env.tz} chat=${i.elig.chat} members=${i.elig.memberCount}`];
  const title = out.get('title');
  if (title) parts.push(`TITLE: ${title}`);
  const sum = out.get('summary');
  if (sum) parts.push(`SUMMARY:\n${sum}`);
  parts.push(`PEOPLE:\n${cardTokens.map((t) => `${t}${out.get(`card:${t}`) ? ` ${out.get(`card:${t}`)}` : ''}`).join('\n')}`);
  if (mentTokens.length) parts.push(`MENTIONABLES:\n${mentTokens.map((t) => `${t} ${out.get(`ment:${t}`) ?? ''}`.trimEnd()).join('\n')}`);
  if (ctxLines.length) parts.push(`CONTEXT:\n${ctxLines.join('\n')}`);
  parts.push(`NEW:\n${newLines.join('\n')}`);
  const userText = parts.join('\n');

  const packet: Packet = {
    v: 1,
    windowId: i.windowId,
    conversationId: i.conv.id,
    mode: i.mode,
    chat: i.elig.chat,
    memberCount: i.elig.memberCount,
    asOf: localDateToMs(asOf, env.tz) ?? env.now,
    tz: env.tz,
    meId: env.meId,
    dmCounterpart: i.elig.counterpart,
    lines,
    refs,
    facts,
    commitments,
  };
  return { packet, userText, tokens: estimateTokens(userText), newLines: newLines.length };
}

export function storePacket(db: DB, r: RenderedWindow, now: number): void {
  db.prepare(
    `INSERT INTO extraction_packets (window_id, mode, packet, user_text, token_estimate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (window_id) DO UPDATE SET packet = excluded.packet, user_text = excluded.user_text, token_estimate = excluded.token_estimate,
       result = NULL, updated_at = excluded.updated_at, purged_at = NULL`,
  ).run(r.packet.windowId, r.packet.mode, JSON.stringify(r.packet), r.userText, r.tokens, now, now);
}

export function loadPacket(db: DB, windowId: string): { packet: Packet; userText: string | null; tokens: number } | null {
  const row = db.prepare('SELECT packet, user_text, token_estimate FROM extraction_packets WHERE window_id = ?').get(windowId) as
    | { packet: string; user_text: string | null; token_estimate: number }
    | undefined;
  return row ? { packet: JSON.parse(row.packet) as Packet, userText: row.user_text, tokens: row.token_estimate } : null;
}
