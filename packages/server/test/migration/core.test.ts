import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/connection';
import { canonicalId } from '../../src/db/canon';
import { withBatch } from '../../src/journal/batch';
import { undoBatch, undoRun } from '../../src/journal/undo';
import { formatReport, migrateLegacy, type MigrationReport } from '../../src/migration/index';
import { LegacyStore } from '../../src/migration/legacyStore';
import { openSnapshot, takeSnapshot } from '../../src/migration/snapshot';
import { memDb, newRun, tempDir } from '../helpers';
import { buildLegacyStore, keyedDictionary, legacyUuid, openLegacyFixture, REAL_ENTITIES, type Fixture } from './fixture';
import { NOW, scenario, TZ } from './scenario';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(fx: Fixture = scenario()) {
  const t = tempDir('yb-legacy-');
  cleanups.push(t.cleanup);
  mkSource(t.dir);
  const sourcePath = buildLegacyStore(path.join(t.dir, 'source', 'default.store'), fx);
  return { dir: t.dir, sourcePath, importsDir: path.join(t.dir, 'imports') };
}

function mkSource(dir: string) {
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
}

function run(db: DB, env: ReturnType<typeof setup>, o: Partial<Parameters<typeof migrateLegacy>[0]> = {}): MigrationReport {
  return migrateLegacy({ db, sourcePath: env.sourcePath, importsDir: env.importsDir, timeZone: TZ, now: NOW, ...o });
}

const P = (pk: number) => legacyUuid('Contact', pk);
const count = (db: DB, sql: string, ...p: unknown[]) => Number(db.prepare(sql).pluck().get(...p));
const person = (db: DB, pk: number) => db.prepare('SELECT * FROM people WHERE id = ?').get(P(pk)) as Record<string, unknown>;

/** Every journaled/visible thing a migration can create, summarized for "is it empty" checks. */
function visibleState(db: DB) {
  return {
    visiblePeople: count(db, 'SELECT count(*) FROM person_visible'),
    activePeople: count(db, "SELECT count(*) FROM people WHERE status IN ('active','merged')"),
    activeIdentities: count(db, "SELECT count(*) FROM identities WHERE status = 'active'"),
    activeTags: count(db, "SELECT count(*) FROM tags WHERE status = 'active'"),
    personTags: count(db, 'SELECT count(*) FROM person_tags'),
    activeCircles: count(db, "SELECT count(*) FROM circles WHERE status = 'active'"),
    circleMembers: count(db, 'SELECT count(*) FROM circle_members WHERE excluded = 0'),
    activeLocations: count(db, "SELECT count(*) FROM locations WHERE status = 'active'"),
    personLocations: count(db, 'SELECT count(*) FROM person_locations'),
    liveFacts: count(db, "SELECT count(*) FROM facts WHERE status IN ('tentative','confirmed')"),
    activeNotes: count(db, "SELECT count(*) FROM notes WHERE status = 'active'"),
    liveMerges: count(db, 'SELECT count(*) FROM merges WHERE undone_at IS NULL'),
    mergedPointers: count(db, 'SELECT count(*) FROM people WHERE merged_into_id IS NOT NULL'),
    liveAttendees: count(db, "SELECT count(*) FROM event_attendees WHERE status <> 'rejected'"),
    openCommitments: count(db, "SELECT count(*) FROM commitments WHERE status <> 'retracted'"),
    activeEdges: count(db, "SELECT count(*) FROM edge_labels WHERE status = 'active'"),
  };
}

