/**
 * The matcher's view of the book (intelligence §1.5): one profile per canonical person that can take part in
 * probabilistic matching (kind 'person', status active / provisional / roster_only), loaded with a handful of bulk
 * queries. Profiles hold ids, normalized name tokens and counts only; nothing here is logged.
 */
import { computeCanon } from '../db/canon';
import type { DB } from '../db/connection';
import { placeName } from '../intel/placeNames';
import { firstCanon, isDerivedName, parseName, personName, type PersonName } from './matcherNames';
import { NAME_PRECEDENCE } from './resolver';

/** Groups larger than this give no graph evidence (intelligence §2: n > 40 → membership only). */
export const MAX_GRAPH_GROUP = 40;
/** Events (guest lists, occasions) larger than this give no neighbor evidence. */
export const MAX_GRAPH_EVENT = 60;

/** Going-like attendance (a guest list's GOING/APPROVED/checked-in, a host, an attended occasion). */
const GOING = new Set(['going', 'approved', 'checked_in', 'attended', 'host']);
/** Explicit guest lists: two people on one of these are two different people. */
const EXPLICIT = new Set(['partiful', 'user', 'legacy']);

export interface Membership {
  /** Kinds of this person's identities in the conversation (any state) / currently active. */
  kinds: Set<string>;
  activeKinds: Set<string>;
}

export interface Attendance {
  identityId: string | null;
  kind: string | null;
  going: boolean;
  explicit: boolean;
}

export interface Profile {
  id: string;
  displayName: string;
  status: string;
  /** Priority or hidden (G7). */
  protected: boolean;
  name: PersonName | null;
  firstCanon: string[];
  usernames: string[];
  cards: Set<string>;
  /** Active phone identity ids (two-active-phones penalty). */
  phones: string[];
  convs: Map<string, Membership>;
  /** 'event:<id>' (a Partiful/legacy event, or an occasion linked to one) | 'occ:<id>' → this person's rows. */
  events: Map<string, Attendance[]>;
  /** Names this person stated about themself (alias_obs source 'self_id'). */
  selfIds: PersonName[];
  /** A self-id says "new number" (exempts the two-phones penalty). */
  newNumber: boolean;
  cities: Set<string>;
  neighbors: Set<string>;
}

export interface Book {
  profiles: Map<string, Profile>;
  /** Canonical first name / last token → named profiles bearing it (in-book name frequency). */
  firstCount: Map<string, number>;
  lastCount: Map<string, number>;
  named: number;
  /** Phone identity id → sorted distinct UTC days with an inbound 1:1 message. */
  phoneDays: Map<string, number[]>;
  /** Distinct canonical people per group conversation / event key. */
  convSize: Map<string, number>;
  eventSize: Map<string, number>;
}

interface PersonRow {
  id: string;
  merged_into_id: string | null;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  kind: string;
  status: string;
  is_hidden: number;
  is_priority: number;
}

