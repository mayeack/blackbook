/**
 * Graph-derived person↔person evidence (intelligence §2), class (D): rebuilt nightly into edge_evidence, never
 * journaled. Only the types in DERIVED_TYPES are ever written or deleted here (Partiful writes co_attend /
 * invited_by / plus_one / co_host with 'event:' refs, the occasions pipeline co_attend with 'occ:' refs).
 *
 *   co_group (ref 'conv:<id>', at = the group's last message)
 *     w = (1/log2(1+n)) · A_g · P_ab · R_g, n = members without the owner,
 *     A_g = 1 − e^(−M_g/50), M_g = Σ 0.5^(age/90) over the group's messages of the last 365 days,
 *     P_ab = 0.25 + 0.75·min(1, √(m_a·m_b)/20), m = each person's posts there over 365 days,
 *     R_g = e^(−days since the last message/180); groups over 40 add nothing, 25–40 count ×0.5.
 *     Members: the roster (active, or seen this year) plus anyone who posted this year.
 *   group_reply (ref 'm:<id>', w 0.1) inside a group, the last 365 days: a direct reply (reply_to) of a to b, or a
 *     naming b by a first name that is unique among that group's members.
 *   mentioned_together (ref 'm:<id>', w 0.3) a message (from the owner or anyone) naming two people: a full name
 *     unique among visible people, or in a group a member's unique first name. Last 3 years (half-life 365 d).
 * The owner (kind 'me') never gets edges; ties to the owner are §3's business. People are canonical at derive time
 * (the nightly rebuild picks up merges and undos); hidden people are dropped by the aggregation.
 */
import { normalizeNamePart } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { SESSION_KINDS } from '../sessionize';

const DAY = 86_400_000;
const MAX_GROUP = 40;
const HALF_GROUP = 25;
export const GROUP_REPLY_W = 0.1;
export const MENTION_W = 0.3;
const MENTION_HORIZON_DAYS = 3 * 365;
const MAX_MENTIONED = 5;
const SCAN_PAGE = 2000;
const KINDS = SESSION_KINDS.map((k) => `'${k}'`).join(',');

export interface EvidenceRow {
  a: string;
  b: string;
  type: string;
  ref: string;
  at: number | null;
  w: number;
}

export const evidenceKey = (r: Pick<EvidenceRow, 'a' | 'b' | 'ref'>) => `${r.a}|${r.b}|${r.ref}`;

/** Words that are also first names but mostly mean something else in a text. */
const NAME_STOPWORDS = new Set([
  'will', 'may', 'june', 'april', 'august', 'mark', 'bill', 'art', 'joy', 'hope', 'grace', 'faith', 'rose', 'dawn', 'summer',
  'autumn', 'winter', 'sunny', 'chase', 'hunter', 'king', 'page', 'penny', 'ray', 'rich', 'sky', 'star', 'storm', 'wade', 'west',
  'young', 'miles', 'case', 'cash', 'chance', 'chip', 'crystal', 'daisy', 'dale', 'drew', 'eve', 'frank', 'gene', 'glen', 'guy',
  'jack', 'jean', 'lane', 'lee', 'love', 'lucky', 'max', 'pat', 'pearl', 'reed', 'rob', 'rocky', 'rusty', 'sandy', 'sterling',
  'sue', 'van', 'win', 'iris', 'ivy', 'holly', 'heather', 'violet', 'ruby', 'amber', 'jade', 'olive', 'sage', 'willow', 'brook',
  'river', 'sunday', 'monday', 'friday', 'christmas', 'easter', 'don', 'dot', 'bud', 'buddy', 'sonny', 'bob', 'nick', 'gay',
  'happy', 'honey', 'baby', 'man', 'dude', 'bro', 'sis', 'mom', 'dad', 'the', 'and', 'you', 'not', 'but', 'all', 'can',
]);