describe('legacy migration — core phase', () => {
  it('maps the synthetic store and every equation holds', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.runId).toBeTruthy();
    for (const e of r.core!.equations) expect(e, e.name).toMatchObject({ ok: true });
    expect(r.core!.integrity).toEqual({ foreignKeyViolations: 0, canonCycles: 0, mergedIntoInactive: [] });
    expect(r.source).toMatchObject({ contacts: 14, mergedAway: 5, tagLinks: 5, groupLinks: 4, locationLinks: 2, activityContactLinks: 3 });
    expect(r.plist.failures).toEqual([]);
    expect(r.plist.encodings.keyed_archive).toBeGreaterThan(0);
    expect(r.plist.encodings.plain).toBe(4);

    expect(count(db, 'SELECT count(*) FROM people')).toBe(14);
    expect(count(db, "SELECT count(*) FROM runs WHERE kind = 'migration' AND status = 'ok'")).toBe(1);
    // field conversions
    const alex = person(db, 1);
    expect(alex).toMatchObject({
      display_name: 'Alex Rivera',
      birthday: '1990-03-15',
      origin: 'legacy',
      legacy_pk: 1,
      locked_fields: '[]',
      company: 'Example Co',
      job_title: 'Engineer', // filled from the merged-away duplicate (fill-empty only)
    });
    expect(JSON.parse(alex.custom as string)).toEqual({ nickname: 'Al' });
    expect(person(db, 13)).toMatchObject({ birthday: '--03-15', is_hidden: 1, is_priority: 1 });
    expect(person(db, 14)).toMatchObject({ display_name: '(unnamed)', first_name: null, last_name: null });
    expect(count(db, "SELECT count(*) FROM people WHERE locked_fields <> '[]'")).toBe(0);
  });

  it('turns merged-away rows into pointer merges: chains resolved, lost pointers recovered, orphans hidden', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    const m = r.core!.merges;
    expect(m.planned).toEqual({ pointer: 2, key_name: 1, name_only: 1 });
    expect(m.appliedLegacy).toBe(4);
    expect(m.maxChainDepth).toBe(2);
    expect(m.orphanIds).toEqual([P(12)]);
    expect(m.nameOnlyAuditIds).toEqual([P(10)]);
    expect(person(db, 2)).toMatchObject({ status: 'merged', merged_into_id: P(1) });
    expect(person(db, 3)).toMatchObject({ status: 'merged', merged_into_id: P(1) }); // 3 → 2 → 1 resolved to the root
    expect(person(db, 8)).toMatchObject({ status: 'merged', merged_into_id: P(9) });
    expect(person(db, 10)).toMatchObject({ status: 'merged', merged_into_id: P(11) });
    expect(person(db, 12)).toMatchObject({ status: 'active', merged_into_id: null, is_hidden: 1 });
    const evidence = db.prepare("SELECT json_extract(evidence, '$.basis') FROM merges WHERE merged_id = ?").pluck();
    expect(evidence.get(P(10))).toBe('name_only');
    expect(evidence.get(P(8))).toBe('key_name');
    expect(evidence.get(P(3))).toBe('pointer');
    expect(count(db, "SELECT count(*) FROM merges WHERE method = 'legacy'")).toBe(4);
    expect(count(db, "SELECT count(*) FROM person_visible WHERE id IN (?, ?, ?, ?, ?)", P(2), P(3), P(8), P(10), P(12))).toBe(0);
  });

  it('applies the shared-identity guard before any auto-merge', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    // Jordan Lee and Casey Morgan share a landline: names incompatible → shared=1, no merge
    const landline = db.prepare("SELECT person_id, shared FROM identities WHERE kind = 'phone' AND key = '+14155550123'").get();
    expect(landline).toEqual({ person_id: P(4), shared: 1 });
    expect(canonicalId(db, P(4))).not.toBe(canonicalId(db, P(5)));
    // Sam / Samuel Taylor share an email: compatible → one journaled auto-merge
    expect(canonicalId(db, P(6))).toBe(canonicalId(db, P(7)));
    expect(r.core!.merges.autoMerged).toBe(1);
    expect(count(db, "SELECT count(*) FROM merges WHERE method = 'migration'")).toBe(1);
    expect(r.core!.identities.conflicts).toEqual(
      expect.arrayContaining([
        { kind: 'phone', personIds: [P(4), P(5)], resolution: 'shared' },
        { kind: 'email', personIds: [P(6), P(7)], resolution: 'merged' },
      ]),
    );
    expect(r.core!.identities.sharedFlagged).toBe(1);
  });

  it('imports identities: E.164 phones, raw: unparseable phones at 0.5, merged-away keys only when unused', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    const ids = db.prepare('SELECT kind, key, person_id, confidence, match_method FROM identities ORDER BY kind, key').all();
    expect(ids).toEqual([
      { kind: 'email', key: 'alex.r@example.org', person_id: P(3), confidence: 1, match_method: 'legacy' },
      { kind: 'email', key: 'alex.rivera@example.com', person_id: P(1), confidence: 1, match_method: 'legacy' },
      { kind: 'email', key: 'sam.t@example.com', person_id: P(6), confidence: 1, match_method: 'legacy' },
      { kind: 'instagram_username', key: 'robin.park', person_id: P(11), confidence: 1, match_method: 'legacy' },
      { kind: 'linkedin_url', key: 'https://www.linkedin.com/in/robin-park-0101', person_id: P(11), confidence: 1, match_method: 'legacy' },
      { kind: 'phone', key: '+12125550101', person_id: P(1), confidence: 1, match_method: 'legacy' },
      { kind: 'phone', key: '+14155550123', person_id: P(4), confidence: 1, match_method: 'legacy' },
      { kind: 'phone', key: '+16465550142', person_id: P(9), confidence: 1, match_method: 'legacy' },
      { kind: 'phone', key: '+16465550177', person_id: P(7), confidence: 1, match_method: 'legacy' },
      { kind: 'phone', key: 'raw:5550100', person_id: P(12), confidence: 0.5, match_method: 'legacy' },
      { kind: 'phone', key: 'raw:5550199', person_id: P(13), confidence: 0.5, match_method: 'legacy' },
      { kind: 'x_username', key: 'robinp', person_id: P(11), confidence: 1, match_method: 'legacy' },
    ]);
    const i = r.core!.identities;
    expect(i).toMatchObject({ phonesE164: 7, phonesRaw: 2, emailsInvalid: 1, mergedAwayKeysAlreadyOwned: 2 });
    expect(i.unparseablePhonePersonIds).toEqual([P(12), P(13)]);
  });

  it('re-points memberships on merged-away people to the survivor and de-duplicates them', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    const tag = (name: string) => db.prepare('SELECT id FROM tags WHERE name = ?').pluck().get(name);
    expect(db.prepare('SELECT person_id, tag_id FROM person_tags ORDER BY person_id, tag_id').all()).toEqual(
      [
        { person_id: P(1), tag_id: tag('Friends') },
        { person_id: P(1), tag_id: tag('Work') },
        { person_id: P(6), tag_id: tag('Friends') }, // "friends" collapsed onto "Friends"
      ].sort((a, b) => `${a.person_id}${a.tag_id}`.localeCompare(`${b.person_id}${b.tag_id}`)),
    );
    expect(r.core!.links.tags).toEqual({ total: 5, orphan: 1, dupes: 1 });
    expect(r.core!.tagNameCollisions).toBe(1);
    expect(db.prepare('SELECT kind, locked, name FROM circles ORDER BY name').all()).toEqual([
      { kind: 'user', locked: 1, name: 'Book Club' },
      { kind: 'user', locked: 1, name: 'Climbing' },
    ]);
    expect(count(db, "SELECT count(*) FROM circle_members WHERE origin = 'legacy'")).toBe(3);
    expect(db.prepare('SELECT person_id FROM person_locations').pluck().all()).toEqual([P(1)]);
    // facts: merged-away "Jazz" folds into the survivor's "jazz"; location memberships become location_current
    expect(db.prepare('SELECT type, value FROM facts ORDER BY type, value').all()).toEqual([
      { type: 'address', value: '12 Example St, Springfield, IL 62701' },
      { type: 'home_location', value: 'Springfield, IL' },
      { type: 'interest', value: 'climbing' },
      { type: 'interest', value: 'jazz' },
      { type: 'location_current', value: 'Springfield' },
    ]);
    // notes stay on their original (pre-canon) person; reads join through canon
    expect(db.prepare("SELECT person_id FROM notes WHERE origin = 'legacy' ORDER BY person_id").pluck().all()).toEqual([null, P(2)]);
    expect(db.prepare("SELECT person_id, status, source FROM event_attendees ORDER BY person_id").all()).toEqual([
      { person_id: P(1), status: 'attended', source: 'legacy' },
      { person_id: P(4), status: 'attended', source: 'legacy' },
    ]);
    const ev = db.prepare("SELECT source, title, raw FROM events").get() as { source: string; title: string; raw: string };
    expect(ev.source).toBe('legacy_activity');
    expect(JSON.parse(ev.raw)).toMatchObject({ google_event_id: 'evt-synthetic-1', circle_ids: [legacyUuid('Group', 1)] });
    expect(db.prepare('SELECT label, directed, a_id, b_id FROM edge_labels ORDER BY label').all()).toEqual([
      { label: 'met_via', directed: 1, a_id: P(6), b_id: P(1) },
      { label: 'roommate', directed: 0, a_id: P(4), b_id: P(5) },
    ]);
    expect(db.prepare("SELECT person_id, owner, status FROM commitments").all()).toEqual([{ person_id: P(6), owner: 'me', status: 'open' }]);
    expect(db.prepare("SELECT action, subject_id, json_extract(payload, '$.kind') AS kind FROM feedback").all()).toEqual([
      { action: 'dismiss', subject_id: P(6), kind: 'fading' },
    ]);
  });

  it('is idempotent: a second real run inserts nothing', () => {
    const env = setup();
    const db = memDb();
    const first = run(db, env);
    expect(first.ok).toBe(true);
    const before = visibleState(db);
    const second = run(db, env, { now: NOW + 60_000 });
    expect(second.ok).toBe(true);
    expect(second.core!.inserted).toEqual({});
    expect(second.core!.merges).toMatchObject({ appliedLegacy: 0, autoMerged: 0 });
    expect(visibleState(db)).toEqual(before);
    for (const e of second.core!.equations) expect(e, e.name).toMatchObject({ ok: true });
    // the second run wrote no batches
    expect(count(db, 'SELECT count(*) FROM change_batches WHERE run_id = ?', second.runId)).toBe(0);
  });

  it('dry run: reports, proves idempotency with a second pass, and rolls everything back', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.runId).toBeNull();
    expect(r.core!.idempotency).toEqual({ secondPassInserted: 0, byTable: {} });
    expect(r.core!.inserted.people).toBe(14);
    for (const table of ['people', 'identities', 'runs', 'change_batches', 'merges', 'events', 'feedback', 'facts']) {
      expect(count(db, `SELECT count(*) FROM ${table}`), table).toBe(0);
    }
    // the report carries counts and ids only: no names, phones, emails, handles or note text
    const text = `${formatReport(r)}\n${JSON.stringify(r)}`;
    for (const s of ['Rivera', 'Alex', 'Jordan', 'Casey', 'Taylor', 'Robin', 'Drew', 'Pat Kim', '555', '@example', 'robin.park', 'climbing gym', 'Springfield', 'Friends']) {
      expect(text).not.toContain(s);
    }
    expect(formatReport(r)).toMatch(/people == ZCONTACT\s+14\s+14\s+ok/);
  });

  it('undoing the migration run leaves nothing visible behind', () => {
    const env = setup();
    const db = memDb();
    const r = run(db, env);
    expect(visibleState(db).visiblePeople).toBeGreaterThan(0);
    const undo = undoRun(db, r.runId!, { now: NOW + 1000 });
    expect(undo.undone.length).toBeGreaterThan(0);
    expect(visibleState(db)).toEqual({
      visiblePeople: 0,
      activePeople: 0,
      activeIdentities: 0,
      activeTags: 0,
      personTags: 0,
      activeCircles: 0,
      circleMembers: 0,
      activeLocations: 0,
      personLocations: 0,
      liveFacts: 0,
      activeNotes: 0,
      liveMerges: 0,
      mergedPointers: 0,
      liveAttendees: 0,
      openCommitments: 0,
      activeEdges: 0,
    });
    expect(count(db, "SELECT count(*) FROM person_canon WHERE person_id <> canonical_id")).toBe(0);
    expect(count(db, "SELECT count(*) FROM runs WHERE id = ? AND undone_at IS NOT NULL", r.runId)).toBe(1);
  });

  it('keeps undone decisions undone on a re-run (a split legacy merge, a removed tag, the whole import)', () => {
    const env = setup();
    const db = memDb();
    run(db, env);
    // the user splits the name-only merge and removes a tag
    const mergeBatch = db.prepare('SELECT batch_id FROM merges WHERE merged_id = ?').pluck().get(P(10)) as string;
    undoBatch(db, mergeBatch, { now: NOW + 1 });
    withBatch(db, { runId: newRun(db), kind: 'user_edit', title: 'Removed a tag', actor: 'user' }, (t) => {
      const row = db.prepare('SELECT person_id, tag_id FROM person_tags WHERE person_id = ?').get(P(6)) as { person_id: string; tag_id: string };
      t.delete('person_tags', row);
    });
    const again = run(db, env, { now: NOW + 10_000 });
    expect(again.problems).toEqual([]);
    expect(again.core!.inserted).toEqual({});
    expect(again.core!.respected).toEqual({ legacy_merges: 1, person_tags: 1 });
    expect(person(db, 10)).toMatchObject({ status: 'active', merged_into_id: null });
    expect(count(db, 'SELECT count(*) FROM person_tags WHERE person_id = ?', P(6))).toBe(0);

    // undo the whole import, then re-run: nothing comes back (redo is "undo the undo", not a re-import)
    const db2 = memDb();
    const first = run(db2, env);
    undoRun(db2, first.runId!, { now: NOW + 1000 });
    const rerun = run(db2, env, { now: NOW + 2000 });
    expect(rerun.ok).toBe(true);
    expect(rerun.core!.inserted).toEqual({});
    expect(visibleState(db2).visiblePeople).toBe(0);
    expect(visibleState(db2).personTags).toBe(0);
  });

  it('refuses a keyed archive it does not understand, writing nothing', () => {
    const fx = scenario();
    fx.contacts[3] = { ...fx.contacts[3]!, rawPhones: keyedDictionary() };
    const env = setup(fx);
    const db = memDb();
    const r = run(db, env);
    expect(r.ok).toBe(false);
    expect(r.plist.failures).toEqual([{ entity: 'Contact', pk: 4, column: 'ZPHONES', reason: 'keyed archive root class NSDictionary' }]);
    expect(r.problems.join(' ')).toMatch(/could not be decoded/);
    expect(count(db, 'SELECT count(*) FROM people')).toBe(0);
    expect(count(db, 'SELECT count(*) FROM runs')).toBe(0);
  });

  it('rejects merge cycles', () => {
    const fx = scenario();
    fx.contacts[1] = { ...fx.contacts[1]!, mergedInto: 3 }; // 2 → 3 → 2
    const env = setup(fx);
    const db = memDb();
    const r = run(db, env, { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/merge cycle/);
    expect(r.core).toBeUndefined();
    expect(count(db, 'SELECT count(*) FROM people')).toBe(0);
  });

  it('discovers join tables from Z_PRIMARYKEY in the real layout too', () => {
    const env = setup(scenario({ entities: REAL_ENTITIES }));
    const db = memDb();
    const r = run(db, env);
    expect(r.ok).toBe(true);
    const snap = openSnapshot(path.join(r.snapshot!.dir, 'default.store'));
    try {
      const store = new LegacyStore(snap);
      expect(store.joinTable('Contact', 'Tag')).toEqual({ table: 'Z_3TAGS', columns: ['Z_3CONTACTS1', 'Z_11TAGS'] });
      expect(store.joinTable('Contact', 'Group')).toEqual({ table: 'Z_3GROUPS', columns: ['Z_3CONTACTS3', 'Z_5GROUPS1'] });
      expect(store.joinTable('Location', 'Contact')).toEqual({ table: 'Z_3LOCATIONS', columns: ['Z_7LOCATIONS', 'Z_3CONTACTS2'] });
      expect(store.joinTable('Activity', 'Contact')).toEqual({ table: 'Z_1CONTACTS', columns: ['Z_1ACTIVITIES', 'Z_3CONTACTS'] });
    } finally {
      snap.close();
    }
  });
});

