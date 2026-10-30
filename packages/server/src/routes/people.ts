/**
 * People read API. Every person comes through person_visible (canonical, active or provisional, not hidden, real
 * people) and every child row through person_canon, so hidden and merged-away people never leave this module.
 *
 *   GET /people?q=&sort=last|recent|added|close&status=all|new|known&cursor=&limit=
 *                                                      status=new: provisional people only ("New people")
 *   GET /people/:id                                    header, stats, linked accounts (masked)
 *   GET /people/:id/identities/:identityId/reveal      one full phone/email value (the owner asked)
 *   GET /people/:id/timeline?cursor=&limit=&source=    sessions, calls + other non-session interactions, newest
 *                                                      first; source = a raw source or a channel ('instagram' =
 *                                                      Beeper + the Instagram export; 'phone' / 'facetime' = calls)
 *   GET /people/:id/sessions/:sessionId/messages       one session's messages (timeline expand)
 *
 * A person's phone numbers show in full (the owner's call, 2026-10-28). Emails and opaque ids stay masked, and
 * names, titles and labels that look like a phone number or an email are masked.
 */
import { Router } from 'express';
import { z } from 'zod';
import { RAW_PHONE_PREFIX, formatPhone, maskPhone, normalizeNamePart, toE164 } from '@yb/shared';
import type { DB } from '../db/connection';
import { closenessScore } from '../pipeline/ties/closeness';
import { badRequest, notFound } from '../http/errors';
import type { RouteDeps } from './index';

// ---------------------------------------------------------------------------------------------- DTOs

export type PeopleSort = 'last' | 'recent' | 'added' | 'close';
/** 'provisional' = a new handle not yet confirmed as a known person (intelligence §1.4, "New people"). */
export type PersonStatus = 'active' | 'provisional';
export type PeopleStatusFilter = 'all' | 'new' | 'known';

export interface PersonListItem {
  id: string;
  displayName: string;
  status: PersonStatus;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  /** For the subtitle when there is no company: '@username' (Instagram / X), else a masked phone or email. */
  handle: string | null;
  isPriority: boolean;
  lastAt: number | null;
  state: string | null;
  /** 1–10, acquaintance → closest (pipeline/ties/closeness.ts). */
  closeness: number;
  /** Distinct identity sources (addressbook, imessage, whatsapp, …). */
  sources: string[];
  createdAt: number;
}

export interface PeoplePage {
  items: PersonListItem[];
  total: number;
  nextCursor: string | null;
}

export interface IdentityView {
  id: string;
  kind: string;
  source: string;
  matchMethod: string;
  confidence: number;
  verified: boolean;
  shared: boolean;
  status: string;
  label: string | null;
  displayName: string | null;
  /** Display form: phones in full, emails and opaque ids masked. */
  value: string;
  masked: boolean;
  /** Masked and the owner can ask for the full value. */
  revealable: boolean;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  createdAt: number;
}

export interface PersonStatsView {
  lastAt: number | null;
  state: string | null;
  expectedGapD: number | null;
  silenceD: number | null;
  tieStrength: number | null;
  fadingSuppressed: boolean;
}

export interface PersonDetail {
  id: string;
  displayName: string;
  status: PersonStatus;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  company: string | null;
  jobTitle: string | null;
  isPriority: boolean;
  createdAt: number;
  updatedAt: number;
  locations: string[];
  tags: string[];
  /** 1–10, acquaintance → closest (pipeline/ties/closeness.ts). */
  closeness: number;
  stats: PersonStatsView | null;
  identities: IdentityView[];
  /** Other records merged into this person. */
  mergedCount: number;
}

export interface RevealedIdentity {
  id: string;
  kind: string;
  value: string;
}

export type TimelineItem =
  | {
      type: 'session';
      id: string;
      conversationId: string;
      source: string;
      /** The network for the badge: imessage, whatsapp, instagram (Beeper and the export both), … */
      channel: string;
      conversationKind: string;
      title: string | null;
      memberCount: number | null;
      startedAt: number;
      endedAt: number;
      msgCount: number;
      fromMe: number;
      fromThem: number;
      initiatedByMe: boolean;
    }
  | {
      type: 'interaction';
      id: string;
      kind: string;
      channel: string | null;
      /** null for a sensitive occasion (medical and the like). */
      title: string | null;
      startedAt: number;
      endedAt: number | null;
      /** The get-together this came from (Events screen /e/:id); null for a sensitive one, which isn't served. */
      occasionId: string | null;
      eventId: string | null;
    }
  | {
      /** A call from the Mac's call log (answered or missed) with one of the person's numbers or emails. */
      type: 'call';
      id: string;
      channel: 'phone' | 'facetime';
      service: 'phone' | 'facetime_audio' | 'facetime_video' | 'other';
      startedAt: number;
      /** null when the call log has no length (calls answered on the iPhone). */
      endedAt: number | null;
      outgoing: boolean;
      answered: boolean;
    };

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  /** Every channel the person has conversations or calls on (for the source filter), in a fixed order. */
  channels: string[];
}

