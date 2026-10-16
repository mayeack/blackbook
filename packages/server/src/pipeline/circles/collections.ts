/**
 * Circles / Tags / Locations: the read model and the owner's edits behind routes/circles.ts (DTOs in @yb/shared
 * api/circles.ts). Every write is one journal batch (actor 'user', undoable from Today); nothing is ever deleted:
 * collections are tombstoned (user circles, tags, locations → 'retracted'; auto circles → 'archived', which the
 * weekly pass respects and never revives), circle members are excluded (sticky: the agent never re-adds a person
 * the owner removed). Tag and location links are plain link rows (deleted on removal, as the journal allows).
 *
 * People are canonical and visible (person_visible): hidden, merged-away, roster-only and service people never
 * appear and can't be added; a merged-away id resolves to its survivor.
 */
import { normalizeNamePart, uuidv7, type CollectionCreate, type CollectionDetail, type CollectionMember, type CollectionSummary, type CollectionUpdate, type PersonChip } from '@yb/shared';
import type { DB } from '../../db/connection';
import { badRequest, HttpError, notFound } from '../../http/errors';
import { withBatch, type JournalTx } from '../../journal/batch';
import { withRun } from '../../journal/runs';
import { maskText } from '../../routes/people';
import { circleColor } from './run';

export type CollectionKind = 'circle' | 'tag' | 'location';

interface Def {
  table: 'circles' | 'tags' | 'locations';
  link: 'circle_members' | 'person_tags' | 'person_locations';
  linkCol: 'circle_id' | 'tag_id' | 'location_id';
  batchKind: 'circle' | 'tag' | 'location';
  noun: string;
}

const DEFS: Record<CollectionKind, Def> = {
  circle: { table: 'circles', link: 'circle_members', linkCol: 'circle_id', batchKind: 'circle', noun: 'circle' },
  tag: { table: 'tags', link: 'person_tags', linkCol: 'tag_id', batchKind: 'tag', noun: 'tag' },
  location: { table: 'locations', link: 'person_locations', linkCol: 'location_id', batchKind: 'location', noun: 'location' },
};

const NOUN_TITLE: Record<CollectionKind, string> = { circle: 'Circle', tag: 'Tag', location: 'Location' };

interface CollectionRow {
  id: string;
  name: string;
  kind: 'auto' | 'user' | null;
  description: string | null;
  color_hex: string | null;
  icon: string | null;
  locked: number;
  status: 'active' | 'retracted' | 'archived';
  updated_at: number;
}

function selectSql(type: CollectionKind): string {
  switch (type) {
    case 'circle':
      return `SELECT id, name, kind, description, color_hex, icon, locked, status, updated_at FROM circles`;
    case 'tag':
      return `SELECT id, name, NULL AS kind, NULL AS description, color_hex, NULL AS icon, 0 AS locked, status, updated_at FROM tags`;
    case 'location':
      return `SELECT id, name, NULL AS kind, NULL AS description, color_hex, icon, 0 AS locked, status, updated_at FROM locations`;
  }
}

