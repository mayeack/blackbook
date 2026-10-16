import { afterEach, describe, expect, it } from 'vitest';
import { cursorMeta, readCursor } from '../../../src/adapters/common/cursors';
import { ingestSnapshot, SOURCE, ZPK_SCOPE, type ZpkMeta } from '../../../src/adapters/whatsapp/ingest';
import { canonicalId } from '../../../src/db/canon';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';
import { CHAT_SCHEMA, CONTACTS_SCHEMA, gus, jid, lid, WaFixture } from './fixture';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = T0 + 6 * HOUR;

const ME_PHONE = '+15125550100';
const ALEX = '+15125550101';
const BLAIR = '+15125550102';
const CASEY_LID = '100000000000003';
const DREW = '+15125550104';
const EMERY = '+15125550105';
const BLAIR_LID = '100000000000002';
const GROUP = gus('120363000000000001');

const fixtures: WaFixture[] = [];
const fixture = (o?: ConstructorParameters<typeof WaFixture>[0]) => {
  const f = new WaFixture(o);
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

const count = (db: DB, table: string, where = '1', ...args: unknown[]) =>
  db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get(...args) as number;
const identity = (db: DB, kind: string, key: string) =>
  db.prepare('SELECT id, person_id, status FROM identities WHERE kind = ? AND key = ?').get(kind, key) as
    | { id: string; person_id: string; status: string }
    | undefined;
const person = (db: DB, id: string) =>
  db.prepare('SELECT display_name, status, kind FROM people WHERE id = ?').get(canonicalId(db, id)) as { display_name: string; status: string; kind: string };

function withMe(): { db: DB; me: string; meIdent: string } {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
  const meIdent = seedIdentity(db, me, 'phone', ME_PHONE);
  return { db, me, meIdent };
}

/**
 * A 1:1 with Alex (address-book name + pushname), a group with Alex (admin), Blair twice (an @lid row mapped by
 * LID.ZWAZACCOUNT plus a stale phone row), Casey (@lid nobody maps), Drew (former member), me, and a status
 * broadcast that must stay out.
 */
function world(f: WaFixture) {
  const dm = f.addSession(jid(ALEX), 0, 'Alex Rivera');
  const grp = f.addSession(GROUP, 1, 'Climbing Crew');
  const status = f.addSession('status@broadcast', 3, null);
  const alexM = f.addMember(grp, jid(ALEX), { admin: true });
  const blairLidM = f.addMember(grp, lid(BLAIR_LID));
  f.addMember(grp, jid(BLAIR), { active: false });
  const caseyM = f.addMember(grp, lid(CASEY_LID));
  f.addMember(grp, jid(DREW), { active: false });
  f.addMember(grp, jid(ME_PHONE));
  f.addLidAccount(BLAIR_LID, BLAIR.slice(1));
  f.addContact({ name: 'Alex Rivera', jid: jid(ALEX), localPhone: '(512) 555-0101' });
  f.addPushName(jid(ALEX), 'Alex R');
  f.addPushName(lid(CASEY_LID), 'Casey Test');
  f.addPushName(lid(BLAIR_LID), 'Blair Sample');

  const msgs = {
    a1: f.addMessage({ session: dm, at: T0, text: 'are you around saturday?' }),
    m1: f.addMessage({ session: dm, from: 'me', at: T0 + MIN, text: 'yes!' }),
    a2: f.addMessage({ session: dm, at: T0 + 2 * MIN, type: 1, text: null }),
    sys: f.addMessage({ session: dm, at: T0 + 3 * MIN, type: 6, text: '15125550101', stanza: null }),
    link: f.addMessage({ session: dm, at: T0 + 4 * MIN, type: 7, text: 'https://example.com/route' }),
    b1: f.addMessage({ session: grp, from: blairLidM, at: T0 + 10 * MIN, text: 'who is in for thursday' }),
    c1: f.addMessage({ session: grp, from: caseyM, at: T0 + 11 * MIN, text: 'me' }),
    c2: f.addMessage({ session: grp, from: caseyM, at: T0 + 12 * MIN, type: 15, text: null }),
    g1: f.addMessage({ session: grp, from: alexM, at: T0 + 13 * MIN, groupEvent: 2, type: 6, text: 'Climbing Crew' }),
    mg: f.addMessage({ session: grp, from: 'me', at: T0 + 14 * MIN, text: 'count me in' }),
    st: f.addMessage({ session: status, at: T0 + 15 * MIN, text: 'a status update' }),
  };
  return { dm, grp, status, alexM, blairLidM, caseyM, msgs };
}

describe('whatsapp ingest: direct + group', () => {
  it('writes conversations, messages, identities and rosters from one snapshot', async () => {
    const { db, me } = withMe();
    const f = fixture();
    const w = world(f);
    const out = await ingestSnapshot(db, f.files(), { now: NOW, sourceMtime: NOW - MIN });
    expect(out.status).toBe('ok');

    // Conversations: the 1:1 and the group; the status broadcast stays out.
    const convs = db.prepare(`SELECT source_conv_id, kind, title, member_count FROM conversations WHERE source = 'whatsapp' ORDER BY kind`).all();
    expect(convs).toEqual([
      { source_conv_id: jid(ALEX), kind: 'direct', title: null, member_count: null },
      { source_conv_id: GROUP, kind: 'group', title: 'Climbing Crew', member_count: 4 }, // Alex, Blair, Casey + me
    ]);

    // Messages: '{chat_jid}:{stanza}', Core Data seconds → ms, kinds mapped, no status rows.
    expect(count(db, 'messages', 'source = ?', SOURCE)).toBe(10);
    const row = (stanza: string | null) =>
      db.prepare(`SELECT kind, text, is_from_me, sent_at, sender_identity_id, attachments FROM messages WHERE source_msg_id = ?`).get(`${jid(ALEX)}:${stanza}`) as
        | Record<string, unknown>
        | undefined;
    expect(row(w.msgs.a1.stanza)).toMatchObject({ kind: 'text', text: 'are you around saturday?', is_from_me: 0, sent_at: T0 });
    expect(row(w.msgs.m1.stanza)).toMatchObject({ kind: 'text', is_from_me: 1, sender_identity_id: null, sent_at: T0 + MIN });
    expect(row(w.msgs.a2.stanza)).toMatchObject({ kind: 'attachment', text: null, attachments: '[{"kind":"image"}]' });
    expect(row(w.msgs.link.stanza)).toMatchObject({ kind: 'link' });
    // A system row without a stanza id gets a stable hashed key and keeps no text.
    expect(db.prepare(`SELECT kind, text FROM messages WHERE source_msg_id LIKE ?`).get(`${jid(ALEX)}:~%`)).toEqual({ kind: 'system', text: null });
    expect(db.prepare(`SELECT kind FROM messages WHERE source_msg_id = ?`).pluck().get(`${GROUP}:${w.msgs.c2.stanza}`)).toBe('sticker');
    expect(db.prepare(`SELECT kind, text FROM messages WHERE source_msg_id = ?`).get(`${GROUP}:${w.msgs.g1.stanza}`)).toEqual({ kind: 'system', text: null });
    expect(count(db, 'messages', `text = 'a status update'`)).toBe(0);

    // Alex: a phone JID becomes the E.164 phone identity; the address-book name beats the pushname.
    const alex = identity(db, 'phone', ALEX)!;
    expect(person(db, alex.person_id)).toMatchObject({ display_name: 'Alex Rivera', status: 'provisional' });
    const aliases = db.prepare('SELECT name_raw FROM alias_obs WHERE identity_id = ? ORDER BY name_raw').pluck().all(alex.id);
    expect(aliases).toEqual(['Alex R', 'Alex Rivera']);
    expect(row(w.msgs.a1.stanza)!.sender_identity_id).toBe(alex.id);

    // Blair: the @lid maps to the phone through LID.ZWAZACCOUNT → one person with both identities.
    const blairPhone = identity(db, 'phone', BLAIR)!;
    const blairLid = identity(db, 'whatsapp_lid', lid(BLAIR_LID))!;
    expect(canonicalId(db, blairLid.person_id)).toBe(canonicalId(db, blairPhone.person_id));
    expect(person(db, blairPhone.person_id).display_name).toBe('Blair Sample');
    // Her group post is attributed to the phone identity (dedupe after mapping).
    expect(db.prepare('SELECT sender_identity_id FROM messages WHERE source_msg_id = ?').pluck().get(`${GROUP}:${w.msgs.b1.stanza}`)).toBe(blairPhone.id);

    // Casey: an @lid nothing maps stays its own (provisional: two posts) identity.
    const casey = identity(db, 'whatsapp_lid', lid(CASEY_LID))!;
    expect(person(db, casey.person_id)).toMatchObject({ display_name: 'Casey Test', status: 'provisional' });
    expect(identity(db, 'phone', DREW)).toBeTruthy();

    // Roster: deduped (Blair's two rows are one active member), Drew is a former member, me never a member.
    const members = db
      .prepare(
        `SELECT i.kind, i.key, cm.is_active, cm.role FROM conversation_members cm JOIN identities i ON i.id = cm.identity_id
         JOIN conversations c ON c.id = cm.conversation_id WHERE c.kind = 'group' ORDER BY i.key`,
      )
      .all();
    expect(members).toEqual([
      { kind: 'phone', key: ALEX, is_active: 1, role: 'admin' },
      { kind: 'phone', key: BLAIR, is_active: 1, role: 'member' },
      { kind: 'phone', key: DREW, is_active: 0, role: 'member' },
      { kind: 'whatsapp_lid', key: lid(CASEY_LID), is_active: 1, role: 'member' },
    ]);
    expect(count(db, 'conversation_members cm JOIN identities i ON i.id = cm.identity_id', 'i.person_id = ?', me)).toBe(0);
    // Drew never posted and is in one group: hidden until he qualifies.
    expect(person(db, identity(db, 'phone', DREW)!.person_id).status).toBe('roster_only');

    // The 1:1 and group sessions became interactions.
    expect(count(db, 'interactions', `person_id = ? AND kind = 'dm_session'`, alex.person_id)).toBe(1);
    expect(count(db, 'interactions', `kind = 'group_session'`)).toBeGreaterThan(0);

    // Watermark at MAX(Z_PK), the pass complete; every write was journaled in one run.
    const cur = readCursor(db, SOURCE, ZPK_SCOPE)!;
    expect(Number(cur.cursor)).toBe(w.msgs.st.pk);
    expect(cursorMeta<ZpkMeta>(cur)).toMatchObject({ complete: true, max_pk: w.msgs.st.pk, source_mtime: NOW - MIN, relinks: 0 });
    expect(db.prepare(`SELECT kind, status FROM runs`).all()).toEqual([{ kind: 'ingest', status: 'ok' }]);
    expect(out.status === 'ok' && out.details).toEqual({ chats: 1, groups: 1, lid_mapped: 1, lid_unmapped: 1 });
  });

  it('is idempotent: the same snapshot again writes nothing new', async () => {
    const { db } = withMe();
    const f = fixture();
    world(f);
    await ingestSnapshot(db, f.files(), { now: NOW });
    const before = {
      messages: count(db, 'messages'),
      people: count(db, 'people'),
      batches: count(db, 'change_batches'),
      aliases: count(db, 'alias_obs'),
      members: count(db, 'conversation_members'),
    };
    const out = await ingestSnapshot(db, f.files(), { now: NOW + HOUR });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.stats.messages_new).toBeUndefined();
    expect({
      messages: count(db, 'messages'),
      people: count(db, 'people'),
      batches: count(db, 'change_batches'),
      aliases: count(db, 'alias_obs'),
      members: count(db, 'conversation_members'),
    }).toEqual(before);
  });

  it('a self chat ("message yourself") is a self conversation without members', async () => {
    const { db } = withMe();
    const f = fixture();
    const s = f.addSession(jid(ME_PHONE), 0, null);
    f.addMessage({ session: s, from: 'me', at: T0, text: 'note to self' });
    await ingestSnapshot(db, f.files(), { now: NOW });
    expect(db.prepare(`SELECT kind FROM conversations WHERE source = 'whatsapp'`).pluck().get()).toBe('self');
    expect(count(db, 'conversation_members')).toBe(0);
    expect(count(db, 'interactions')).toBe(0);
  });
});

