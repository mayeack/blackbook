/**
 * Applies a core-phase plan to the yeackbot database. Every journaled row goes through withBatch (one batch per
 * entity group) or mergePeople (one batch per merge) under the caller's runs(kind='migration'), so undoing the
 * run undoes the import. Episode/system rows the journal doesn't cover (events from legacy activities, dismiss
 * feedback) are idempotent on their natural keys and tagged with the run in their JSON.
 * Idempotent by legacy UUID / natural key: rows that already exist are counted, never overwritten.
 */
import { canonicalId, computeCanon, CanonCycleError, rebuildPersonCanon } from '../db/canon';
import type { DB } from '../db/connection';
import { chooseSurvivor, mergePeople, MergeRefusedError } from '../identity/merge';
import { withBatch, type JournalTx, type Row } from '../journal/batch';
import { encodeKey } from '../journal/tables';
import { uuidv7 } from '@yb/shared';
import type { CorePlan } from './plan';

export interface ApplyResult {
  inserted: Record<string, number>;
  existing: Record<string, number>;
  merges: { legacy: number; auto: number; skipped: number; refused: Record<string, number> };
  /** identities already in the target, owned by someone outside the planned owner's canonical set */
  targetIdentityConflicts: number;
  /**
   * Rows/merges skipped because the user undid them since an earlier import (do_not_merge, suppressed people,
   * deleted memberships). Undo is sticky: a re-run never resurrects them.
   */
  respected: Record<string, number>;
  problems: string[];
}

/** Refusals that record a user decision rather than a problem. */
const USER_DECISIONS = new Set(['do_not_merge', 'suppressed']);

export interface ApplyOptions {
  runId: string;
  now: number;
}

const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