describe('legacy snapshot', () => {
  it('copies the store and its WAL (never -shm), checkpoints the copy, and leaves the source untouched', () => {
    const t = tempDir('yb-legacy-');
    cleanups.push(t.cleanup);
    mkSource(t.dir);
    const source = path.join(t.dir, 'source', 'default.store');
    const live = openLegacyFixture(source, scenario()); // still open: the data lives only in the -wal
    try {
      expect(fs.existsSync(`${source}-wal`)).toBe(true);
      expect(fs.existsSync(`${source}-shm`)).toBe(true);
      const before = fs.readdirSync(path.dirname(source)).sort();
      const snap = takeSnapshot({ sourcePath: source, importsDir: path.join(t.dir, 'imports'), now: NOW });
      expect(snap.copiedWal).toBe(true);
      expect(fs.readdirSync(snap.dir)).toEqual(['default.store']); // checkpointed into a single DELETE-journal file
      expect(fs.readdirSync(path.dirname(source)).sort()).toEqual(before);
      const db = openSnapshot(snap.storePath);
      try {
        expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
        expect(new LegacyStore(db).counts().contacts).toBe(14);
        expect(() => db.prepare('DELETE FROM ZCONTACT').run()).toThrow();
      } finally {
        db.close();
      }
    } finally {
      live.close();
    }
  });

  it('refuses an imports dir inside the legacy folder', () => {
    const env = setup();
    expect(() => takeSnapshot({ sourcePath: env.sourcePath, importsDir: path.join(path.dirname(env.sourcePath), 'x') })).toThrow(/must not be inside/);
  });
});
