/**
 * Settings → Privacy / Data read models and the one write (DTOs in @yb/shared api/settings.ts):
 *   doNotMergeList      pairs the matcher and merges refuse (split merges, undone merges, the owner's "not the same")
 *   allowMerge          removes one pair (journaled delete, undoable from Today)
 *   myIdentities        the owner's own identities, masked like Person → Linked accounts
 *   dataExport          the CRM data as one JSON document (Settings → Data). It is built for the owner's browser only
 *                       (behind Access, Cache-Control: no-store) and never sent anywhere else.
 * Hidden people are named only under Settings → Hidden: elsewhere here they read "Hidden contact".
 */
import { uuidv7, type BatchRef, type DoNotMergeList, type MyIdentities } from '@yb/shared';
import type { DB } from '../db/connection';
import { notFound } from '../http/errors';
import { withBatch } from '../journal/batch';
import { withRun } from '../journal/runs';
import { identityValue, maskText } from '../routes/people';
import { VERSION } from '../version';
import { readSetting } from './registry';

interface SideRow {
  id: string;
  display_name: string;
  is_hidden: number;
}

export function doNotMergeList(db: DB): DoNotMergeList {
  const rows = db.prepare('SELECT a_id, b_id, source, created_at FROM do_not_merge ORDER BY created_at DESC LIMIT 500').all() as {
    a_id: string;
    b_id: string;
    source: string;
    created_at: number;
  }[];
  const person = db.prepare('SELECT id, display_name, is_hidden FROM people WHERE id = ?');
  const side = (id: string) => {
    const p = person.get(id) as SideRow | undefined;
    const hidden = !p || p.is_hidden === 1;
    return { id, displayName: hidden ? 'Hidden contact' : maskText(p.display_name), hidden };
  };
  return { pairs: rows.map((r) => ({ a: side(r.a_id), b: side(r.b_id), source: r.source, createdAt: r.created_at })) };
}

/** "Allow merging again": removes the pair (the matcher may propose or merge it on a later night). */
export function allowMerge(db: DB, x: string, y: string, now = Date.now()): BatchRef {
  const [a, b] = x < y ? [x, y] : [y, x];
  if (!db.prepare('SELECT 1 FROM do_not_merge WHERE a_id = ? AND b_id = ?').get(a, b)) throw notFound('Do-not-merge pair');
  return withRun(
    db,
    'user',
    (runId) => {
      const r = withBatch(db, { runId, kind: 'merge_block', title: 'Allowed two people to be merged again', actor: 'user' }, (t) => t.delete('do_not_merge', { a_id: a, b_id: b }), {
        now,
      });
      return { batchId: r.changes ? r.batchId : null };
    },
    { now },
  );
}

export function myIdentities(db: DB): MyIdentities {
  const me = db.prepare(`SELECT id FROM people WHERE kind = 'me' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined;
  const handles = readSetting(db, 'self_handles');
  if (!me) return { personId: null, identities: [], selfHandleCount: handles.length };
  const ids = db
    .prepare(
      `SELECT i.id, i.kind, i.key, i.source FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id = ? AND i.status <> 'detached' ORDER BY CASE i.kind WHEN 'phone' THEN 0 WHEN 'email' THEN 1 ELSE 2 END, i.kind, i.id`,
    )
    .all(me) as { id: string; kind: string; key: string; source: string }[];
  return {
    personId: me,
    identities: ids.map((i) => ({ id: i.id, kind: i.kind, source: i.source, ...identityValue(i.kind, i.key) })),
    selfHandleCount: handles.length,
  };
}

/** The export document: people (with their accounts), facts, notes, collections and open loops. */
export function dataExport(db: DB, now = Date.now()): Record<string, unknown> {
  const all = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
  const people = all<Record<string, unknown>>(
    `SELECT id, display_name, first_name, last_name, nickname, company, job_title, birthday, is_priority, is_hidden, status, created_at, updated_at
     FROM people WHERE kind = 'person' AND merged_into_id IS NULL AND status IN ('active','provisional') ORDER BY last_name, first_name, id`,
  );
  const clusterOf = new Map<string, string>(all<{ person_id: string; canonical_id: string }>('SELECT person_id, canonical_id FROM person_canon').map((r) => [r.person_id, r.canonical_id]));
  const canon = (id: string) => clusterOf.get(id) ?? id;
  const group = <T extends { person_id: string }>(rows: T[]) => {
    const m = new Map<string, Omit<T, 'person_id'>[]>();
    for (const { person_id, ...rest } of rows) {
      const k = canon(person_id);
      m.set(k, [...(m.get(k) ?? []), rest]);
    }
    return m;
  };
  const identities = group(all<{ person_id: string }>(`SELECT person_id, kind, key, source, match_method, created_at FROM identities WHERE status <> 'detached'`));
  const facts = group(
    all<{ person_id: string }>(
      `SELECT person_id, type, value, status, sensitive, confidence, valid_from, valid_to, source, recorded_at FROM facts
       WHERE status IN ('tentative','confirmed','invalidated') AND retracted_at IS NULL ORDER BY recorded_at`,
    ),
  );
  const notes = group(all<{ person_id: string }>(`SELECT person_id, content, origin, created_at, updated_at FROM notes WHERE status = 'active' AND person_id IS NOT NULL ORDER BY created_at`));
  const commitments = group(
    all<{ person_id: string }>(`SELECT person_id, owner, kind, what, due_at, due_end, status, created_at FROM commitments WHERE status IN ('open','due','snoozed') ORDER BY created_at`),
  );
  const coll = (table: 'circles' | 'tags' | 'locations', link: string, col: string, extra = '') =>
    all<{ id: string; name: string }>(`SELECT id, name ${extra} FROM ${table} WHERE status = 'active' ORDER BY name`).map((c) => ({
      ...c,
      members: [
        ...new Set(
          (db.prepare(`SELECT person_id FROM ${link} WHERE ${col} = ?${table === 'circles' ? ' AND excluded = 0' : ''}`).pluck().all(c.id) as string[]).map(canon),
        ),
      ],
    }));
  return {
    format: 'yeackbot-export',
    version: 1,
    app: VERSION,
    exportedAt: new Date(now).toISOString(),
    people: people.map((p) => ({
      ...p,
      identities: identities.get(p.id as string) ?? [],
      facts: facts.get(p.id as string) ?? [],
      notes: notes.get(p.id as string) ?? [],
      openCommitments: commitments.get(p.id as string) ?? [],
    })),
    circles: coll('circles', 'circle_members', 'circle_id', ', kind, description'),
    tags: coll('tags', 'person_tags', 'tag_id'),
    locations: coll('locations', 'person_locations', 'location_id'),
    exportId: uuidv7(now),
  };
}
