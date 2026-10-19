/**
 * The owner's own records (identity/self.ts) and the self-link pass that moves my stray handles to me
 * (identity/selfLink.ts, run first by the nightly matcher). Invented names, 555-01xx numbers, example.com addresses
 * and Gmail addresses built at runtime only.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContactsResponse } from '@yb/shared/collector/v1';
import { applyContacts } from '../../src/adapters/addressbook/ingest';
import { sourceRun } from '../../src/adapters/common/context';
import { canonicalId } from '../../src/db/canon';
import { attachExternalIdentity } from '../../src/identity/external';
import { runMatcher } from '../../src/identity/matcher';
import { mergePeople } from '../../src/identity/merge';
import { loadSelf, selfRefs } from '../../src/identity/self';
import { undoBatch } from '../../src/journal/undo';
import { memDb, newRun, seedIdentity, seedPerson, T0 } from '../helpers';

type DB = ReturnType<typeof memDb>;
const GMAIL = ['gmail', 'com'].join('.');
const MY_GMAIL = `owner.example@${GMAIL}`;

/** Me with my number and my Gmail address; settings.self_handles lists the number and a second address. */
function world() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
  seedIdentity(db, me, 'phone', '+12125550100', { match_method: 'seed' });
  seedIdentity(db, me, 'email', MY_GMAIL, { match_method: 'seed' });
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('self_handles', ?, 0, 0)`).run(
    JSON.stringify(['+12125550100', 'owner@example.com']),
  );
  return { db, me };
}

const ownerOf = (db: DB, kind: string, key: string) => {
  const pid = db.prepare('SELECT person_id FROM identities WHERE kind = ? AND key = ?').pluck().get(kind, key) as string | undefined;
  return pid ? canonicalId(db, pid) : undefined;
};
const statusOf = (db: DB, id: string) => db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(id) as string;
const batchTouching = (db: DB, identityId: string) =>
  db
    .prepare(`SELECT batch_id FROM change_log WHERE entity = 'identities' AND entity_key LIKE ? ORDER BY seq DESC LIMIT 1`)
    .pluck()
    .get(`%${identityId}%`) as string;

describe('loadSelf', () => {
  it('is me, everyone merged into me, and whoever holds a handle of mine (Gmail aliases too)', () => {
    const { db, me } = world();
    const merged = seedPerson(db, { display_name: 'Owner Old Card', origin: 'legacy' });
    seedIdentity(db, merged, 'email', 'owner.work@example.com');
    mergePeople(db, { survivorId: me, mergedId: merged, method: 'user', runId: newRun(db, 'user'), actor: 'user', now: T0 });
    const alias = seedPerson(db, { display_name: 'Owner Example', origin: 'legacy' });
    seedIdentity(db, alias, 'email', `owner.example+shop@${GMAIL}`);
    seedIdentity(db, alias, 'email', 'owner.example@example.org');
    const dotted = seedPerson(db, { display_name: 'O E', status: 'provisional', origin: 'partiful' });
    seedIdentity(db, dotted, 'email', `ownerexample@${GMAIL}`);
    const configured = seedPerson(db, { display_name: 'Inbox', origin: 'legacy' });
    seedIdentity(db, configured, 'email', 'owner@example.com');
    // Not mine: a friend, a +tag outside Gmail, a key marked shared, a handle I unlinked from me.
    const friend = seedPerson(db, { display_name: 'Ava Quill' });
    seedIdentity(db, friend, 'phone', '+12125550101');
    const plus = seedPerson(db, { display_name: 'Tag Elsewhere' });
    seedIdentity(db, plus, 'email', 'owner+tag@example.com');
    const shared = seedPerson(db, { display_name: 'Family Inbox' });
    seedIdentity(db, shared, 'email', `owner.example+family@${GMAIL}`, { shared: 1 });
    const unlinked = seedPerson(db, { display_name: 'Not Me' });
    seedIdentity(db, unlinked, 'email', `o.wner.example@${GMAIL}`);
    db.prepare(`INSERT INTO identity_blocks (kind, key, person_id, created_at) VALUES ('email', ?, ?, 0)`).run(`o.wner.example@${GMAIL}`, me);

    const self = loadSelf(db);
    expect(self.meId).toBe(me);
    for (const id of [me, merged, alias, dotted, configured]) expect(self.people.has(id)).toBe(true);
    for (const id of [friend, plus, shared, unlinked]) expect(self.people.has(id)).toBe(false);
    expect(self.strays.map((s) => s.personId).sort()).toEqual([alias, dotted, configured].sort());
    expect(self.strays.find((s) => s.personId === alias)?.key).toBe(`owner.example+shop@${GMAIL}`);
    // A handle merged in with my old card is mine from now on.
    expect(selfRefs(db).isMine('email', 'owner.work@example.com')).toBe(true);
  });

  it('is just me (or nothing) without handles', () => {
    expect(loadSelf(memDb())).toMatchObject({ meId: null, strays: [] });
    const db = memDb();
    const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
    const self = loadSelf(db);
    expect([...self.people]).toEqual([me]);
  });
});

describe('self-link pass (nightly matcher)', () => {
  it('absorbs an agent-made person of mine, moves only my handle off an established record, undoably', () => {
    const { db, me } = world();
    const auto = seedPerson(db, { display_name: 'Owner Example', first_name: null, last_name: null, status: 'provisional', origin: 'beeper' });
    seedIdentity(db, auto, 'email', `owner.example+ig@${GMAIL}`);
    seedIdentity(db, auto, 'instagram_username', 'owner.example.ig');
    const legacy = seedPerson(db, { display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example', origin: 'legacy' });
    const legacyAlias = seedIdentity(db, legacy, 'email', `owner.example+shop@${GMAIL}`);
    seedIdentity(db, legacy, 'email', 'owner.example@example.org');

    const stats = runMatcher(db, { now: T0 });
    expect(stats.self_linked).toBe(2);
    expect(ownerOf(db, 'email', `owner.example+ig@${GMAIL}`)).toBe(me);
    expect(ownerOf(db, 'instagram_username', 'owner.example.ig')).toBe(me);
    expect(statusOf(db, auto)).toBe('suppressed');
    expect(ownerOf(db, 'email', `owner.example+shop@${GMAIL}`)).toBe(me);
    expect(ownerOf(db, 'email', 'owner.example@example.org')).toBe(legacy); // the rest of the record stays put
    expect(statusOf(db, legacy)).toBe('active');
    expect(loadSelf(db).strays).toEqual([]);
    expect(db.prepare(`SELECT count(*) FROM merges`).pluck().get()).toBe(0); // no whole record was folded into me

    // The owner says "not mine": the handle goes back, is blocked from me, and stays put on later nights.
    undoBatch(db, batchTouching(db, legacyAlias), { actor: 'user', now: T0 + 1000 });
    expect(ownerOf(db, 'email', `owner.example+shop@${GMAIL}`)).toBe(legacy);
    expect(loadSelf(db).people.has(legacy)).toBe(false);
    expect(runMatcher(db, { now: T0 + 2000 }).self_linked).toBe(0);
    expect(ownerOf(db, 'email', `owner.example+shop@${GMAIL}`)).toBe(legacy);
  });

  it('never pairs a record of mine with someone else first: my stray number lands on me before scoring', () => {
    const { db, me } = world();
    const stray = seedPerson(db, { display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example', origin: 'legacy' });
    seedIdentity(db, stray, 'email', 'owner@example.com');
    runMatcher(db, { now: T0 });
    expect(ownerOf(db, 'email', 'owner@example.com')).toBe(me);
  });
});

describe('new keys of mine', () => {
  it('an unseen Gmail alias or configured handle from any source attaches to me, never to a new person', () => {
    const { db, me } = world();
    const run = sourceRun(db, 'partiful', { now: T0 });
    const people = () => db.prepare(`SELECT count(*) FROM people`).pluck().get() as number;
    const before = people();
    attachExternalIdentity(run.ctx, { kind: 'email', key: `Owner.Example+Events@${GMAIL}`, displayName: 'Owner Example' });
    attachExternalIdentity(run.ctx, { kind: 'email', key: 'owner@example.com' });
    expect(ownerOf(db, 'email', `owner.example+events@${GMAIL}`)).toBe(me);
    expect(ownerOf(db, 'email', 'owner@example.com')).toBe(me);
    expect(people()).toBe(before);
    expect(db.prepare('SELECT display_name FROM people WHERE id = ?').pluck().get(me)).toBe('Me');
    attachExternalIdentity(run.ctx, { kind: 'email', key: 'ava@example.com', displayName: 'Ava Quill' });
    expect(ownerOf(db, 'email', 'ava@example.com')).not.toBe(me);
    expect(people()).toBe(before + 1);
  });

  it('my Contacts card counts a Gmail alias and a configured handle toward "two of my handles"', () => {
    const { db, me } = world();
    const items = [
      { id: 'card-me', given: 'Owner', family: 'Example', emails: [{ label: 'home', value: `Owner.Example+contacts@${GMAIL}` }, { label: 'work', value: 'owner@example.com' }] },
    ];
    const resp = ContactsResponse.parse({ api: 'v1', generated_at: T0, hash: crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex'), items });
    applyContacts(db, resp, { now: T0 });
    expect(ownerOf(db, 'addressbook_id', 'card-me')).toBe(me);
    expect(ownerOf(db, 'email', 'owner@example.com')).toBe(me);
    expect(db.prepare(`SELECT count(*) FROM people WHERE kind = 'person'`).pluck().get()).toBe(0);
  });
});
