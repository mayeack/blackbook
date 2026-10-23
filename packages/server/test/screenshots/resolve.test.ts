import { describe, expect, it } from 'vitest';
import { sourceRun } from '../../src/adapters/common/context';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { undoRun } from '../../src/journal/undo';
import { extractContact, type ExtractedContact } from '../../src/screenshots/extract';
import { resolveScreenshot } from '../../src/screenshots/resolve';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';
import {
  BIZ_EMAIL,
  BIZ_PHONE,
  businessCard,
  CARD_EMAIL,
  CARD_NAME,
  CARD_PHONE,
  CHAT_PHONE,
  chatWithNumber,
  contactCard,
  IG_HANDLE,
  IG_NAME,
  igProfile,
  MENTIONED_HANDLE,
  SOCIAL_HANDLE,
  socialProfile,
} from './fixtures';

const OWNER_PHONE = '+12125550100';

function setup() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example' });
  seedIdentity(db, me, 'phone', OWNER_PHONE);
  const run = sourceRun(db, 'screenshot', { now: T0, kind: 'import' });
  return { db, me, run, ctx: run.ctx };
}

const person = (db: DB, id: string) =>
  db.prepare('SELECT id, display_name, status, kind, origin FROM people WHERE id = ?').get(id) as {
    id: string;
    display_name: string;
    status: string;
    kind: string;
    origin: string;
  };
const identitiesOf = (db: DB, id: string) =>
  db.prepare('SELECT kind, key, source FROM identities WHERE person_id = ? ORDER BY kind').all(id) as { kind: string; key: string; source: string }[];
const peopleCount = (db: DB) => db.prepare(`SELECT count(*) FROM people`).pluck().get() as number;

const ex = (o: Partial<ExtractedContact>): ExtractedContact => ({ kind: 'contact_card', phones: [], emails: [], handles: [], name: null, followers: null, ...o });

describe('resolveScreenshot: existing people', () => {
  it('links by phone', () => {
    const { db, ctx } = setup();
    const p = seedPerson(db, { display_name: 'Jordan Ellis' });
    seedIdentity(db, p, 'phone', CARD_PHONE);
    expect(resolveScreenshot(ctx, extractContact(contactCard()))).toEqual({ status: 'linked', personId: p, created: false, via: 'phone' });
  });

  it('links by email, including a Gmail dot/+tag variant', () => {
    const { db, ctx } = setup();
    const p = seedPerson(db);
    // Gmail addresses assembled at runtime (synthetic local parts; the domain is what's under test).
    const gmail = (local: string) => `${local}@${'gmail'}.com`;
    seedIdentity(db, p, 'email', gmail('dana.park'));
    expect(resolveScreenshot(ctx, ex({ emails: [gmail('danapark+events')] }))).toMatchObject({ status: 'linked', personId: p, via: 'email' });
    // A different mailbox is someone new.
    const other = resolveScreenshot(ctx, ex({ emails: [gmail('dana.parks')] }));
    expect(other).toMatchObject({ status: 'linked', created: true, via: 'email' });
    expect((other as { personId: string }).personId).not.toBe(p);
  });

  it('links by Instagram username, or a Beeper identity whose raw value is the @handle', () => {
    const { db, ctx } = setup();
    const a = seedPerson(db);
    seedIdentity(db, a, 'instagram_username', IG_HANDLE);
    expect(resolveScreenshot(ctx, extractContact(igProfile()))).toMatchObject({ status: 'linked', personId: a, via: 'instagram_username' });
    const b = seedPerson(db);
    seedIdentity(db, b, 'beeper_user', 'beeper-user-77', { raw: '@blake_demo' });
    expect(resolveScreenshot(ctx, ex({ kind: 'instagram_profile', handles: ['blake_demo'] }))).toMatchObject({ status: 'linked', personId: b });
  });

  it('follows merges to the canonical person', () => {
    const { db, ctx } = setup();
    const survivor = seedPerson(db);
    const merged = seedPerson(db, { status: 'merged', merged_into_id: survivor });
    seedIdentity(db, merged, 'phone', CARD_PHONE);
    rebuildPersonCanon(db);
    expect(resolveScreenshot(ctx, extractContact(contactCard()))).toMatchObject({ status: 'linked', personId: survivor });
  });

  it('several different people → ambiguous, nothing written', () => {
    const { db, ctx, run } = setup();
    const a = seedPerson(db);
    const b = seedPerson(db);
    seedIdentity(db, a, 'phone', CARD_PHONE);
    seedIdentity(db, b, 'email', CARD_EMAIL);
    const before = peopleCount(db);
    expect(resolveScreenshot(ctx, extractContact(contactCard()))).toEqual({ status: 'ambiguous', reason: 'several_people' });
    expect(peopleCount(db)).toBe(before);
    expect(run.runId).toBeNull();
  });

  it('a roster-only person is brought forward to provisional, journaled in the import run', () => {
    const { db, ctx, run } = setup();
    const p = seedPerson(db, { status: 'roster_only' });
    seedIdentity(db, p, 'phone', CHAT_PHONE);
    expect(resolveScreenshot(ctx, extractContact(chatWithNumber()))).toMatchObject({ status: 'linked', personId: p });
    expect(person(db, p).status).toBe('provisional');
    expect(db.prepare('SELECT kind FROM runs WHERE id = ?').pluck().get(run.runId)).toBe('import');
    expect(db.prepare('SELECT kind FROM change_batches WHERE run_id = ?').pluck().all(run.runId)).toEqual(['person_update']);
  });

  it('a service or suppressed record is not a person to link', () => {
    const { db, ctx } = setup();
    const s = seedPerson(db, { status: 'service', kind: 'business' });
    seedIdentity(db, s, 'phone', CARD_PHONE, { status: 'service' });
    expect(resolveScreenshot(ctx, ex({ phones: [CARD_PHONE] }))).toEqual({ status: 'ambiguous', reason: 'not_a_person' });
  });

  it("an Instagram profile whose bio mentions someone known links nobody but the profile's owner", () => {
    const { db, ctx } = setup();
    const known = seedPerson(db);
    seedIdentity(db, known, 'instagram_username', MENTIONED_HANDLE);
    const r = resolveScreenshot(ctx, extractContact(igProfile('1,234', { bioMention: true })));
    expect(r).toMatchObject({ status: 'linked', created: true, via: 'instagram_username' });
    expect((r as { personId: string }).personId).not.toBe(known);
    expect(identitiesOf(db, (r as { personId: string }).personId)).toEqual([{ kind: 'instagram_username', key: IG_HANDLE, source: 'screenshot' }]);
  });

  it("an X-style profile with a bio mention resolves by the profile's own handle", () => {
    const { db, ctx } = setup();
    const known = seedPerson(db);
    seedIdentity(db, known, 'instagram_username', MENTIONED_HANDLE);
    const owner = seedPerson(db);
    seedIdentity(db, owner, 'instagram_username', SOCIAL_HANDLE);
    expect(resolveScreenshot(ctx, extractContact(socialProfile({ bioMention: true })))).toMatchObject({ status: 'linked', personId: owner, created: false });
  });

  it('a detached identity never matches', () => {
    const { db, ctx } = setup();
    const p = seedPerson(db);
    seedIdentity(db, p, 'phone', CHAT_PHONE, { status: 'detached' });
    expect(resolveScreenshot(ctx, extractContact(chatWithNumber()))).toEqual({ status: 'ambiguous', reason: 'not_a_card' });
  });
});