export function applyCore(db: DB, plan: CorePlan, o: ApplyOptions): ApplyResult {
  const res: ApplyResult = {
    inserted: {},
    existing: {},
    merges: { legacy: 0, auto: 0, skipped: 0, refused: {} },
    targetIdentityConflicts: 0,
    respected: {},
    problems: [],
  };
  const exists = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) !== undefined;
  const meta = (title: string) => ({ runId: o.runId, kind: 'migration' as const, title, actor: 'system' as const });
  const insert = (t: JournalTx, table: string, row: Row) => {
    t.insert(table, row);
    bump(res.inserted, table);
  };
  const seen = (table: string) => bump(res.existing, table);
  const removedBefore = db.prepare("SELECT 1 FROM change_log WHERE entity = ? AND entity_key = ? AND op = 'delete' LIMIT 1");
  /** A link row the journal shows was deleted (an undo or a user edit) stays deleted. */
  const wasRemoved = (table: string, key: Row) => removedBefore.get(table, encodeKey(table, key)) !== undefined;

  // People (merged-away ones start active; their merge is a separate, individually undoable batch).
  const legacyPkOwner = db.prepare('SELECT id FROM people WHERE legacy_pk = ?').pluck();
  withBatch(
    db,
    meta(`Imported ${plan.people.length} legacy contacts`),
    (t) => {
      for (const p of plan.people) {
        if (t.get('people', { id: p.id })) {
          seen('people');
          continue;
        }
        const other = legacyPkOwner.get(p.legacy_pk) as string | undefined;
        if (other) {
          res.problems.push(`legacy_pk ${String(p.legacy_pk)} already belongs to person ${other} (a different legacy store?)`);
          continue;
        }
        insert(t, 'people', { ...p });
      }
    },
    { now: o.now },
  );
  rebuildPersonCanon(db);

  const personStatus = db.prepare('SELECT status, merged_into_id FROM people WHERE id = ?');
  const refuse = (reason: string, kind: 'legacy_merges' | 'auto_merges') =>
    USER_DECISIONS.has(reason) ? bump(res.respected, kind) : bump(res.merges.refused, reason);
  for (const m of plan.merges) {
    const row = personStatus.get(m.mergedId) as { status: string; merged_into_id: string | null } | undefined;
    const target = personStatus.get(m.targetId) as { status: string } | undefined;
    if (!row || !target) {
      refuse('missing_person', 'legacy_merges');
      continue;
    }
    if (row.merged_into_id !== null || canonicalId(db, m.mergedId) === canonicalId(db, m.targetId)) {
      res.merges.skipped++;
      continue;
    }
    try {
      mergePeople(db, {
        survivorId: m.targetId,
        mergedId: m.mergedId,
        method: 'legacy',
        runId: o.runId,
        actor: 'system',
        evidence: { basis: m.basis, legacy_pk: m.mergedPk, target_legacy_pk: m.targetPk, chain_depth: m.depth },
        confidence: m.basis === 'name_only' ? 0.7 : 1,
        title: m.basis === 'name_only' ? 'Kept a legacy merge (name match only; check it)' : 'Kept a legacy merge',
        now: o.now,
      });
      res.merges.legacy++;
    } catch (e) {
      if (!(e instanceof MergeRefusedError)) throw e;
      refuse(e.reason, 'legacy_merges');
    }
  }

  const identityOwner = db.prepare('SELECT person_id FROM identities WHERE kind = ? AND key = ?').pluck();
  withBatch(
    db,
    meta(`Imported ${plan.identities.length} legacy phones, emails and accounts`),
    (t) => {
      for (const i of plan.identities) {
        const owner = identityOwner.get(i.kind, i.key) as string | undefined;
        if (owner !== undefined) {
          seen('identities');
          if (owner !== i.personId && canonicalId(db, owner) !== canonicalId(db, i.personId)) res.targetIdentityConflicts++;
          continue;
        }
        if (!t.get('people', { id: i.personId })) continue;
        insert(t, 'identities', {
          id: uuidv7(o.now),
          person_id: i.personId,
          kind: i.kind,
          key: i.key,
          raw: i.raw,
          source: 'legacy',
          match_method: 'legacy',
          confidence: i.confidence,
          shared: i.shared ? 1 : 0,
          first_seen_at: i.createdAt,
          created_by_run: o.runId,
        });
      }
    },
    { now: o.now },
  );

  const tagByName = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').pluck();
  const tagIds = new Map<string, string>();
  withBatch(
    db,
    meta(`Imported ${plan.tags.length} legacy tags`),
    (t) => {
      for (const tag of plan.tags) {
        const id = String(tag.id);
        if (t.get('tags', { id })) {
          seen('tags');
          tagIds.set(id, id);
          continue;
        }
        const sameName = tagByName.get(tag.name) as string | undefined;
        if (sameName) {
          seen('tags');
          tagIds.set(id, sameName);
          continue;
        }
        insert(t, 'tags', { ...tag });
        tagIds.set(id, id);
      }
      for (const pt of plan.personTags) {
        const key = { person_id: pt.personId, tag_id: tagIds.get(pt.tagId) ?? pt.tagId };
        if (t.get('person_tags', key)) seen('person_tags');
        else if (wasRemoved('person_tags', key)) bump(res.respected, 'person_tags');
        else if (exists('SELECT 1 FROM people WHERE id = ?', key.person_id) && exists('SELECT 1 FROM tags WHERE id = ?', key.tag_id)) {
          insert(t, 'person_tags', { ...key, origin: 'legacy', created_at: o.now });
        }
      }
    },
    { now: o.now },
  );

  withBatch(
    db,
    meta(`Imported ${plan.circles.length} legacy groups as circles`),
    (t) => {
      for (const c of plan.circles) {
        if (t.get('circles', { id: c.id })) seen('circles');
        else insert(t, 'circles', { ...c });
      }
      for (const m of plan.circleMembers) {
        const key = { circle_id: m.circleId, person_id: m.personId };
        if (t.get('circle_members', key)) seen('circle_members');
        else if (exists('SELECT 1 FROM people WHERE id = ?', m.personId)) insert(t, 'circle_members', { ...key, origin: 'legacy' });
      }
    },
    { now: o.now },
  );

  withBatch(
    db,
    meta(`Imported ${plan.locations.length} legacy locations`),
    (t) => {
      for (const l of plan.locations) {
        if (t.get('locations', { id: l.id })) seen('locations');
        else insert(t, 'locations', { ...l });
      }
      for (const pl of plan.personLocations) {
        const key = { person_id: pl.personId, location_id: pl.locationId };
        if (t.get('person_locations', key)) seen('person_locations');
        else if (wasRemoved('person_locations', key)) bump(res.respected, 'person_locations');
        else if (exists('SELECT 1 FROM people WHERE id = ?', pl.personId)) insert(t, 'person_locations', { ...key, origin: 'legacy', created_at: o.now });
      }
    },
    { now: o.now },
  );

  withBatch(
    db,
    meta(`Imported ${plan.notes.length} legacy notes`),
    (t) => {
      for (const n of plan.notes) {
        if (t.get('notes', { id: n.id })) seen('notes');
        else insert(t, 'notes', { ...n });
      }
    },
    { now: o.now },
  );

  // Facts have no legacy id: (person, type, value_norm) is the key, and a user's "wrong" (fact_blocks) wins.
  const factExists = db.prepare('SELECT 1 FROM facts WHERE person_id = ? AND type = ? AND value_norm = ?');
  const factBlocked = db.prepare('SELECT 1 FROM fact_blocks WHERE person_id = ? AND type = ? AND value_norm = ?');
  withBatch(
    db,
    meta(`Imported ${plan.facts.length} legacy addresses, interests and locations as facts`),
    (t) => {
      for (const f of plan.facts) {
        if (factExists.get(f.personId, f.type, f.valueNorm) || factBlocked.get(canonicalId(db, f.personId), f.type, f.valueNorm)) {
          seen('facts');
          continue;
        }
        insert(t, 'facts', {
          id: uuidv7(o.now),
          person_id: f.personId,
          type: f.type,
          value: f.value,
          value_norm: f.valueNorm,
          confidence: f.confidence,
          status: f.status,
          recorded_at: o.now,
          source: 'legacy',
          run_id: o.runId,
        });
      }
    },
    { now: o.now },
  );

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (id, source, source_event_id, kind, title, description, starts_at, ends_at, color_hex, icon, raw, created_at, updated_at)
     VALUES (@id, @source, @source_event_id, @kind, @title, @description, @starts_at, @ends_at, @color_hex, @icon, @raw, @created_at, @updated_at)`,
  );
  withBatch(
    db,
    meta(`Imported ${plan.events.length} legacy activities`),
    (t) => {
      for (const e of plan.events) {
        if (insertEvent.run(e).changes) bump(res.inserted, 'events');
        else seen('events');
      }
      const attendee = db.prepare('SELECT 1 FROM event_attendees WHERE event_id = ? AND person_id = ?');
      for (const a of plan.attendees) {
        if (attendee.get(a.eventId, a.personId)) seen('event_attendees');
        else if (exists('SELECT 1 FROM people WHERE id = ?', a.personId)) {
          insert(t, 'event_attendees', {
            id: uuidv7(o.now),
            event_id: a.eventId,
            person_id: a.personId,
            status: a.status,
            role: 'guest',
            source: 'legacy',
            confidence: 1,
            run_id: o.runId,
          });
        }
      }
    },
    { now: o.now },
  );

  withBatch(
    db,
    meta(`Imported ${plan.commitments.length} legacy reminders`),
    (t) => {
      for (const c of plan.commitments) {
        if (t.get('commitments', { id: c.id })) seen('commitments');
        else insert(t, 'commitments', { ...c, run_id: o.runId });
      }
    },
    { now: o.now },
  );

  const edgeExists = db.prepare('SELECT 1 FROM edge_labels WHERE a_id = ? AND b_id = ? AND label = ?');
  withBatch(
    db,
    meta(`Imported ${plan.edgeLabels.length} legacy relationships`),
    (t) => {
      for (const e of plan.edgeLabels) {
        if (edgeExists.get(e.aId, e.bId, e.label)) seen('edge_labels');
        else {
          insert(t, 'edge_labels', {
            id: uuidv7(o.now),
            a_id: e.aId,
            b_id: e.bId,
            label: e.label,
            directed: e.directed ? 1 : 0,
            confidence: e.confidence,
            status: 'active',
            origin: 'legacy',
            run_id: o.runId,
          });
        }
      }
    },
    { now: o.now },
  );

  const insertFeedback = db.prepare(
    `INSERT OR IGNORE INTO feedback (id, subject_type, subject_id, action, payload, channel, created_at)
     VALUES (@id, @subject_type, @subject_id, @action, @payload, @channel, @created_at)`,
  );
  for (const f of plan.feedback) {
    if (insertFeedback.run({ ...f, payload: JSON.stringify({ ...JSON.parse(String(f.payload)), migration_run: o.runId }) }).changes) {
      bump(res.inserted, 'feedback');
    } else seen('feedback');
  }

  // Same-person auto-merges (shared phone/email, compatible names) — after everything else, so the survivor is
  // chosen on full data richness. Same deterministic-key policy as live ingest; each one undoable on its own.
  for (const group of plan.autoMergeGroups) {
    for (let i = 1; i < group.length; i++) {
      const a = group[0]!;
      const b = group[i]!;
      if (!exists('SELECT 1 FROM people WHERE id = ?', a) || !exists('SELECT 1 FROM people WHERE id = ?', b)) {
        refuse('missing_person', 'auto_merges');
        continue;
      }
      if (canonicalId(db, a) === canonicalId(db, b)) {
        res.merges.skipped++;
        continue;
      }
      const { survivorId, mergedId } = chooseSurvivor(db, a, b, o.now);
      try {
        mergePeople(db, {
          survivorId,
          mergedId,
          method: 'migration',
          runId: o.runId,
          actor: 'system',
          evidence: { basis: 'shared_key' },
          confidence: 1,
          title: 'Merged two legacy contacts that share a phone or email',
          now: o.now,
        });
        res.merges.auto++;
      } catch (e) {
        if (!(e instanceof MergeRefusedError)) throw e;
        refuse(e.reason, 'auto_merges');
      }
    }
  }
  rebuildPersonCanon(db);
  return res;
}

export interface Equation {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
}

export interface Integrity {
  foreignKeyViolations: number;
  canonCycles: number;
  /** merged people whose canonical root is not an active person */
  mergedIntoInactive: string[];
}

/** Target-side checks, measured from the database (not from the apply counters). */
export function verifyCore(db: DB, plan: CorePlan, respected: Record<string, number> = {}): { equations: Equation[]; integrity: Integrity } {
  const n = (sql: string, ...p: unknown[]) => Number(db.prepare(sql).pluck().get(...p) ?? 0);
  const s = plan.source;
  const d = plan.diag;
  const legacyTagIds = JSON.stringify([...new Set(plan.tagIdMap.values())]);
  const eq = (name: string, expected: number, actual: number): Equation => ({ name, expected, actual, ok: expected === actual });
  const links = d.links;
  const equations = [
    eq('people == ZCONTACT', s.contacts, n('SELECT count(*) FROM people WHERE legacy_pk IS NOT NULL')),
    eq(
      'legacy merged == ZISMERGEDAWAY − orphans − cycles − undone',
      s.mergedAway - d.orphanMergedIds.length - d.cycles.flat().length - (respected.legacy_merges ?? 0),
      n(
        `SELECT count(DISTINCT m.merged_id) FROM merges m JOIN people p ON p.id = m.merged_id
         WHERE m.method = 'legacy' AND m.undone_at IS NULL AND p.legacy_pk IS NOT NULL`,
      ),
    ),
    eq('tags == ZTAG − same-name tags', s.tags - d.tagNameCollisions, n('SELECT count(*) FROM tags WHERE id IN (SELECT value FROM json_each(?))', legacyTagIds)),
    eq(
      'person_tags == Z_*TAGS − orphans − merged dupes − removed',
      links.tags.total - links.tags.orphan - links.tags.dupes - (respected.person_tags ?? 0),
      n(`SELECT count(*) FROM person_tags WHERE origin = 'legacy' AND tag_id IN (SELECT value FROM json_each(?))`, legacyTagIds),
    ),
    eq('circles == ZGROUP', s.groups, n("SELECT count(*) FROM circles WHERE kind = 'user' AND legacy_pk IS NOT NULL")),
    eq(
      'circle_members == Z_*GROUPS − orphans − dupes',
      links.groups.total - links.groups.orphan - links.groups.dupes,
      n(`SELECT count(*) FROM circle_members cm JOIN circles c ON c.id = cm.circle_id WHERE cm.origin = 'legacy' AND c.legacy_pk IS NOT NULL`),
    ),
    eq('locations == ZLOCATION', s.locations, n('SELECT count(*) FROM locations WHERE legacy_pk IS NOT NULL')),
    eq(
      'person_locations == Z_*LOCATIONS − orphans − dupes − removed',
      links.locations.total - links.locations.orphan - links.locations.dupes - (respected.person_locations ?? 0),
      n(`SELECT count(*) FROM person_locations pl JOIN locations l ON l.id = pl.location_id WHERE pl.origin = 'legacy' AND l.legacy_pk IS NOT NULL`),
    ),
    eq('notes == ZNOTE', s.notes, n("SELECT count(*) FROM notes WHERE origin = 'legacy'")),
    eq('events == ZACTIVITY', s.activities, n("SELECT count(*) FROM events WHERE source = 'legacy_activity'")),
    eq(
      'event_attendees == Z_*CONTACTS − orphans − dupes',
      links.activities.total - links.activities.orphan - links.activities.dupes,
      n("SELECT count(*) FROM event_attendees WHERE source = 'legacy'"),
    ),
    eq('commitments == ZREMINDER with a contact', s.reminders - d.remindersWithoutContact, n("SELECT count(*) FROM commitments WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(plan.commitments.map((c) => c.id)))),
    eq(
      'dismiss feedback == dismissed ZAPPNOTIFICATION with a contact',
      s.appNotificationsDismissed - d.dismissedWithoutContact,
      n("SELECT count(*) FROM feedback WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(plan.feedback.map((f) => f.id))),
    ),
  ];

  const fk = (db.pragma('foreign_key_check') as unknown[]).length;
  let canonCycles = 0;
  try {
    const rows = db.prepare('SELECT id, merged_into_id FROM people').all() as { id: string; merged_into_id: string | null }[];
    computeCanon(new Map(rows.map((r) => [r.id, r.merged_into_id])));
  } catch (e) {
    if (!(e instanceof CanonCycleError)) throw e;
    canonCycles = e.cycle.length;
  }
  const mergedIntoInactive = db
    .prepare(
      `SELECT p.id FROM people p JOIN person_canon c ON c.person_id = p.id JOIN people r ON r.id = c.canonical_id
       WHERE p.merged_into_id IS NOT NULL AND (r.status <> 'active' OR r.merged_into_id IS NOT NULL) ORDER BY p.id`,
    )
    .pluck()
    .all() as string[];
  return { equations, integrity: { foreignKeyViolations: fk, canonCycles, mergedIntoInactive } };
}