const ELIGIBLE = new Set(['active', 'provisional', 'roster_only']);
const rank = (source: string) => {
  const i = (NAME_PRECEDENCE as readonly string[]).indexOf(source);
  return i === -1 ? NAME_PRECEDENCE.length : i;
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function loadBook(db: DB): Book {
  const people = db
    .prepare('SELECT id, merged_into_id, display_name, first_name, last_name, kind, status, is_hidden, is_priority FROM people')
    .all() as PersonRow[];
  const canon = computeCanon(new Map(people.map((p) => [p.id, p.merged_into_id])));
  const profiles = new Map<string, Profile>();
  for (const p of people) {
    if (p.merged_into_id || p.kind !== 'person' || !ELIGIBLE.has(p.status)) continue;
    const name = personName(p);
    profiles.set(p.id, {
      id: p.id,
      displayName: p.display_name,
      status: p.status,
      protected: Boolean(p.is_hidden || p.is_priority),
      name,
      firstCanon: [],
      usernames: [],
      cards: new Set(),
      phones: [],
      convs: new Map(),
      events: new Map(),
      selfIds: [],
      newNumber: false,
      cities: new Set(),
      neighbors: new Set(),
    });
  }
  const ownerOf = (personId: string) => profiles.get(canon.get(personId) ?? personId);

  // identities → usernames, cards, phones; identity id → (profile, kind) for the episode tables below.
  const identOwner = new Map<string, { profile: Profile | undefined; root: string; kind: string }>();
  const idents = db.prepare(`SELECT id, person_id, kind, key FROM identities WHERE status = 'active'`).all() as {
    id: string;
    person_id: string;
    kind: string;
    key: string;
  }[];
  for (const i of idents) {
    const root = canon.get(i.person_id) ?? i.person_id;
    const profile = profiles.get(root);
    identOwner.set(i.id, { profile, root, kind: i.kind });
    if (!profile) continue;
    if (i.kind === 'instagram_username') profile.usernames.push(i.key);
    else if (i.kind === 'addressbook_id') profile.cards.add(i.key);
    else if (i.kind === 'phone' && i.key.startsWith('+')) profile.phones.push(i.id);
  }

  // Names: a person without a usable name falls back to its best observed alias; self-ids are kept apart.
  const aliases = db.prepare('SELECT identity_id, name_raw, source, descriptor, last_seen_at FROM alias_obs').all() as {
    identity_id: string;
    name_raw: string;
    source: string;
    descriptor: string | null;
    last_seen_at: number;
  }[];
  const best = new Map<string, { name: PersonName; rank: number; at: number }>();
  for (const a of aliases) {
    const profile = identOwner.get(a.identity_id)?.profile;
    if (!profile) continue;
    if (a.source === 'self_id') {
      if (a.descriptor === 'new_number') profile.newNumber = true;
      const n = parseName(a.name_raw);
      if (n) profile.selfIds.push(n);
      continue;
    }
    if (profile.name || isDerivedName(a.name_raw)) continue;
    const n = parseName(a.name_raw);
    if (!n) continue;
    const cur = best.get(profile.id);
    const r = rank(a.source);
    if (!cur || r < cur.rank || (r === cur.rank && a.last_seen_at > cur.at)) best.set(profile.id, { name: n, rank: r, at: a.last_seen_at });
  }
  for (const [id, b] of best) profiles.get(id)!.name = b.name;

  const firstCount = new Map<string, number>();
  const lastCount = new Map<string, number>();
  let named = 0;
  for (const p of profiles.values()) {
    if (!p.name) continue;
    named++;
    p.firstCanon = firstCanon(p.name.first);
    for (const c of p.firstCanon) bump(firstCount, c);
    if (p.name.last.length > 1) bump(lastCount, p.name.last);
  }

  // Group memberships (co-presence, shared groups, neighbors).
  const convPeople = new Map<string, Set<string>>();
  const members = db
    .prepare(
      `SELECT cm.conversation_id AS conv, cm.identity_id AS ident, cm.is_active AS active FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id WHERE c.kind = 'group'`,
    )
    .all() as { conv: string; ident: string; active: number }[];
  for (const m of members) {
    const o = identOwner.get(m.ident);
    if (!o) continue;
    let set = convPeople.get(m.conv);
    if (!set) convPeople.set(m.conv, (set = new Set()));
    set.add(o.root);
    if (!o.profile) continue;
    let ms = o.profile.convs.get(m.conv);
    if (!ms) o.profile.convs.set(m.conv, (ms = { kinds: new Set(), activeKinds: new Set() }));
    ms.kinds.add(o.kind);
    if (m.active) ms.activeKinds.add(o.kind);
  }
  const convSize = new Map([...convPeople].map(([k, v]) => [k, v.size]));

  // Event attendance: occasions linked to a Partiful/legacy event share that event's key.
  const eventPeople = new Map<string, Set<string>>();
  const kindOf = db.prepare('SELECT kind FROM identities WHERE id = ?').pluck();
  const att = db
    .prepare(
      `SELECT coalesce('event:' || coalesce(a.event_id, o.event_id), 'occ:' || a.occasion_id) AS ek, a.person_id, a.identity_id,
              a.status, a.source
       FROM event_attendees a LEFT JOIN occasions o ON o.id = a.occasion_id
       WHERE a.status NOT IN ('rejected','possible','withdrawn')`,
    )
    .all() as { ek: string; person_id: string; identity_id: string | null; status: string; source: string }[];
  for (const a of att) {
    const root = canon.get(a.person_id) ?? a.person_id;
    let set = eventPeople.get(a.ek);
    if (!set) eventPeople.set(a.ek, (set = new Set()));
    set.add(root);
    const profile = profiles.get(root);
    if (!profile) continue;
    const kind = a.identity_id ? ((identOwner.get(a.identity_id)?.kind ?? (kindOf.get(a.identity_id) as string | undefined)) ?? null) : null;
    const rows = profile.events.get(a.ek) ?? [];
    rows.push({ identityId: a.identity_id, kind, going: GOING.has(a.status), explicit: EXPLICIT.has(a.source) });
    profile.events.set(a.ek, rows);
  }
  const eventSize = new Map([...eventPeople].map(([k, v]) => [k, v.size]));

  // Neighbors: people sharing a small group or event.
  const link = (set: Set<string>) => {
    const ids = [...set].filter((id) => profiles.has(id));
    for (const x of ids) for (const y of ids) if (x !== y) profiles.get(x)!.neighbors.add(y);
  };
  for (const set of convPeople.values()) if (set.size <= MAX_GRAPH_GROUP) link(set);
  for (const set of eventPeople.values()) if (set.size <= MAX_GRAPH_EVENT) link(set);

  // Inbound 1:1 activity per phone identity (UTC days).
  const phoneDays = new Map<string, number[]>();
  const days = db
    .prepare(
      `SELECT m.sender_identity_id AS ident, m.sent_at / 86400000 AS day FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
       JOIN identities i ON i.id = m.sender_identity_id AND i.kind = 'phone' AND i.status = 'active'
       WHERE m.is_from_me = 0 AND m.kind NOT IN ('system','group_event')
       GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all() as { ident: string; day: number }[];
  for (const d of days) {
    const list = phoneDays.get(d.ident) ?? [];
    list.push(d.day);
    phoneDays.set(d.ident, list);
  }

  const cities = db
    .prepare(`SELECT person_id, value, value_norm FROM facts WHERE type = 'location_current' AND status IN ('tentative','confirmed')`)
    .all() as { person_id: string; value: string; value_norm: string }[];
  // By place name, so "LA" and "Los Angeles, CA" are one city.
  for (const c of cities) ownerOf(c.person_id)?.cities.add(placeName(c.value)?.name.toLowerCase() ?? c.value_norm);

  return { profiles, firstCount, lastCount, named, phoneDays, convSize, eventSize };
}