export interface SessionMessage {
  id: number;
  sentAt: number;
  isFromMe: boolean;
  kind: string;
  text: string | null;
  hasAttachments: boolean;
  edited: boolean;
  retracted: boolean;
  /** null when the message is mine. personId only for visible people; label null = a hidden contact. */
  sender: { personId: string | null; label: string | null } | null;
  reactions: { emoji: string; count: number }[];
}

export interface SessionMessages {
  sessionId: string;
  conversationId: string;
  source: string;
  title: string | null;
  messages: SessionMessage[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------------------------- masking

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RUN_RE = /\+?\d[\d\s().-]{5,18}\d/g;
const digitsOf = (s: string) => s.replace(/\D/g, '');

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••@${email.slice(at + 1)}`;
}

function maskPhoneLike(s: string): string {
  const d = digitsOf(s);
  const e164 = s.trim().startsWith('+') && d.length >= 7 && d.length <= 15 ? `+${d}` : toE164(s);
  if (e164) return maskPhone(e164);
  return `••• ${digitsOf(s).slice(-2)}`;
}

/** A run that reads as a phone number: "+" and 7+ digits, or 10+ digits (so dates like 2026-10-14 survive). */
const isPhoneRun = (m: string) => {
  const n = digitsOf(m).length;
  return (m.startsWith('+') && n >= 7) || n >= 10;
};

/** Masks every email and phone-number run inside free text: names, titles, labels. */
export function maskText(s: string): string {
  return s.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PHONE_RUN_RE, (m) => (isPhoneRun(m) ? maskPhoneLike(m) : m));
}

/**
 * Names of hidden people in a title are blanked: a calendar title the owner typed can name someone he has since
 * hidden, and hidden contacts never show up outside Settings → Hidden. A word is blanked when it is a hidden
 * person's first name or nickname that no visible person shares; their last name goes too when it follows one.
 */
export function hiddenNameRedactor(db: DB): (title: string | null) => string | null {
  let sets: { first: Set<string>; last: Set<string>; visible: Set<string> } | null = null;
  const load = () => {
    const first = new Set<string>();
    const last = new Set<string>();
    for (const r of db.prepare(`SELECT first_name, last_name, nickname, display_name FROM people WHERE is_hidden = 1 AND kind = 'person'`).all() as {
      first_name: string | null;
      last_name: string | null;
      nickname: string | null;
      display_name: string;
    }[]) {
      const parts = normalizeNamePart(r.display_name).split(' ').filter(Boolean);
      for (const n of [normalizeNamePart(r.first_name), normalizeNamePart(r.nickname), parts[0] ?? '']) if (n) first.add(n);
      for (const n of [normalizeNamePart(r.last_name), parts.length > 1 ? parts[parts.length - 1]! : '']) if (n) last.add(n);
    }
    const visible = new Set<string>();
    for (const r of db.prepare(`SELECT first_name, nickname, display_name FROM person_visible`).all() as { first_name: string | null; nickname: string | null; display_name: string }[]) {
      for (const n of [normalizeNamePart(r.first_name), normalizeNamePart(r.nickname), normalizeNamePart(r.display_name).split(' ')[0] ?? '']) if (n) visible.add(n);
    }
    return { first, last, visible };
  };
  return (title) => {
    if (!title) return title;
    sets ??= load();
    const { first, last, visible } = sets;
    if (!first.size) return maskText(title);
    let previousBlanked = false;
    const out = title.replace(/[\p{L}][\p{L}'’-]*/gu, (word) => {
      const bare = word.replace(/['’]s$/u, '');
      const n = normalizeNamePart(bare);
      const blank = (first.has(n) && !visible.has(n)) || (previousBlanked && last.has(n));
      previousBlanked = blank;
      return blank ? `…${word.slice(bare.length)}` : word;
    });
    return maskText(out);
  };
}

const opaque = (prefix: string, key: string) => `${prefix} ••${key.slice(-4)}`;

const REVEALABLE = new Set(['phone', 'email', 'whatsapp_jid', 'whatsapp_lid', 'instagram_id', 'partiful_user', 'beeper_user']);

/** A phone key in full: formatted when it parses, else its digits as stored. */
function fullPhone(key: string): string {
  if (key.startsWith(RAW_PHONE_PREFIX)) return key.slice(RAW_PHONE_PREFIX.length);
  const e164 = key.startsWith('+') ? key : toE164(key);
  return e164 ? formatPhone(e164) : key;
}

/** The display form of an identity key. Phones and handles show in full; emails and opaque ids are masked. */
export function identityValue(kind: string, key: string): { value: string; masked: boolean } {
  switch (kind) {
    case 'phone':
      return { value: fullPhone(key), masked: false };
    case 'email':
      return { value: maskEmail(key), masked: true };
    case 'whatsapp_jid': {
      const d = digitsOf(key.split('@')[0] ?? '');
      return d.length >= 7 ? { value: fullPhone(`+${d}`), masked: false } : { value: opaque('WhatsApp', key), masked: true };
    }
    case 'whatsapp_lid':
      // Keys are "<digits>@lid": the tail of the digits, not of the server suffix.
      return { value: opaque('WhatsApp ID', key.split('@')[0] || key), masked: true };
    case 'instagram_id':
      return { value: opaque('Instagram ID', key), masked: true };
    case 'partiful_user':
      return { value: opaque('Partiful ID', key), masked: true };
    case 'beeper_user':
      return { value: opaque('Beeper ID', key), masked: true };
    case 'instagram_username':
    case 'x_username':
      return { value: `@${key.replace(/^@/, '')}`, masked: false };
    case 'instagram_name': {
      // Export participants are keyed `ig_dyi:<thread>:<name>`: show the name, never the thread id.
      const name = key.startsWith('ig_dyi:') ? key.split(':').slice(2).join(':') : key;
      return { value: maskText(name.trim()) || 'Instagram name', masked: false };
    }
    case 'addressbook_id':
      return { value: 'Contacts card', masked: true };
    case 'legacy_id':
      return { value: 'Blackbook record', masked: true };
    case 'business_chat':
      return { value: 'Business chat', masked: true };
    default:
      return { value: maskText(key), masked: false };
  }
}

const safe = (s: string | null) => (s == null ? null : maskText(s));

// ---------------------------------------------------------------------------------------------- list + sort

interface ListRow {
  id: string;
  display_name: string;
  status: PersonStatus;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  job_title: string | null;
  is_priority: number;
  created_at: number;
  last_at: number | null;
  state: string | null;
  tie_strength: number | null;
  historical_strength: number | null;
}

interface SortItem {
  id: string;
  last: string;
  first: string;
  display: string;
  lastAt: number | null;
  createdAt: number;
  /** Only the People list sets it (its 'close' sort); other users of compareByName leave it out. */
  closeness?: number;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Last name A–Z (locale-aware), first name tiebreaker, blank last names last; id makes the order total. */
export function compareByName(a: SortItem, b: SortItem): number {
  return (
    (a.last ? 0 : 1) - (b.last ? 0 : 1) ||
    collator.compare(a.last, b.last) ||
    collator.compare(a.first, b.first) ||
    collator.compare(a.display, b.display) ||
    byId(a.id, b.id)
  );
}

const COMPARATORS: Record<PeopleSort, (a: SortItem, b: SortItem) => number> = {
  last: compareByName,
  // Most recent contact first; never-contacted last.
  recent: (a, b) => (b.lastAt ?? -1) - (a.lastAt ?? -1) || compareByName(a, b),
  added: (a, b) => b.createdAt - a.createdAt || byId(b.id, a.id),
  // Closest first; most recent contact breaks ties within a score.
  close: (a, b) => (b.closeness ?? 1) - (a.closeness ?? 1) || (b.lastAt ?? -1) - (a.lastAt ?? -1) || compareByName(a, b),
};

const toSortItem = (r: ListRow): SortItem => {
  const last = r.last_name?.trim() ?? '';
  const first = r.first_name?.trim() ?? '';
  return {
    id: r.id,
    last,
    first: first || (last ? '' : r.display_name.trim()),
    display: r.display_name.trim(),
    lastAt: r.last_at,
    createdAt: r.created_at,
    closeness: closenessScore({ tie: r.tie_strength, historical: r.historical_strength, shown: true }),
  };
};

const Cursor = z.object({
  s: z.enum(['last', 'recent', 'added', 'close']),
  id: z.string().max(64),
  last: z.string().max(400),
  first: z.string().max(400),
  display: z.string().max(400),
  lastAt: z.number().nullable(),
  createdAt: z.number(),
  closeness: z.number().int().min(1).max(10).optional(),
});

const encodeCursor = (sort: PeopleSort, it: SortItem) => Buffer.from(JSON.stringify({ s: sort, ...it })).toString('base64url');

function decodeCursor(raw: string, sort: PeopleSort): SortItem {
  let parsed: z.infer<typeof Cursor>;
  try {
    parsed = Cursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Invalid cursor.');
  }
  if (parsed.s !== sort) throw badRequest('Cursor belongs to a different sort.');
  const { s: _s, ...item } = parsed;
  return item;
}

const likePattern = (token: string) => `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** One clause per token (AND across tokens): names, company, identity display names and usernames. */
function searchSql(q: string | undefined): { sql: string; params: string[] } {
  const tokens = (q ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/^@/, ''))
    .filter(Boolean)
    .slice(0, 6);
  const clause = `(p.display_name LIKE ? ESCAPE '\\' OR p.first_name LIKE ? ESCAPE '\\' OR p.last_name LIKE ? ESCAPE '\\'
    OR p.nickname LIKE ? ESCAPE '\\' OR p.company LIKE ? ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM person_canon pc JOIN identities i ON i.person_id = pc.person_id
               WHERE pc.canonical_id = p.id AND i.status <> 'detached'
                 AND (i.display_name LIKE ? ESCAPE '\\'
                      OR (i.kind IN ('instagram_username', 'x_username') AND i.key LIKE ? ESCAPE '\\'))))`;
  return {
    sql: tokens.map(() => clause).join(' AND '),
    params: tokens.flatMap((t) => Array<string>(7).fill(likePattern(t))),
  };
}

const SOURCE_ORDER = ['addressbook', 'imessage', 'whatsapp', 'instagram', 'beeper', 'partiful', 'calendar', 'gcal', 'legacy'];
const sourceRank = (s: string) => {
  const i = SOURCE_ORDER.indexOf(s);
  return i === -1 ? SOURCE_ORDER.length : i;
};
const sortSources = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b));