describe('resolveScreenshot: the owner', () => {
  it("the owner's own card → self", () => {
    const { db, ctx } = setup();
    const before = peopleCount(db);
    // The phone is the owner's; the email isn't known as his: a one-person screen showing his number is still him.
    expect(resolveScreenshot(ctx, extractContact(contactCard({ phone: '212-555-0100', email: 'owner@example.com' })))).toEqual({ status: 'self' });
    expect(peopleCount(db)).toBe(before);
  });

  it("the owner's handle → self; a chat holding the owner's number and someone else's links the other one", () => {
    const { db, ctx, me } = setup();
    seedIdentity(db, me, 'instagram_username', 'owner_demo');
    expect(resolveScreenshot(ctx, ex({ kind: 'instagram_profile', handles: ['owner_demo'] }))).toEqual({ status: 'self' });
    const p = seedPerson(db);
    seedIdentity(db, p, 'phone', CHAT_PHONE);
    expect(resolveScreenshot(ctx, ex({ kind: 'message', phones: [OWNER_PHONE, CHAT_PHONE] }))).toMatchObject({ status: 'linked', personId: p });
  });
});

describe('resolveScreenshot: new people', () => {
  it('a contact card nobody holds → one provisional person carrying the name and every identifier', () => {
    const { db, ctx, run } = setup();
    const r = resolveScreenshot(ctx, extractContact(contactCard()), { at: T0 - 3_600_000 });
    expect(r).toMatchObject({ status: 'linked', created: true, via: 'phone' });
    const id = (r as { personId: string }).personId;
    expect(person(db, id)).toMatchObject({ display_name: CARD_NAME, status: 'provisional', kind: 'person', origin: 'screenshot' });
    expect(identitiesOf(db, id)).toEqual([
      { kind: 'email', key: CARD_EMAIL, source: 'screenshot' },
      { kind: 'phone', key: CARD_PHONE, source: 'screenshot' },
    ]);
    expect(db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(id)).toBe(id);
    expect(db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck().get(id)).toBe(1);
    expect(db.prepare('SELECT first_seen_at FROM identities WHERE person_id = ? AND kind = ?').pluck().get(id, 'phone')).toBe(T0 - 3_600_000);
    run.finish();
    // Undo of the import run takes the person back out.
    undoRun(db, run.runId!, { now: T0 + 1000 });
    expect(person(db, id).status).toBe('suppressed');
  });

  it('an Instagram profile nobody holds → a person keyed by the username', () => {
    const { db, ctx } = setup();
    const r = resolveScreenshot(ctx, extractContact(igProfile()));
    expect(r).toMatchObject({ status: 'linked', created: true, via: 'instagram_username' });
    const id = (r as { personId: string }).personId;
    expect(person(db, id).display_name).toBe(IG_NAME);
    expect(identitiesOf(db, id)).toEqual([{ kind: 'instagram_username', key: IG_HANDLE, source: 'screenshot' }]);
  });

  it('a business card with one phone and one email creates a person', () => {
    const { db, ctx } = setup();
    const r = resolveScreenshot(ctx, extractContact(businessCard()));
    expect(r).toMatchObject({ status: 'linked', created: true });
    expect(identitiesOf(db, (r as { personId: string }).personId).map((i) => i.key).sort()).toEqual([BIZ_EMAIL, BIZ_PHONE].sort());
  });

  it('two phones on one card → ambiguous, no person', () => {
    const { db, ctx } = setup();
    const before = peopleCount(db);
    expect(resolveScreenshot(ctx, extractContact(businessCard({ secondPhone: true })))).toEqual({ status: 'ambiguous', reason: 'too_many_identifiers' });
    expect(peopleCount(db)).toBe(before);
  });

  it('a chat with an unknown number → ambiguous (not a one-person screen), no person', () => {
    const { db, ctx } = setup();
    const before = peopleCount(db);
    expect(resolveScreenshot(ctx, extractContact(chatWithNumber()))).toEqual({ status: 'ambiguous', reason: 'not_a_card' });
    expect(peopleCount(db)).toBe(before);
  });

  it('an identifier the owner unlinked (detached identity) is never re-attached to its old person', () => {
    const { db, ctx } = setup();
    const p = seedPerson(db, { display_name: 'Jordan Ellis' });
    seedIdentity(db, p, 'phone', CARD_PHONE, { status: 'detached' });
    const before = peopleCount(db);
    expect(resolveScreenshot(ctx, ex({ kind: 'contact_card', phones: [CARD_PHONE], name: CARD_NAME }))).toEqual({ status: 'ambiguous', reason: 'unlinked' });
    expect(peopleCount(db)).toBe(before);
    expect(db.prepare(`SELECT count(*) FROM identities WHERE key = ? AND status = 'active'`).pluck().get(CARD_PHONE)).toBe(0);
  });

  it('after the import run is undone, the same screen neither revives the suppressed person nor makes a new one', () => {
    const { db, ctx, run } = setup();
    const card = ex({ kind: 'contact_card', phones: [CARD_PHONE], name: CARD_NAME });
    const first = resolveScreenshot(ctx, card);
    expect(first).toMatchObject({ status: 'linked', created: true });
    run.finish();
    undoRun(db, run.runId!, { now: T0 + 1000 });
    const before = peopleCount(db);
    const again = sourceRun(db, 'screenshot', { now: T0 + 2000, kind: 'import' });
    expect(resolveScreenshot(again.ctx, card)).toEqual({ status: 'ambiguous', reason: 'not_a_person' });
    again.finish();
    expect(person(db, (first as { personId: string }).personId).status).toBe('suppressed');
    expect(peopleCount(db)).toBe(before);
  });

  it('a roster-only person matched on a contact card is brought forward to provisional (visible)', () => {
    const { db, ctx } = setup();
    const p = seedPerson(db, { status: 'roster_only' });
    seedIdentity(db, p, 'email', CARD_EMAIL);
    db.prepare('INSERT OR REPLACE INTO person_canon (person_id, canonical_id) VALUES (?, ?)').run(p, p);
    expect(db.prepare('SELECT 1 FROM person_visible WHERE id = ?').get(p)).toBeUndefined();
    expect(resolveScreenshot(ctx, extractContact(contactCard()))).toMatchObject({ status: 'linked', personId: p, via: 'email' });
    expect(db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck().get(p)).toBe(1);
  });

  it('service identifiers are dropped before resolving', () => {
    const { ctx } = setup();
    const noreply = 'no-reply' + '@' + 'tickets.example';
    expect(resolveScreenshot(ctx, ex({ emails: [noreply], phones: ['+18005550100'] }))).toEqual({ status: 'no_contact' });
  });
});