const ASCII_WORD = /^[A-Za-z]+$/;
/** normalizeNamePart, with a fast path for plain ASCII words (the vast majority). */
export const normWord = (w: string): string => (ASCII_WORD.test(w) ? w.toLowerCase() : normalizeNamePart(w));
const WORD_RE = /[\p{L}][\p{L}'’-]*/gu;
const POSSESSIVE = /['’]s$/u;

export function words(text: string): { raw: string; norm: string }[] {
  const out: { raw: string; norm: string }[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0].replace(POSSESSIVE, '').replace(/['’-]+$/u, '');
    if (raw) out.push({ raw, norm: normWord(raw) });
  }
  return out;
}

const isCapitalized = (w: string) => {
  const c = w[0]!;
  return c !== c.toLowerCase() && c === c.toUpperCase();
};

/** Who the graph pass can attach evidence to. */
export interface GraphPeople {
  /** identity id → canonical person (kind person: active, provisional or roster-only). */
  personOfIdentity: Map<string, string>;
  /** Visible people's names: "first last" (and "nickname last") → id, null when two people share it. */
  fullNames: Map<string, string | null>;
  /** Visible people's first-name forms (first, nickname, first word of the display name). */
  firstNames: Map<string, string[]>;
  visible: Set<string>;
}

export function loadGraphPeople(db: DB): GraphPeople {
  const personOfIdentity = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT i.id, pc.canonical_id FROM identities i
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN people p ON p.id = pc.canonical_id
       WHERE i.status IN ('active','superseded') AND p.kind = 'person' AND p.status IN ('active','provisional','roster_only')`,
    )
    .raw()
    .all() as [string, string][]) {
    personOfIdentity.set(r[0], r[1]);
  }
  const fullNames = new Map<string, string | null>();
  const firstNames = new Map<string, string[]>();
  const visible = new Set<string>();
  const addFull = (k: string, id: string) => {
    if (!k.includes(' ')) return;
    const cur = fullNames.get(k);
    fullNames.set(k, cur === undefined || cur === id ? id : null);
  };
  for (const p of db.prepare(`SELECT id, first_name, last_name, nickname, display_name FROM person_visible`).all() as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    nickname: string | null;
    display_name: string;
  }[]) {
    visible.add(p.id);
    const first = normalizeNamePart(p.first_name);
    const last = normalizeNamePart(p.last_name);
    const nick = normalizeNamePart(p.nickname);
    const disp = normalizeNamePart(p.display_name);
    if (first && last) addFull(`${first} ${last}`, p.id);
    if (nick && last) addFull(`${nick} ${last}`, p.id);
    if (disp.split(' ').length === 2) addFull(disp, p.id);
    const forms = new Set([first, nick, disp.split(' ')[0] ?? ''].filter((f) => f.length >= 2 && !f.includes(' ')));
    if (forms.size) firstNames.set(p.id, [...forms]);
  }
  return { personOfIdentity, fullNames, firstNames, visible };
}

interface GroupInfo {
  members: Set<string>;
  /** first-name form → member id (null: two members share it). */
  firstNames: Map<string, string | null>;
}

/** Canonical members of a group (roster active or seen within a year), without the owner. */
function groupMembers(db: DB, people: GraphPeople, conversationId: string, since: number): Set<string> {
  const out = new Set<string>();
  for (const m of db
    .prepare('SELECT identity_id, is_active, last_seen_at FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId) as { identity_id: string; is_active: number; last_seen_at: number }[]) {
    if (m.is_active !== 1 && m.last_seen_at < since) continue;
    const p = people.personOfIdentity.get(m.identity_id);
    if (p) out.add(p);
  }
  return out;
}

function groupFirstNames(people: GraphPeople, members: Set<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const id of members) {
    for (const f of people.firstNames.get(id) ?? []) {
      const cur = out.get(f);
      out.set(f, cur === undefined || cur === id ? id : null);
    }
  }
  return out;
}

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** co_group evidence, one group per step. */
export function* deriveCoGroup(db: DB, people: GraphPeople, now: number): Generator<void, Map<string, EvidenceRow>> {
  const out = new Map<string, EvidenceRow>();
  const since = now - 365 * DAY;
  const groups = db
    .prepare(`SELECT id, member_count FROM conversations WHERE kind = 'group' AND agent_excluded = 0 ORDER BY id`)
    .all() as { id: string; member_count: number | null }[];
  const msgs = db.prepare(
    `SELECT sender_identity_id, is_from_me, sent_at FROM messages
     WHERE conversation_id = ? AND sent_at >= ? AND kind IN (${KINDS}) AND is_bot = 0 AND dup_of IS NULL`,
  );
  const lastMsg = db.prepare(`SELECT max(sent_at) FROM messages WHERE conversation_id = ?`).pluck();
  for (const g of groups) {
    const members = groupMembers(db, people, g.id, since);
    let mg = 0;
    const posts = new Map<string, number>();
    for (const m of msgs.all(g.id, since) as { sender_identity_id: string | null; is_from_me: number; sent_at: number }[]) {
      mg += 0.5 ** (Math.max(0, now - m.sent_at) / DAY / 90);
      if (m.is_from_me === 1 || !m.sender_identity_id) continue;
      const p = people.personOfIdentity.get(m.sender_identity_id);
      if (!p) continue;
      members.add(p);
      posts.set(p, (posts.get(p) ?? 0) + 1);
    }
    const n = Math.max(members.size, (g.member_count ?? 0) - 1);
    if (n > MAX_GROUP || members.size < 2 || mg <= 0) {
      yield;
      continue;
    }
    const last = (lastMsg.get(g.id) as number | null) ?? null;
    const ag = 1 - Math.exp(-mg / 50);
    const rg = last === null ? 0 : Math.exp(-Math.max(0, now - last) / DAY / 180);
    const base = (1 / Math.log2(1 + n)) * ag * rg * (n >= HALF_GROUP ? 0.5 : 1);
    const list = [...members].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ma = posts.get(list[i]!) ?? 0;
        const mb = posts.get(list[j]!) ?? 0;
        const w = r6(base * (0.25 + 0.75 * Math.min(1, Math.sqrt(ma * mb) / 20)));
        if (w < 0.001) continue;
        const row: EvidenceRow = { a: list[i]!, b: list[j]!, type: 'co_group', ref: `conv:${g.id}`, at: last, w };
        out.set(evidenceKey(row), row);
      }
    }
    yield;
  }
  return out;
}

export interface MessageEvidence {
  groupReply: Map<string, EvidenceRow>;
  mentioned: Map<string, EvidenceRow>;
  scanned: number;
}

/** group_reply and mentioned_together from one scan over recent messages (a page per step). */
export function* deriveMessageEvidence(db: DB, people: GraphPeople, now: number): Generator<void, MessageEvidence> {
  const out: MessageEvidence = { groupReply: new Map(), mentioned: new Map(), scanned: 0 };
  const replySince = now - 365 * DAY;
  const since = now - MENTION_HORIZON_DAYS * DAY;
  const convs = new Map<string, { kind: string }>();
  for (const c of db.prepare(`SELECT id, kind FROM conversations WHERE agent_excluded = 0 AND kind IN ('direct','group')`).all() as {
    id: string;
    kind: string;
  }[]) {
    convs.set(c.id, c);
  }
  const groups = new Map<string, GroupInfo>();
  const groupInfo = (id: string): GroupInfo => {
    let g = groups.get(id);
    if (!g) {
      const members = groupMembers(db, people, id, replySince);
      groups.set(id, (g = { members, firstNames: groupFirstNames(people, members) }));
    }
    return g;
  };
  const page = db.prepare(
    `SELECT id, conversation_id, sender_identity_id, is_from_me, sent_at, text, reply_to_msg_id, kind FROM messages
     WHERE id > ? AND sent_at >= ? AND is_bot = 0 AND dup_of IS NULL ORDER BY id LIMIT ?`,
  );
  const target = db.prepare('SELECT sender_identity_id, is_from_me FROM messages WHERE id = ?');
  let cursor = 0;
  for (;;) {
    const rows = page.all(cursor, since, SCAN_PAGE) as {
      id: number;
      conversation_id: string;
      sender_identity_id: string | null;
      is_from_me: number;
      sent_at: number;
      text: string | null;
      reply_to_msg_id: number | null;
      kind: string;
    }[];
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    for (const m of rows) {
      out.scanned++;
      const conv = convs.get(m.conversation_id);
      if (!conv) continue;
      const sender = m.is_from_me === 1 ? null : m.sender_identity_id ? (people.personOfIdentity.get(m.sender_identity_id) ?? undefined) : undefined;
      if (sender === undefined) continue; // an unknown or service sender
      const isGroup = conv.kind === 'group';
      const g = isGroup ? groupInfo(m.conversation_id) : null;
      const named = new Set<string>();
      const firstNamed = new Set<string>();
      if (m.text && m.kind === 'text') {
        const ws = words(m.text);
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i]!;
          const next = ws[i + 1];
          if (next) {
            const full = people.fullNames.get(`${w.norm} ${next.norm}`);
            if (full) {
              named.add(full);
              if (g?.members.has(full)) firstNamed.add(full);
              i++;
              continue;
            }
          }
          if (g && w.norm.length >= 3 && isCapitalized(w.raw) && !NAME_STOPWORDS.has(w.norm)) {
            const id = g.firstNames.get(w.norm);
            if (id) {
              named.add(id);
              firstNamed.add(id);
            }
          }
        }
      }
      if (sender) named.delete(sender);
      // group_reply: replies and first-name mentions between members, this year
      if (g && sender && m.sent_at >= replySince) {
        const to = new Set<string>(firstNamed);
        if (m.reply_to_msg_id) {
          const t = target.get(m.reply_to_msg_id) as { sender_identity_id: string | null; is_from_me: number } | undefined;
          const b = t && t.is_from_me !== 1 && t.sender_identity_id ? people.personOfIdentity.get(t.sender_identity_id) : undefined;
          if (b) to.add(b);
        }
        to.delete(sender);
        for (const b of to) {
          const [x, y] = pair(sender, b);
          const row: EvidenceRow = { a: x, b: y, type: 'group_reply', ref: `m:${m.id}`, at: m.sent_at, w: GROUP_REPLY_W };
          out.groupReply.set(evidenceKey(row), row);
        }
      }
      // mentioned_together: two (or more) named people in one message
      const list = [...named].filter((id) => people.visible.has(id)).sort().slice(0, MAX_MENTIONED);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const row: EvidenceRow = { a: list[i]!, b: list[j]!, type: 'mentioned_together', ref: `m:${m.id}`, at: m.sent_at, w: MENTION_W };
          out.mentioned.set(evidenceKey(row), row);
        }
      }
    }
    yield;
  }
  return out;
}

export interface SyncStats {
  inserted: number;
  updated: number;
  deleted: number;
}

/** Makes edge_evidence of `type` equal `want` (diffed; a few thousand writes per step). */
export function* syncEvidence(db: DB, type: string, want: Map<string, EvidenceRow>, now: number, stepOps = 2000): Generator<void, SyncStats> {
  const stats: SyncStats = { inserted: 0, updated: 0, deleted: 0 };
  const existing = db.prepare('SELECT id, a_id, b_id, ref, at, w_raw FROM edge_evidence WHERE type = ?').all(type) as {
    id: number;
    a_id: string;
    b_id: string;
    ref: string;
    at: number | null;
    w_raw: number;
  }[];
  const ops: (() => void)[] = [];
  const del = db.prepare('DELETE FROM edge_evidence WHERE id = ?');
  const upd = db.prepare('UPDATE edge_evidence SET at = ?, w_raw = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`);
  const pending = new Map(want);
  for (const e of existing) {
    const k = `${e.a_id}|${e.b_id}|${e.ref}`;
    const w = pending.get(k);
    if (!w) {
      ops.push(() => (stats.deleted += del.run(e.id).changes));
      continue;
    }
    pending.delete(k);
    if (e.at !== w.at || Math.abs(e.w_raw - w.w) > 1e-9) ops.push(() => (stats.updated += upd.run(w.at, w.w, e.id).changes));
  }
  for (const w of pending.values()) ops.push(() => (stats.inserted += ins.run(w.a, w.b, type, w.ref, w.at, w.w, now).changes));
  for (let i = 0; i < ops.length; i += stepOps) {
    const slice = ops.slice(i, i + stepOps);
    tx(db, () => slice.forEach((f) => f()));
    yield;
  }
  return stats;
}