const STATUS_SQL: Record<PeopleStatusFilter, string | null> = {
  all: null,
  new: `p.status = 'provisional'`,
  known: `p.status = 'active'`,
};

export function listPeople(
  db: DB,
  o: { q?: string; sort: PeopleSort; status?: PeopleStatusFilter; cursor?: string; limit: number },
): PeoplePage {
  const search = searchSql(o.q);
  const where = [STATUS_SQL[o.status ?? 'all'], search.sql || null].filter(Boolean);
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.status, p.first_name, p.last_name, p.company, p.job_title, p.is_priority, p.created_at,
              s.last_at, s.state, s.tie_strength, s.historical_strength
       FROM person_visible p LEFT JOIN person_stats s ON s.person_id = p.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .all(...search.params) as ListRow[];

  const cmp = COMPARATORS[o.sort];
  const items = rows.map((r) => ({ r, k: toSortItem(r) })).sort((a, b) => cmp(a.k, b.k));
  let start = 0;
  if (o.cursor) {
    const after = decodeCursor(o.cursor, o.sort);
    start = items.findIndex((x) => cmp(x.k, after) > 0);
    if (start === -1) start = items.length;
  }
  const page = items.slice(start, start + o.limit);
  const extras = pageExtras(
    db,
    page.map((x) => x.r.id),
  );

  return {
    items: page.map(({ r, k }) => ({
      id: r.id,
      displayName: maskText(r.display_name),
      status: r.status,
      firstName: safe(r.first_name),
      lastName: safe(r.last_name),
      company: safe(r.company),
      jobTitle: safe(r.job_title),
      handle: extras.get(r.id)?.handle ?? null,
      isPriority: r.is_priority === 1,
      lastAt: r.last_at,
      state: r.state,
      closeness: k.closeness ?? 1,
      sources: extras.get(r.id)?.sources ?? [],
      createdAt: r.created_at,
    })),
    total: items.length,
    nextCursor: start + o.limit < items.length && page.length > 0 ? encodeCursor(o.sort, page[page.length - 1]!.k) : null,
  };
}

