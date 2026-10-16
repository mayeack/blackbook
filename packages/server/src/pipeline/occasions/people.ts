/**
 * Who could have been at an occasion: an in-memory index of VISIBLE people (person_visible, canonical ids only:
 * hidden, merged-away, roster-only, service and "me" never appear), their 1:1 threads and small group chats,
 * and name lookup for the names the owner writes into calendar titles. Built once per occasions run.
 */
import { canonicalFirstNames, emailMatchKey, firstNameScore, lastNameScore, normalizeEmail, normalizeNamePart } from '@yb/shared';
import type { DB } from '../../db/connection';
import { groupKey } from './text';

export interface VisiblePerson {
  id: string;
  first: string;
  last: string;
  display: string;
}

export interface GroupInfo {
  id: string;
  /** 'conv' = a group chat, 'circle' = a circle. */
  type: 'conv' | 'circle';
  key: string;
  members: Set<string>;
}

/** LIKE patterns for Gmail addresses (dots and +tags don't matter there, so they match by emailMatchKey). */
const GMAIL_LIKE = ['gmail.com', 'googlemail.com'].map((domain) => `%@${domain}`);

/** Group chats larger than this never stand for "the people at dinner". */
export const SMALL_GROUP = 15;

export class PeopleIndex {
  readonly me: string | null;
  private readonly people = new Map<string, VisiblePerson>();
  private readonly canon = new Map<string, string>();
  private readonly byFirst = new Map<string, Set<string>>();
  /** direct conversation → its counterpart (canonical, visible) */
  readonly dmCounterpart = new Map<string, string>();
  readonly dmConvs = new Map<string, string[]>();
  /** group conversation → member count and visible members (canonical) */
  readonly groups = new Map<string, { size: number; title: string | null; members: Set<string> }>();
  readonly groupsOf = new Map<string, Set<string>>();
  readonly circles: GroupInfo[] = [];
  private readonly identityPerson = new Map<string, string | null>();
  /** First names (+ nickname-table forms), nicknames and full names of hidden people. */
  private readonly hidden = new Set<string>();