describe('whatsapp ingest: watermark, LID mapping later, re-link', () => {
  it('reads only rows above the watermark; a LID mapped later folds into the phone person', async () => {
    const { db } = withMe();
    const f = fixture();
    const w = world(f);
    await ingestSnapshot(db, f.files(), { now: NOW });
    const caseyLid = identity(db, 'whatsapp_lid', lid(CASEY_LID))!;
    const caseyBefore = caseyLid.person_id;

    // Later: the LID store learns Casey's number, and Casey writes again (now 1:1 too).
    const CASEY = '+15125550103';
    f.addLidAccount(CASEY_LID, CASEY.slice(1));
    const c3 = f.addMessage({ session: w.grp, from: w.caseyM, at: T0 + 30 * MIN, text: 'see you there' });
    const out = await ingestSnapshot(db, f.files(), { now: NOW + HOUR });
    expect(out.status === 'ok' && out.stats.messages_new).toBe(1);

    const caseyPhone = identity(db, 'phone', CASEY)!;
    expect(caseyPhone.person_id).toBe(caseyBefore); // the new phone identity joined the LID's person
    expect(canonicalId(db, identity(db, 'whatsapp_lid', lid(CASEY_LID))!.person_id)).toBe(canonicalId(db, caseyPhone.person_id));
    expect(db.prepare('SELECT sender_identity_id FROM messages WHERE source_msg_id = ?').pluck().get(`${GROUP}:${c3.stanza}`)).toBe(caseyPhone.id);
    expect(Number(readCursor(db, SOURCE, ZPK_SCOPE)!.cursor)).toBe(c3.pk);
  });

  it('an existing LID person and an existing phone person are linked by a journaled merge', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(EMERY), 0, null);
    const grp = f.addSession(GROUP, 1, 'Book Club');
    const m = f.addMember(grp, lid('100000000000005'));
    f.addMember(grp, jid(EMERY));
    f.addMessage({ session: dm, at: T0, text: 'hi' });
    f.addMessage({ session: dm, from: 'me', at: T0 + MIN, text: 'hey' });
    f.addMessage({ session: grp, from: m, at: T0 + 2 * MIN, text: 'one' });
    f.addMessage({ session: grp, from: m, at: T0 + 3 * MIN, text: 'two' });
    await ingestSnapshot(db, f.files(), { now: NOW });
    const phone = identity(db, 'phone', EMERY)!;
    const lidI = identity(db, 'whatsapp_lid', lid('100000000000005'))!;
    expect(canonicalId(db, phone.person_id)).not.toBe(canonicalId(db, lidI.person_id));

    f.addLidPair('100000000000005', EMERY.slice(1)); // the pair table is enough
    await ingestSnapshot(db, f.files(), { now: NOW + HOUR });
    expect(canonicalId(db, lidI.person_id)).toBe(canonicalId(db, phone.person_id));
    expect(count(db, 'merges', `method = 'deterministic'`)).toBe(1);
    expect(count(db, 'change_batches', `kind = 'merge'`)).toBe(1);
  });

  it('MAX(Z_PK) dropping (device re-linked) triggers a full re-upsert with no duplicates', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(ALEX), 0, null);
    const specs = [0, 1, 2, 3, 4].map((i) => ({ session: dm, at: T0 + i * MIN, text: `old ${i}`, ...(i % 2 ? { from: 'me' as const } : {}) }));
    const old = specs.map((s) => f.addMessage(s));
    await ingestSnapshot(db, f.files(), { now: NOW });
    expect(count(db, 'messages')).toBe(5);

    // Re-linked: the new store re-synced only the last two old messages (same stanza ids, new Z_PKs) plus one new.
    f.wipeMessages();
    for (const i of [3, 4]) f.addMessage({ ...specs[i]!, stanza: old[i]!.stanza });
    const fresh = f.addMessage({ session: dm, at: T0 + 10 * MIN, text: 'after relink' });
    expect(fresh.pk).toBeLessThan(old[4]!.pk);
    const out = await ingestSnapshot(db, f.files(), { now: NOW + HOUR });
    expect(out.status === 'ok' && out.stats).toMatchObject({ relinked: 1, messages_new: 1 });
    expect(count(db, 'messages')).toBe(6); // the permanent archive keeps the 3 pruned ones
    const meta = cursorMeta<ZpkMeta>(readCursor(db, SOURCE, ZPK_SCOPE));
    expect(meta).toMatchObject({ relinks: 1, max_pk: fresh.pk, complete: true });
  });

  it('a re-linked store that already grew past the watermark is caught by the anchor row', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(ALEX), 0, null);
    f.addMessage({ session: dm, at: T0, text: 'a' });
    const last = f.addMessage({ session: dm, at: T0 + MIN, text: 'b' });
    await ingestSnapshot(db, f.files(), { now: NOW });

    // History sync after a re-link filled Z_PKs 1..4 with other messages: MAX(Z_PK) went up, not down.
    f.wipeMessages();
    for (let i = 0; i < 4; i++) f.addMessage({ session: dm, at: T0 - (10 - i) * HOUR, text: `history ${i}` });
    expect(Number(f.chat.prepare('SELECT max(Z_PK) FROM ZWAMESSAGE').pluck().get())).toBeGreaterThan(last.pk);
    const out = await ingestSnapshot(db, f.files(), { now: NOW + HOUR });
    expect(out.status === 'ok' && out.stats).toMatchObject({ relinked: 1, messages_new: 4 });
    expect(count(db, 'messages')).toBe(6);
  });

  it('re-reads recent rows: a message deleted after ingest is retracted', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(ALEX), 0, null);
    const m = f.addMessage({ session: dm, at: NOW - HOUR, text: 'oops wrong chat' });
    f.addMessage({ session: dm, from: 'me', at: NOW - HOUR + MIN, text: 'ok' });
    await ingestSnapshot(db, f.files(), { now: NOW });
    // "Delete for everyone" rewrites the row in place: type 14, no text.
    f.chat.prepare('UPDATE ZWAMESSAGE SET ZMESSAGETYPE = 14, ZTEXT = NULL WHERE Z_PK = ?').run(m.pk);
    const out = await ingestSnapshot(db, f.files(), { now: NOW + 30 * MIN });
    expect(out.status === 'ok' && out.stats.overlap_rows).toBe(2);
    expect(db.prepare('SELECT text, retracted_at FROM messages WHERE source_msg_id = ?').get(`${jid(ALEX)}:${m.stanza}`)).toEqual({
      text: null,
      retracted_at: NOW - HOUR,
    });
  });

  it('pages: one transaction per page, cursor per page, same result as one page', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(ALEX), 0, null);
    for (let i = 0; i < 7; i++) f.addMessage({ session: dm, at: T0 + i * MIN, text: `m${i}` });
    const out = await ingestSnapshot(db, f.files(), { now: NOW, pageSize: 3 });
    expect(out.status === 'ok' && out.stats.pages).toBe(3);
    expect(count(db, 'messages')).toBe(7);
    expect(Number(readCursor(db, SOURCE, ZPK_SCOPE)!.cursor)).toBe(7);
  });

  it('an aborted pass keeps its last page cursor and reports partial', async () => {
    const { db } = withMe();
    const f = fixture();
    const dm = f.addSession(jid(ALEX), 0, null);
    for (let i = 0; i < 5; i++) f.addMessage({ session: dm, at: T0 + i * MIN, text: `m${i}` });
    const ctl = new AbortController();
    ctl.abort();
    const out = await ingestSnapshot(db, f.files(), { now: NOW, pageSize: 2, signal: ctl.signal });
    expect(out.status).toBe('partial');
    expect(count(db, 'messages')).toBe(0);
    expect(cursorMeta<ZpkMeta>(readCursor(db, SOURCE, ZPK_SCOPE)).complete).not.toBe(true);
    const again = await ingestSnapshot(db, f.files(), { now: NOW, pageSize: 2 });
    expect(again.status).toBe('ok');
    expect(count(db, 'messages')).toBe(5);
  });
});