function pageExtras(db: DB, ids: string[]): Map<string, { sources: string[]; handle: string | null }> {
  const out = new Map<string, { sources: string[]; handle: string | null }>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT pc.canonical_id AS pid, i.kind, i.key, i.source
       FROM person_canon pc JOIN identities i ON i.person_id = pc.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) AND i.status <> 'detached'
       ORDER BY i.created_at`,
    )
    .all(JSON.stringify(ids)) as { pid: string; kind: string; key: string; source: string }[];
  const acc = new Map<string, { sources: Set<string>; handles: Map<string, string> }>();
  for (const r of rows) {
    let a = acc.get(r.pid);
    if (!a) acc.set(r.pid, (a = { sources: new Set(), handles: new Map() }));
    a.sources.add(r.source);
    if (HANDLE_KINDS.includes(r.kind) && !a.handles.has(r.kind)) a.handles.set(r.kind, r.key);
  }
  for (const [pid, a] of acc) {
    const kind = HANDLE_KINDS.find((k) => a.handles.has(k));
    out.set(pid, { sources: sortSources(a.sources), handle: kind ? identityValue(kind, a.handles.get(kind)!).value : null });
  }
  return out;
}

/** The list subtitle's handle when there is no company, best first; phones in full, emails masked. */
const HANDLE_KINDS = ['instagram_username', 'x_username', 'phone', 'whatsapp_jid', 'email'];

// ---------------------------------------------------------------------------------------------- one person

interface PersonRow {
  id: string;
  display_name: string;
  status: PersonStatus;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  company: string | null;
  job_title: string | null;
  is_priority: number;
  created_at: number;
  updated_at: number;
}

/** The visible canonical person for an id (a merged-away id resolves to its survivor), or 404. */
export function visiblePerson(db: DB, id: string): PersonRow {
  const canonical = (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(id) as string | undefined) ?? id;
  const row = db.prepare('SELECT * FROM person_visible WHERE id = ?').get(canonical) as PersonRow | undefined;
  if (!row) throw notFound('Person');
  return row;
}

/** Every permanent id that resolves to `canonical` (itself included). */
function clusterIds(db: DB, canonical: string): string[] {
  const ids = db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(canonical) as string[];
  return ids.includes(canonical) ? ids : [canonical, ...ids];
}

interface IdentityRow {
  id: string;
  person_id: string;
  kind: string;
  key: string;
  label: string | null;
  display_name: string | null;
  source: string;
  match_method: string;
  confidence: number;
  verified: number;
  shared: number;
  status: string;
  first_seen_at: number | null;
  last_seen_at: number | null;
  created_at: number;
}

function clusterIdentities(db: DB, cluster: string[]): IdentityRow[] {
  return db
    .prepare(
      `SELECT * FROM identities WHERE person_id IN (SELECT value FROM json_each(?)) AND status <> 'detached'
       ORDER BY CASE kind WHEN 'phone' THEN 0 WHEN 'email' THEN 1 ELSE 2 END, kind, created_at, id`,
    )
    .all(JSON.stringify(cluster)) as IdentityRow[];
}

const toIdentityView = (i: IdentityRow): IdentityView => {
  const v = identityValue(i.kind, i.key);
  return {
    id: i.id,
    kind: i.kind,
    source: i.source,
    matchMethod: i.match_method,
    confidence: i.confidence,
    verified: i.verified === 1,
    shared: i.shared === 1,
    status: i.status,
    label: safe(i.label),
    displayName: safe(i.display_name),
    value: v.value,
    masked: v.masked,
    revealable: v.masked && REVEALABLE.has(i.kind),
    firstSeenAt: i.first_seen_at,
    lastSeenAt: i.last_seen_at,
    createdAt: i.created_at,
  };
};

export function personDetail(db: DB, id: string): PersonDetail {
  const p = visiblePerson(db, id);
  const cluster = clusterIds(db, p.id);
  const clusterJson = JSON.stringify(cluster);
  const stats = db
    .prepare('SELECT last_at, state, expected_gap_d, silence_d, tie_strength, historical_strength, fading_suppressed FROM person_stats WHERE person_id = ?')
    .get(p.id) as
    | {
        last_at: number | null;
        state: string | null;
        expected_gap_d: number | null;
        silence_d: number | null;
        tie_strength: number | null;
        historical_strength: number | null;
        fading_suppressed: number;
      }
    | undefined;
  const locations = db
    .prepare(
      `SELECT DISTINCT l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id
       WHERE pl.person_id IN (SELECT value FROM json_each(?)) AND l.status = 'active' ORDER BY l.name`,
    )
    .pluck()
    .all(clusterJson) as string[];
  const tags = db
    .prepare(
      `SELECT DISTINCT t.name FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.person_id IN (SELECT value FROM json_each(?)) AND t.status = 'active' ORDER BY t.name`,
    )
    .pluck()
    .all(clusterJson) as string[];

  return {
    id: p.id,
    displayName: maskText(p.display_name),
    status: p.status,
    firstName: safe(p.first_name),
    lastName: safe(p.last_name),
    nickname: safe(p.nickname),
    company: safe(p.company),
    jobTitle: safe(p.job_title),
    isPriority: p.is_priority === 1,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    locations,
    tags,
    closeness: closenessScore({ tie: stats?.tie_strength, historical: stats?.historical_strength, shown: true }),
    stats: stats
      ? {
          lastAt: stats.last_at,
          state: stats.state,
          expectedGapD: stats.expected_gap_d,
          silenceD: stats.silence_d,
          tieStrength: stats.tie_strength,
          fadingSuppressed: stats.fading_suppressed === 1,
        }
      : null,
    identities: clusterIdentities(db, cluster).map(toIdentityView),
    mergedCount: cluster.length - 1,
  };
}

export function revealIdentity(db: DB, personId: string, identityId: string): RevealedIdentity {
  const p = visiblePerson(db, personId);
  const ident = clusterIdentities(db, clusterIds(db, p.id)).find((i) => i.id === identityId);
  if (!ident || !REVEALABLE.has(ident.kind)) throw notFound('Identity');
  return { id: ident.id, kind: ident.kind, value: ident.key };
}

// ---------------------------------------------------------------------------------------------- timeline

/** Conversation sources that are one network on screen. Beeper is read for Instagram only. */
const CHANNEL_SOURCES: Record<string, readonly string[]> = {
  instagram: ['instagram', 'beeper', 'instagram_dyi', 'ig_dyi'],
};
const CHANNEL_ORDER = ['imessage', 'whatsapp', 'instagram', 'phone', 'facetime'];

export function channelOf(source: string): string {
  for (const [channel, sources] of Object.entries(CHANNEL_SOURCES)) if (sources.includes(source)) return channel;
  return source;
}

/** The raw sources a ?source= filter matches: a channel's family, or just itself. */
const sourcesFor = (filter: string) => [...new Set([filter, ...(CHANNEL_SOURCES[filter] ?? [])])];

const channelRank = (c: string) => {
  const i = CHANNEL_ORDER.indexOf(c);
  return i === -1 ? CHANNEL_ORDER.length : i;
};

/** [conversationId, joinedAt|null, leftAt|null]: where the person is a member or has posted. */
type ConvWindow = [string, number | null, number | null];

function personConversations(db: DB, identityIds: string[]): ConvWindow[] {
  return db
    .prepare(
      `WITH ids(iid) AS (SELECT value FROM json_each(?)),
       raw(cid, j, l) AS (
         SELECT conversation_id, joined_at, left_at FROM conversation_members WHERE identity_id IN (SELECT iid FROM ids)
         UNION ALL
         SELECT DISTINCT conversation_id, NULL, NULL FROM messages WHERE sender_identity_id IN (SELECT iid FROM ids)
       )
       SELECT cid,
              CASE WHEN count(j) < count(*) THEN NULL ELSE min(j) END AS j,
              CASE WHEN count(l) < count(*) THEN NULL ELSE max(l) END AS l
       FROM raw GROUP BY cid`,
    )
    .raw()
    .all(JSON.stringify(identityIds)) as ConvWindow[];
}

const inWindow = (w: ConvWindow, startedAt: number, endedAt: number) =>
  (w[1] == null || endedAt >= w[1]) && (w[2] == null || startedAt <= w[2]);

interface TimelineRow {
  type: 'session' | 'interaction' | 'call';
  id: string;
  started_at: number;
  ended_at: number | null;
  msg_count: number | null;
  initiated_by_me: number | null;
  conversation_id: string | null;
  source: string | null;
  conv_kind: string | null;
  title: string | null;
  member_count: number | null;
  ikind: string | null;
  occasion_id: string | null;
  event_id: string | null;
  /** Calls: 1 when answered. */
  answered: number | null;
}

const TimelineCursor = z.string().regex(/^\d{1,15}:[\w.:-]{1,128}$/);

export function personTimeline(db: DB, id: string, o: { cursor?: string; limit: number; source?: string }): TimelinePage {
  const p = visiblePerson(db, id);
  const cluster = clusterIds(db, p.id);
  const identityIds = clusterIdentities(db, cluster).map((i) => i.id);
  const convs = personConversations(db, identityIds);

  let cursorAt: number | null = null;
  let cursorId: string | null = null;
  if (o.cursor) {
    const c = TimelineCursor.safeParse(o.cursor);
    if (!c.success) throw badRequest('Invalid cursor.');
    const i = c.data.indexOf(':');
    cursorAt = Number(c.data.slice(0, i));
    cursorId = c.data.slice(i + 1);
  }

  const rows = db
    .prepare(
      `WITH conv(cid, j, l) AS (
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(@convs)
       ),
       items AS (
         SELECT 'session' AS type, s.id, s.started_at, s.ended_at, s.msg_count, s.initiated_by_me,
                c.id AS conversation_id, c.source, c.kind AS conv_kind, c.title, c.member_count, NULL AS ikind,
                NULL AS occasion_id, NULL AS event_id, NULL AS answered
         FROM conv JOIN sessions s ON s.conversation_id = conv.cid JOIN conversations c ON c.id = s.conversation_id
         WHERE (conv.j IS NULL OR s.ended_at >= conv.j) AND (conv.l IS NULL OR s.started_at <= conv.l)
         UNION ALL
         SELECT 'interaction', i.id, i.started_at, i.ended_at, NULL, i.initiated_by_me,
                i.conversation_id, i.channel, NULL,
                CASE WHEN o.sensitive = 1 THEN NULL ELSE coalesce(e.title, o.title, i.summary) END, NULL, i.kind,
                CASE WHEN o.sensitive = 1 THEN NULL ELSE i.occasion_id END, i.event_id, NULL
         FROM interactions i
         LEFT JOIN events e ON e.id = i.event_id
         LEFT JOIN occasions o ON o.id = i.occasion_id
         WHERE i.person_id IN (SELECT value FROM json_each(@cluster)) AND i.session_id IS NULL AND i.retracted_at IS NULL
           AND i.call_id IS NULL
         UNION ALL
         -- Calls come from the call log itself, so missed ones show too (derived call interactions are answered only).
         SELECT 'call', c.id, c.started_at, CASE WHEN c.duration_ms > 0 THEN c.started_at + c.duration_ms END, NULL, c.outgoing,
                NULL, CASE WHEN c.service LIKE 'facetime%' THEN 'facetime' ELSE 'phone' END, NULL, NULL, NULL, c.service,
                NULL, NULL, c.answered
         FROM calls c
         WHERE c.id IN (SELECT h.call_id FROM call_handles h JOIN identities i ON i.kind = h.kind AND i.key = h.key
                        WHERE i.id IN (SELECT value FROM json_each(@identityIds)))
       )
       SELECT * FROM items
       WHERE (@cursorAt IS NULL OR started_at < @cursorAt OR (started_at = @cursorAt AND id < @cursorId))
         AND (@sources IS NULL OR source IN (SELECT value FROM json_each(@sources)))
       ORDER BY started_at DESC, id DESC
       LIMIT @limit`,
    )
    .all({
      convs: JSON.stringify(convs),
      cluster: JSON.stringify(cluster),
      identityIds: JSON.stringify(identityIds),
      cursorAt,
      cursorId,
      sources: o.source ? JSON.stringify(sourcesFor(o.source)) : null,
      limit: o.limit + 1,
    }) as TimelineRow[];

  const page = rows.slice(0, o.limit);
  const counts = db.prepare(
    `SELECT coalesce(sum(is_from_me), 0) AS me,
            coalesce(sum(CASE WHEN sender_identity_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END), 0) AS them
     FROM messages WHERE conversation_id = ? AND sent_at BETWEEN ? AND ? AND dup_of IS NULL`,
  );
  const idsJson = JSON.stringify(identityIds);
  // Occasion titles come from the owner's calendar, which can name people he has since hidden (as on /events).
  const redact = hiddenNameRedactor(db);

  const items: TimelineItem[] = page.map((r) => {
    if (r.type === 'session') {
      const c = counts.get(idsJson, r.conversation_id, r.started_at, r.ended_at) as { me: number; them: number };
      return {
        type: 'session',
        id: r.id,
        conversationId: r.conversation_id!,
        source: r.source!,
        channel: channelOf(r.source!),
        conversationKind: r.conv_kind!,
        title: safe(r.title),
        memberCount: r.member_count,
        startedAt: r.started_at,
        endedAt: r.ended_at!,
        msgCount: r.msg_count ?? 0,
        fromMe: c.me,
        fromThem: c.them,
        initiatedByMe: r.initiated_by_me === 1,
      };
    }
    if (r.type === 'call') {
      return {
        type: 'call',
        id: r.id,
        channel: r.source === 'facetime' ? 'facetime' : 'phone',
        service: r.ikind as 'phone' | 'facetime_audio' | 'facetime_video' | 'other',
        startedAt: r.started_at,
        endedAt: r.ended_at,
        outgoing: r.initiated_by_me === 1,
        answered: r.answered === 1,
      };
    }
    return {
      type: 'interaction',
      id: r.id,
      kind: r.ikind!,
      channel: r.source,
      title: r.occasion_id ? redact(r.title) : safe(r.title),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      occasionId: r.occasion_id,
      eventId: r.event_id,
    };
  });
  const last = page[page.length - 1];
  const convSources = db
    .prepare('SELECT DISTINCT source FROM conversations WHERE id IN (SELECT value FROM json_each(?))')
    .pluck()
    .all(JSON.stringify(convs.map((c) => c[0]))) as string[];
  const callChannels = db
    .prepare(
      `SELECT DISTINCT CASE WHEN c.service LIKE 'facetime%' THEN 'facetime' ELSE 'phone' END
       FROM call_handles h JOIN identities i ON i.kind = h.kind AND i.key = h.key JOIN calls c ON c.id = h.call_id
       WHERE i.id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(idsJson) as string[];
  const channels = [...new Set([...convSources.map(channelOf), ...callChannels])].sort(
    (a, b) => channelRank(a) - channelRank(b) || a.localeCompare(b),
  );
  return { items, nextCursor: rows.length > o.limit && last ? `${last.started_at}:${last.id}` : null, channels };
}