  constructor(private readonly db: DB) {
    this.me = (db.prepare(`SELECT id FROM people WHERE kind = 'me' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined) ?? null;
    for (const r of db.prepare('SELECT person_id, canonical_id FROM person_canon').all() as { person_id: string; canonical_id: string }[]) {
      this.canon.set(r.person_id, r.canonical_id);
    }
    const rows = db.prepare('SELECT id, first_name, last_name, nickname, display_name FROM person_visible').all() as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      nickname: string | null;
      display_name: string;
    }[];
    for (const r of rows) {
      const displayParts = normalizeNamePart(r.display_name).split(' ').filter(Boolean);
      const first = normalizeNamePart(r.first_name) || (displayParts.length ? displayParts[0]! : '');
      const last = normalizeNamePart(r.last_name) || (!r.first_name && displayParts.length > 1 ? displayParts[displayParts.length - 1]! : '');
      const p: VisiblePerson = { id: r.id, first, last, display: normalizeNamePart(r.display_name) };
      this.people.set(r.id, p);
      const keys = new Set<string>(first ? [first, ...canonicalFirstNames(first)] : []);
      const nick = normalizeNamePart(r.nickname);
      if (nick) keys.add(nick);
      for (const k of keys) this.index(k, r.id);
    }

    for (const r of db
      .prepare(`SELECT first_name, last_name, nickname, display_name FROM people WHERE kind = 'person' AND is_hidden = 1 AND merged_into_id IS NULL`)
      .all() as { first_name: string | null; last_name: string | null; nickname: string | null; display_name: string }[]) {
      const first = normalizeNamePart(r.first_name) || normalizeNamePart(r.display_name).split(' ')[0] || '';
      for (const k of [first, ...(first ? canonicalFirstNames(first) : []), normalizeNamePart(r.nickname), normalizeNamePart(r.display_name)]) {
        if (k) this.hidden.add(k);
      }
      const full = [normalizeNamePart(r.first_name), normalizeNamePart(r.last_name)].filter(Boolean).join(' ');
      if (full) this.hidden.add(full);
    }

    const members = db
      .prepare(
        `SELECT c.id AS conv, c.kind, c.title, c.member_count, cm.identity_id, i.person_id
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.is_active = 1
         JOIN identities i ON i.id = cm.identity_id AND i.status = 'active'
         WHERE c.kind IN ('direct', 'group') AND c.agent_excluded = 0`,
      )
      .all() as { conv: string; kind: 'direct' | 'group'; title: string | null; member_count: number | null; identity_id: string; person_id: string }[];
    const raw = new Map<string, { kind: 'direct' | 'group'; title: string | null; count: number | null; persons: Set<string> }>();
    for (const m of members) {
      let g = raw.get(m.conv);
      if (!g) raw.set(m.conv, (g = { kind: m.kind, title: m.title, count: m.member_count, persons: new Set() }));
      const pid = this.visibleCanonical(m.person_id);
      if (pid) g.persons.add(pid);
    }
    for (const [conv, g] of raw) {
      if (g.kind === 'direct') {
        if (g.persons.size !== 1) continue;
        const pid = [...g.persons][0]!;
        this.dmCounterpart.set(conv, pid);
        this.dmConvs.set(pid, [...(this.dmConvs.get(pid) ?? []), conv]);
        continue;
      }
      const size = Math.max(g.count ?? 0, g.persons.size + 1);
      this.groups.set(conv, { size, title: g.title, members: g.persons });
      if (size <= SMALL_GROUP + 1) for (const pid of g.persons) this.groupsOf.set(pid, new Set([...(this.groupsOf.get(pid) ?? []), conv]));
    }

    const circleRows = db
      .prepare(
        `SELECT c.id, c.name, cm.person_id FROM circles c
         LEFT JOIN circle_members cm ON cm.circle_id = c.id AND cm.excluded = 0
         WHERE c.status = 'active'`,
      )
      .all() as { id: string; name: string; person_id: string | null }[];
    const byCircle = new Map<string, GroupInfo>();
    for (const r of circleRows) {
      let c = byCircle.get(r.id);
      if (!c) byCircle.set(r.id, (c = { id: r.id, type: 'circle', key: groupKey(r.name), members: new Set() }));
      const pid = r.person_id ? this.visibleCanonical(r.person_id) : null;
      if (pid) c.members.add(pid);
    }
    this.circles.push(...[...byCircle.values()].filter((c) => c.key && c.members.size > 0));
  }

  private index(key: string, id: string) {
    let s = this.byFirst.get(key);
    if (!s) this.byFirst.set(key, (s = new Set()));
    s.add(id);
  }

  /** A written name that could stand for a hidden person ("Sam" when a hidden Samuel exists). */
  hiddenNamesake(norm: string): boolean {
    const n = normalizeNamePart(norm).replace(/^(?:the|my) /, '');
    if (this.hidden.has(n)) return true;
    const first = n.split(' ')[0] ?? '';
    return n.split(' ').length === 1 && [...canonicalFirstNames(first)].some((k) => this.hidden.has(k));
  }

  canonicalOf(personId: string): string {
    return this.canon.get(personId) ?? personId;
  }

  /** The canonical id if that person is visible, else null. */
  visibleCanonical(personId: string): string | null {
    const c = this.canonicalOf(personId);
    return this.people.has(c) ? c : null;
  }

  get(personId: string): VisiblePerson | undefined {
    return this.people.get(personId);
  }

  get size(): number {
    return this.people.size;
  }

  personOfIdentity(identityId: string | null): string | null {
    if (!identityId) return null;
    if (!this.identityPerson.has(identityId)) {
      const pid = this.db.prepare(`SELECT person_id FROM identities WHERE id = ? AND status = 'active'`).pluck().get(identityId) as string | undefined;
      this.identityPerson.set(identityId, pid ? this.visibleCanonical(pid) : null);
    }
    return this.identityPerson.get(identityId)!;
  }

  /** Visible person behind an email (exact key first, then the Gmail-insensitive match key). */
  personOfEmail(raw: string): string | null {
    const e = normalizeEmail(raw);
    if (!e) return null;
    const exact = this.db.prepare(`SELECT person_id FROM identities WHERE kind = 'email' AND key = ? AND status = 'active'`).pluck().get(e) as string | undefined;
    if (exact) return this.visibleCanonical(exact);
    const mk = emailMatchKey(e);
    if (!mk || mk === e || !mk.endsWith('@gmail.com')) return null;
    const rows = this.db
      .prepare(`SELECT key, person_id FROM identities WHERE kind = 'email' AND status = 'active' AND (key LIKE ? OR key LIKE ?)`)
      .all(...GMAIL_LIKE) as { key: string; person_id: string }[];
    const hit = rows.find((r) => emailMatchKey(r.key) === mk);
    return hit ? this.visibleCanonical(hit.person_id) : null;
  }

  /**
   * People a written name can stand for. One word: first name, nickname or a nickname-table equivalent
   * ("Sam" → Samuel, Samantha). Two or more: first + last name (a trailing initial matches the last name's
   * first letter); a multi-word name that matches nobody is not reduced to its first word.
   */
  lookupName(norm: string): { ids: string[]; full: boolean } {
    const tokens = normalizeNamePart(norm).replace(/^(?:the|my) /, '').split(' ').filter(Boolean);
    if (!tokens.length) return { ids: [], full: false };
    if (tokens.length === 1) return { ids: [...this.firstCandidates(tokens[0]!)].sort(), full: false };
    const first = tokens[0]!;
    const last = tokens.slice(1).join(' ');
    const initial = last.length === 1 ? last : null;
    const ids: string[] = [];
    for (const id of this.firstCandidates(first)) {
      const p = this.people.get(id)!;
      if (!p.last) continue;
      const lastOk = initial ? p.last.startsWith(initial) : lastNameScore(last, p.last) === 1;
      if (lastOk && firstNameScore(first, p.first) >= 0.9) ids.push(id);
    }
    if (!ids.length) for (const p of this.people.values()) if (p.display === tokens.join(' ')) ids.push(p.id);
    return { ids: [...new Set(ids)].sort(), full: true };
  }

  private firstCandidates(first: string): Set<string> {
    const ids = new Set<string>();
    for (const k of [first, ...canonicalFirstNames(first)]) for (const id of this.byFirst.get(k) ?? []) ids.add(id);
    return ids;
  }

  /** Closest 1:1 message (either direction) to `at`, in days, within ±`withinDays`; null if none. */
  nearestDmDays(personId: string, at: number, withinDays: number): number | null {
    const convs = this.dmConvs.get(personId);
    if (!convs?.length) return null;
    const span = withinDays * 86_400_000;
    const d = this.db
      .prepare(
        `SELECT min(abs(sent_at - @at)) FROM messages
         WHERE conversation_id IN (SELECT value FROM json_each(@convs)) AND sent_at BETWEEN @from AND @to AND is_bot = 0 AND dup_of IS NULL`,
      )
      .pluck()
      .get({ convs: JSON.stringify(convs), at, from: at - span, to: at + span }) as number | null;
    return d == null ? null : d / 86_400_000;
  }

  /** Two people share a small group chat. */
  shareSmallGroup(a: string, b: string): boolean {
    const ga = this.groupsOf.get(a);
    const gb = this.groupsOf.get(b);
    if (!ga || !gb) return false;
    for (const g of ga) if (gb.has(g)) return true;
    return false;
  }

  /** Small group chats and circles whose name matches a nickname ("the Climbing Crew"). */
  matchGroups(norm: string): GroupInfo[] {
    const key = groupKey(norm);
    if (!key) return [];
    const kw = key.split(' ');
    const matches = (other: string) => {
      if (!other) return false;
      if (other === key) return true;
      const ow = other.split(' ');
      const inter = kw.filter((w) => ow.includes(w));
      const union = new Set([...kw, ...ow]).size;
      return inter.some((w) => w.length >= 4) && inter.length / union >= 0.6;
    };
    const out: GroupInfo[] = [];
    for (const [id, g] of this.groups) {
      if (g.size > SMALL_GROUP + 1 || !g.members.size) continue;
      const k = groupKey(g.title);
      if (matches(k)) out.push({ id, type: 'conv', key: k, members: g.members });
    }
    for (const c of this.circles) if (c.members.size <= SMALL_GROUP && matches(c.key)) out.push(c);
    return out;
  }
}