/** Canonical visible members' link rows of one collection (excluded circle rows left out). */
function memberLinkSql(type: CollectionKind): string {
  const d = DEFS[type];
  const extra = type === 'circle' ? 'AND l.excluded = 0' : '';
  return `SELECT pc.canonical_id AS person_id, l.created_at, l.origin, ${type === 'circle' ? 'l.score' : 'NULL'} AS score
          FROM ${d.link} l JOIN person_canon pc ON pc.person_id = l.person_id JOIN person_visible v ON v.id = pc.canonical_id
          WHERE l.${d.linkCol} = ? ${extra}`;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function summary(db: DB, type: CollectionKind, r: CollectionRow, memberCount?: number): CollectionSummary {
  const count =
    memberCount ?? (db.prepare(`SELECT count(DISTINCT person_id) FROM (${memberLinkSql(type)})`).pluck().get(r.id) as number);
  return {
    type,
    id: r.id,
    name: maskText(r.name),
    kind: type === 'circle' ? r.kind : null,
    description: r.description === null ? null : maskText(r.description),
    color: r.color_hex,
    icon: r.icon,
    memberCount: count,
    locked: r.locked === 1,
    status: r.status,
    updatedAt: r.updated_at,
  };
}

export function listCollections(db: DB, type: CollectionKind, kind: 'auto' | 'user' | 'all' = 'all'): CollectionSummary[] {
  const where = type === 'circle' && kind !== 'all' ? `WHERE status = 'active' AND kind = ?` : `WHERE status = 'active'`;
  const rows = db.prepare(`${selectSql(type)} ${where}`).all(...(type === 'circle' && kind !== 'all' ? [kind] : [])) as CollectionRow[];
  const d = DEFS[type];
  const counts = new Map(
    (
      db
        .prepare(
          `SELECT l.${d.linkCol} AS id, count(DISTINCT pc.canonical_id) AS n FROM ${d.link} l
           JOIN person_canon pc ON pc.person_id = l.person_id JOIN person_visible v ON v.id = pc.canonical_id
           ${type === 'circle' ? 'WHERE l.excluded = 0' : ''} GROUP BY l.${d.linkCol}`,
        )
        .all() as { id: string; n: number }[]
    ).map((r) => [r.id, r.n]),
  );
  return rows
    .map((r) => summary(db, type, r, counts.get(r.id) ?? 0))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

function getActive(db: DB, type: CollectionKind, id: string): CollectionRow {
  const r = db.prepare(`${selectSql(type)} WHERE id = ?`).get(id) as CollectionRow | undefined;
  if (!r || r.status !== 'active') throw notFound(NOUN_TITLE[type]);
  return r;
}

interface PersonNameRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  state: PersonChip['state'];
}

function people(db: DB, ids: readonly string[]): Map<string, PersonNameRow> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT v.id, v.display_name, v.first_name, v.last_name, s.state FROM person_visible v LEFT JOIN person_stats s ON s.person_id = v.id
       WHERE v.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as PersonNameRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

export const chipOf = (p: PersonNameRow): PersonChip => ({
  id: p.id,
  displayName: maskText(p.display_name),
  firstName: p.first_name === null ? null : maskText(p.first_name),
  state: p.state ?? null,
});

/** Last name A–Z (locale-aware), first name tiebreaker, blank last names last. */
export function byName(a: PersonNameRow, b: PersonNameRow): number {
  const al = a.last_name?.trim() ?? '';
  const bl = b.last_name?.trim() ?? '';
  const af = a.first_name?.trim() || (al ? '' : a.display_name.trim());
  const bf = b.first_name?.trim() || (bl ? '' : b.display_name.trim());
  return (al ? 0 : 1) - (bl ? 0 : 1) || collator.compare(al, bl) || collator.compare(af, bf) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const ORIGIN_RANK: Record<string, number> = { user: 0, legacy: 1, auto: 2 };

function facetCounts(db: DB, memberIds: readonly string[], skip: { type: CollectionKind; id: string }) {
  const ids = JSON.stringify(memberIds);
  const facet = (type: CollectionKind) => {
    const d = DEFS[type];
    const rows = db
      .prepare(
        `SELECT c.id, c.name, count(DISTINCT pc.canonical_id) AS count FROM ${d.link} l
         JOIN ${d.table} c ON c.id = l.${d.linkCol} AND c.status = 'active'
         JOIN person_canon pc ON pc.person_id = l.person_id
         WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) ${type === 'circle' ? 'AND l.excluded = 0' : ''}
         GROUP BY c.id`,
      )
      .all(ids) as { id: string; name: string; count: number }[];
    return rows
      .filter((r) => !(type === skip.type && r.id === skip.id))
      .map((r) => ({ id: r.id, name: maskText(r.name), count: r.count }))
      .sort((a, b) => b.count - a.count || collator.compare(a.name, b.name))
      .slice(0, 20);
  };
  return { circles: facet('circle'), tags: facet('tag'), locations: facet('location') };
}

const SUGGESTION_REASON: Record<string, string> = {
  community: 'Often together with this circle',
  near_member: 'Close to several members',
};

export function collectionDetail(db: DB, type: CollectionKind, id: string, now = Date.now()): CollectionDetail {
  const row = getActive(db, type, id);
  const links = db.prepare(memberLinkSql(type)).all(id) as { person_id: string; created_at: number; origin: string; score: number | null }[];
  const best = new Map<string, { created_at: number; origin: string; score: number | null }>();
  for (const l of links) {
    const cur = best.get(l.person_id);
    if (!cur) {
      best.set(l.person_id, { ...l });
      continue;
    }
    cur.created_at = Math.min(cur.created_at, l.created_at);
    if ((ORIGIN_RANK[l.origin] ?? 3) < (ORIGIN_RANK[cur.origin] ?? 3)) cur.origin = l.origin;
    if (l.score !== null && (cur.score === null || l.score > cur.score)) cur.score = l.score;
  }
  const memberIds = [...best.keys()];
  const info = people(db, memberIds);
  const members: CollectionMember[] = [...info.values()].sort(byName).map((p) => {
    const l = best.get(p.id)!;
    return { person: chipOf(p), origin: l.origin, score: l.score, addedAt: l.created_at };
  });

  let suggestedAdditions: CollectionDetail['suggestedAdditions'] = [];
  if (type === 'circle') {
    const sugg = db
      .prepare(
        `SELECT pc.canonical_id AS person_id, max(s.score) AS score, min(s.reason) AS reason FROM circle_suggestions s
         JOIN person_canon pc ON pc.person_id = s.person_id
         WHERE s.circle_id = ? GROUP BY pc.canonical_id`,
      )
      .all(id) as { person_id: string; score: number; reason: string }[];
    const anyRow = new Set(
      (
        db
          .prepare(`SELECT DISTINCT pc.canonical_id FROM circle_members l JOIN person_canon pc ON pc.person_id = l.person_id WHERE l.circle_id = ?`)
          .pluck()
          .all(id) as string[]
      ),
    );
    const candidates = sugg.filter((s) => !anyRow.has(s.person_id));
    const sInfo = people(db, candidates.map((s) => s.person_id));
    suggestedAdditions = candidates
      .filter((s) => sInfo.has(s.person_id))
      .sort((a, b) => b.score - a.score || (a.person_id < b.person_id ? -1 : 1))
      .slice(0, 30)
      .map((s) => ({ person: chipOf(sInfo.get(s.person_id)!), score: Math.round(s.score * 1000) / 1000, reason: SUGGESTION_REASON[s.reason] ?? 'Suggested' }));
  }

  let fromFacts: PersonChip[] = [];
  if (type === 'location') {
    const norm = normalizeNamePart(row.name);
    if (norm) {
      const ids = db
        .prepare(
          `SELECT DISTINCT pc.canonical_id FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
           WHERE f.type IN ('location_current','home_location') AND f.status IN ('tentative','confirmed') AND f.sensitive = 0
             AND f.retracted_at IS NULL AND (f.valid_to IS NULL OR f.valid_to > ?)
             AND (lower(f.value_norm) = ? OR lower(f.value_norm) LIKE ? ESCAPE '\\')`,
        )
        .pluck()
        .all(now, norm, `${norm.replace(/[\\%_]/g, (c) => `\\${c}`)},%`) as string[];
      const memberSet = new Set(memberIds);
      const fInfo = people(db, ids.filter((x) => !memberSet.has(x)));
      fromFacts = [...fInfo.values()].sort(byName).slice(0, 50).map(chipOf);
    }
  }

  const last = memberIds.length
    ? (db.prepare(`SELECT max(last_at) FROM person_stats WHERE person_id IN (SELECT value FROM json_each(?))`).pluck().get(JSON.stringify(memberIds)) as
        | number
        | null)
    : null;

  return {
    collection: summary(db, type, row, members.length),
    members,
    suggestedAdditions,
    facets: facetCounts(db, memberIds, { type, id }),
    fromFacts,
    lastActivityAt: last ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- writes

/** The visible canonical person for an id (merged-away ids resolve to the survivor), else 400. */
export function resolveVisible(db: DB, personId: string): string {
  const canonical = (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(personId) as string | undefined) ?? personId;
  if (!db.prepare('SELECT 1 FROM person_visible WHERE id = ?').get(canonical)) throw badRequest('Unknown person.', { personId });
  return canonical;
}

function cluster(db: DB, canonical: string): string[] {
  const ids = db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(canonical) as string[];
  return ids.includes(canonical) ? ids : [canonical, ...ids];
}

/** Adds people to a collection inside a journal batch; returns how many were added. */
export function addMembers(t: JournalTx, type: CollectionKind, collectionId: string, personIds: readonly string[], origin: 'user' | 'auto' = 'user'): number {
  const d = DEFS[type];
  let n = 0;
  for (const p of new Set(personIds)) {
    const ids = cluster(t.db, p);
    const rows = t.db
      .prepare(`SELECT * FROM ${d.link} WHERE ${d.linkCol} = ? AND person_id IN (SELECT value FROM json_each(?)) ORDER BY person_id = ? DESC`)
      .all(collectionId, JSON.stringify(ids), p) as { person_id: string; excluded?: number; origin: string }[];
    if (type === 'circle') {
      const live = rows.find((r) => r.excluded === 0);
      if (live) {
        if (live.origin === 'auto' && origin === 'user') t.update('circle_members', { circle_id: collectionId, person_id: live.person_id }, { origin: 'user' });
        continue;
      }
      if (rows.length) {
        if (t.update('circle_members', { circle_id: collectionId, person_id: rows[0]!.person_id }, { excluded: 0, origin })) n++;
        continue;
      }
      t.insert('circle_members', { circle_id: collectionId, person_id: p, origin, excluded: 0, score: null });
      n++;
      continue;
    }
    if (rows.length) continue;
    t.insert(d.link, { person_id: p, [d.linkCol]: collectionId, origin });
    n++;
  }
  return n;
}

/** Removes people (sticky for circles); returns how many were removed. */
export function removeMembers(t: JournalTx, type: CollectionKind, collectionId: string, personIds: readonly string[]): number {
  const d = DEFS[type];
  let n = 0;
  for (const p of new Set(personIds)) {
    const ids = cluster(t.db, p);
    const rows = t.db
      .prepare(`SELECT * FROM ${d.link} WHERE ${d.linkCol} = ? AND person_id IN (SELECT value FROM json_each(?))`)
      .all(collectionId, JSON.stringify(ids)) as { person_id: string; excluded?: number }[];
    let removed = false;
    for (const r of rows) {
      if (type === 'circle') {
        if (r.excluded === 0 && t.update('circle_members', { circle_id: collectionId, person_id: r.person_id }, { excluded: 1 })) removed = true;
      } else if (t.delete(d.link, { person_id: r.person_id, [d.linkCol]: collectionId })) removed = true;
    }
    if (removed) n++;
  }
  return n;
}

const countPeople = (n: number) => (n === 1 ? '1 person' : `${n} people`);

export function createCollection(db: DB, type: CollectionKind, body: CollectionCreate, now = Date.now()): { collection: CollectionSummary; batchId: string | null } {
  const d = DEFS[type];
  const members = body.memberIds.map((p) => resolveVisible(db, p));
  const sameTag =
    type === 'tag' ? (db.prepare('SELECT id, status FROM tags WHERE name = ? COLLATE NOCASE').get(body.name) as { id: string; status: string } | undefined) : undefined;
  if (sameTag?.status === 'active') throw new HttpError(409, 'CONFLICT', 'A tag with that name already exists.');
  return withRun(
    db,
    'user',
    (runId) => {
      let id = uuidv7(now);
      const { batchId, changes } = withBatch(
        db,
        { runId, kind: d.batchKind, title: `Created a ${d.noun}${members.length ? ` with ${countPeople(members.length)}` : ''}`, actor: 'user' },
        (t) => {
          if (type === 'tag') {
            if (sameTag) {
              id = sameTag.id;
              t.update('tags', { id }, { status: 'active', name: body.name, ...(body.color ? { color_hex: body.color } : {}) });
            } else t.insert('tags', { id, name: body.name, color_hex: body.color ?? null, status: 'active' });
          } else if (type === 'location') {
            t.insert('locations', { id, name: body.name, color_hex: body.color ?? null, icon: body.icon ?? null, status: 'active' });
          } else {
            t.insert('circles', {
              id,
              name: body.name,
              kind: 'user',
              description: body.description ?? null,
              color_hex: body.color ?? circleColor(id),
              icon: body.icon ?? null,
              locked: 0,
              status: 'active',
            });
          }
          addMembers(t, type, id, members);
        },
        { now },
      );
      return { collection: summary(db, type, getActive(db, type, id)), batchId: changes ? batchId : null };
    },
    { now },
  );
}

export function updateCollection(db: DB, type: CollectionKind, id: string, patch: CollectionUpdate, now = Date.now()): { batchId: string | null } {
  const d = DEFS[type];
  const row = getActive(db, type, id);
  const p: Record<string, unknown> = {};
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.color !== undefined) p.color_hex = patch.color;
  if (type === 'circle' && patch.description !== undefined) p.description = patch.description;
  if (type !== 'tag' && patch.icon !== undefined) p.icon = patch.icon;
  if (type === 'tag' && patch.name !== undefined) {
    const same = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?').get(patch.name, id);
    if (same) throw new HttpError(409, 'CONFLICT', 'A tag with that name already exists.');
  }
  if (!Object.keys(p).length) return { batchId: null };
  return withRun(
    db,
    'user',
    (runId) => {
      const renamed = p.name !== undefined && p.name !== row.name;
      const { batchId, changes } = withBatch(
        db,
        { runId, kind: d.batchKind, title: renamed ? `Renamed a ${d.noun}` : `Edited a ${d.noun}`, actor: 'user' },
        (t) => t.update(d.table, { id }, p),
        { now },
      );
      if (changes && renamed && type === 'circle' && row.kind === 'auto') {
        db.prepare(`UPDATE circle_auto_meta SET named_by = 'user', updated_at = ? WHERE circle_id = ?`).run(now, id);
      }
      return { batchId: changes ? batchId : null };
    },
    { now },
  );
}

export function editMembers(db: DB, type: CollectionKind, id: string, edit: { add: string[]; remove: string[] }, now = Date.now()): { batchId: string | null } {
  const d = DEFS[type];
  getActive(db, type, id);
  const add = edit.add.map((p) => resolveVisible(db, p));
  const remove = edit.remove.map((p) => {
    const canonical = (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(p) as string | undefined) ?? p;
    return canonical;
  });
  if (add.some((p) => remove.includes(p))) throw badRequest('A person is both added and removed.');
  if (!add.length && !remove.length) return { batchId: null };
  return withRun(
    db,
    'user',
    (runId) => {
      const single = add.length + remove.length === 1 ? (add[0] ?? remove[0]!) : null;
      const { batchId, changes } = withBatch(
        db,
        {
          runId,
          kind: d.batchKind,
          title:
            add.length && remove.length
              ? `Changed the people in a ${d.noun}`
              : add.length
                ? `Added ${countPeople(add.length)} to a ${d.noun}`
                : `Removed ${countPeople(remove.length)} from a ${d.noun}`,
          actor: 'user',
          subjectPersonId: single,
        },
        (t) => {
          addMembers(t, type, id, add);
          removeMembers(t, type, id, remove);
        },
        { now },
      );
      return { batchId: changes ? batchId : null };
    },
    { now },
  );
}

export function deleteCollection(db: DB, type: CollectionKind, id: string, now = Date.now()): { batchId: string | null } {
  const d = DEFS[type];
  const row = getActive(db, type, id);
  return withRun(
    db,
    'user',
    (runId) => {
      const { batchId, changes } = withBatch(
        db,
        { runId, kind: d.batchKind, title: `Deleted a${type === 'circle' && row.kind === 'auto' ? 'n auto' : ''} ${d.noun}`, actor: 'user' },
        (t) => (type === 'circle' && row.kind === 'auto' ? t.update('circles', { id }, { status: 'archived' }) : t.tombstone(d.table, { id })),
        { now },
      );
      return { batchId: changes ? batchId : null };
    },
    { now },
  );
}