const MESSAGE_CAP = 500;

export function sessionMessages(db: DB, personId: string, sessionId: string): SessionMessages {
  const p = visiblePerson(db, personId);
  const identityIds = clusterIdentities(db, clusterIds(db, p.id)).map((i) => i.id);
  const s = db
    .prepare(
      `SELECT s.id, s.conversation_id, s.started_at, s.ended_at, c.source, c.title
       FROM sessions s JOIN conversations c ON c.id = s.conversation_id WHERE s.id = ?`,
    )
    .get(sessionId) as { id: string; conversation_id: string; started_at: number; ended_at: number; source: string; title: string | null } | undefined;
  const w = s && personConversations(db, identityIds).find((c) => c[0] === s.conversation_id);
  // Only sessions on this person's timeline: no reading arbitrary conversations through someone else's page.
  if (!s || !w || !inWindow(w, s.started_at, s.ended_at)) throw notFound('Session');

  const rows = db
    .prepare(
      `SELECT id, sent_at, is_from_me, kind, text, attachments IS NOT NULL AS has_att, edited_at, retracted_at, sender_identity_id
       FROM messages
       WHERE conversation_id = ? AND sent_at BETWEEN ? AND ? AND dup_of IS NULL AND is_spam = 0
       ORDER BY sent_at, id LIMIT ?`,
    )
    .all(s.conversation_id, s.started_at, s.ended_at, MESSAGE_CAP + 1) as {
    id: number;
    sent_at: number;
    is_from_me: number;
    kind: string;
    text: string | null;
    has_att: number;
    edited_at: number | null;
    retracted_at: number | null;
    sender_identity_id: string | null;
  }[];
  const msgs = rows.slice(0, MESSAGE_CAP);

  const senders = resolveSenders(
    db,
    [...new Set(msgs.filter((m) => !m.is_from_me && m.sender_identity_id).map((m) => m.sender_identity_id!))],
  );
  const reactions = new Map<number, { emoji: string; count: number }[]>();
  if (msgs.length > 0) {
    const rs = db
      .prepare(
        `SELECT message_id, coalesce(emoji, type) AS emoji, count(*) AS n FROM message_reactions
         WHERE message_id IN (SELECT value FROM json_each(?)) AND removed = 0
         GROUP BY message_id, coalesce(emoji, type) ORDER BY message_id, n DESC`,
      )
      .all(JSON.stringify(msgs.map((m) => m.id))) as { message_id: number; emoji: string; n: number }[];
    for (const r of rs) {
      const list = reactions.get(r.message_id) ?? [];
      list.push({ emoji: r.emoji, count: r.n });
      reactions.set(r.message_id, list);
    }
  }

  return {
    sessionId: s.id,
    conversationId: s.conversation_id,
    source: s.source,
    title: safe(s.title),
    truncated: rows.length > MESSAGE_CAP,
    messages: msgs.map((m) => ({
      id: m.id,
      sentAt: m.sent_at,
      isFromMe: m.is_from_me === 1,
      kind: m.kind,
      text: m.retracted_at != null ? null : m.text,
      hasAttachments: m.has_att === 1,
      edited: m.edited_at != null,
      retracted: m.retracted_at != null,
      sender: m.is_from_me === 1 ? null : m.sender_identity_id ? (senders.get(m.sender_identity_id) ?? { personId: null, label: null }) : { personId: null, label: null },
      reactions: reactions.get(m.id) ?? [],
    })),
  };
}