describe('whatsapp ingest: schema guard', () => {
  it('a missing column is contract_broken and nothing is written', async () => {
    const { db } = withMe();
    const f = fixture({ chatSchema: CHAT_SCHEMA.replace('ZSTANZAID VARCHAR,', '') });
    const dm = f.addSession(jid(ALEX), 0, 'Alex Rivera');
    f.addMember(f.addSession(GROUP, 1, 'Climbing Crew'), jid(BLAIR));
    f.chat.prepare('INSERT INTO ZWAMESSAGE (ZCHATSESSION, ZISFROMME, ZMESSAGETYPE, ZMESSAGEDATE, ZTEXT) VALUES (?, 0, 0, 1, ?)').run(dm, 'synthetic');
    f.addPushName(jid(ALEX), 'Alex R');
    const before = { people: count(db, 'people'), batches: count(db, 'change_batches'), runs: count(db, 'runs') };
    const out = await ingestSnapshot(db, f.files(), { now: NOW });
    expect(out).toEqual({ status: 'contract_broken', missing: ['main.ZWAMESSAGE.ZSTANZAID'] });
    expect(count(db, 'messages')).toBe(0);
    expect(count(db, 'conversations')).toBe(0);
    expect({ people: count(db, 'people'), batches: count(db, 'change_batches'), runs: count(db, 'runs') }).toEqual(before);
    expect(readCursor(db, SOURCE, ZPK_SCOPE)).toBeUndefined();
  });

  it('checks the attached stores too (a renamed ContactsV2 column, a missing LID table)', async () => {
    const { db } = withMe();
    const f = fixture({ contactsSchema: CONTACTS_SCHEMA.replace('ZWHATSAPPID VARCHAR', 'ZWAID VARCHAR'), lidSchema: 'CREATE TABLE Z_METADATA (Z_VERSION INTEGER)' });
    f.addSession(jid(ALEX), 0, null);
    const out = await ingestSnapshot(db, f.files(), { now: NOW });
    expect(out).toEqual({ status: 'contract_broken', missing: ['contacts.ZWAADDRESSBOOKCONTACT.ZWHATSAPPID', 'lid.ZWAZACCOUNT'] });
  });

  it('missing optional stores are fine; the pair table is optional', async () => {
    const { db } = withMe();
    const f = fixture({ contacts: false, lid: false });
    const dm = f.addSession(jid(ALEX), 0, null);
    f.addMessage({ session: dm, at: T0, text: 'hi' });
    expect((await ingestSnapshot(db, f.files(), { now: NOW })).status).toBe('ok');
    expect(count(db, 'messages')).toBe(1);
  });

  it('a store with no WhatsApp tables yet (never linked) is not_linked', async () => {
    const { db } = withMe();
    const f = fixture({ chatSchema: 'CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY)', contacts: false, lid: false });
    expect(await ingestSnapshot(db, f.files(), { now: NOW })).toEqual({ status: 'not_linked' });
  });
});