/**
 * Who sent a message, through canon: a visible person gets a link and their name; a hidden one gets neither (the
 * client shows "Someone"); anyone else (provisional, roster-only) gets the identity's masked label.
 */
function resolveSenders(db: DB, identityIds: string[]): Map<string, { personId: string | null; label: string | null }> {
  const out = new Map<string, { personId: string | null; label: string | null }>();
  if (identityIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.key, i.display_name AS ident_name, p.is_hidden, pv.id AS visible_id, pv.display_name AS visible_name
       FROM identities i
       LEFT JOIN person_canon pc ON pc.person_id = i.person_id
       LEFT JOIN people p ON p.id = coalesce(pc.canonical_id, i.person_id)
       LEFT JOIN person_visible pv ON pv.id = p.id
       WHERE i.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(identityIds)) as {
    id: string;
    kind: string;
    key: string;
    ident_name: string | null;
    is_hidden: number | null;
    visible_id: string | null;
    visible_name: string | null;
  }[];
  for (const r of rows) {
    if (r.visible_id) out.set(r.id, { personId: r.visible_id, label: maskText(r.visible_name ?? '') });
    else if (r.is_hidden === 1) out.set(r.id, { personId: null, label: null });
    else out.set(r.id, { personId: null, label: safe(r.ident_name) ?? identityValue(r.kind, r.key).value });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- routes

const IdParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) });
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['last', 'recent', 'added', 'close']).default('last'),
  status: z.enum(['all', 'new', 'known']).default('all'),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const TimelineQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  source: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .optional(),
});

export function peopleRoutes({ db }: RouteDeps): Router {
  const r = Router();

  r.get('/people', (req, res) => {
    const q = ListQuery.parse(req.query);
    res.json(listPeople(db, q) satisfies PeoplePage);
  });

  r.get('/people/:id', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(personDetail(db, id) satisfies PersonDetail);
  });

  r.get('/people/:id/identities/:identityId/reveal', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { identityId } = z.object({ identityId: z.string().regex(/^[0-9a-f-]{36}$/i) }).parse(req.params);
    res.json(revealIdentity(db, id, identityId) satisfies RevealedIdentity);
  });

  r.get('/people/:id/timeline', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const q = TimelineQuery.parse(req.query);
    res.json(personTimeline(db, id, q) satisfies TimelinePage);
  });

  r.get('/people/:id/sessions/:sessionId/messages', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { sessionId } = z.object({ sessionId: z.string().regex(/^[\w.:-]{1,128}$/) }).parse(req.params);
    res.json(sessionMessages(db, id, sessionId) satisfies SessionMessages);
  });

  return r;
}
