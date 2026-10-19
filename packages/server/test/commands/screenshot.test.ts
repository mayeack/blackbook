/**
 * "Yb prioritize inviting this person to parties, is a great DJ" + an Instagram profile screenshot, end to end over a
 * synthetic self thread: the screenshot reaches the intent route, "this person" is matched by username or added as
 * a roster-only person, the fact and the Party invites preference are journaled in the command's run, one ack goes
 * out, and `undo` reverts all of it. Invented people and handles only.
 */
import { describe, expect, it } from 'vitest';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import type { AttachmentSource, ImageRef } from '../../src/adapters/imessage/attachments';
import { resolveScreenshotPerson } from '../../src/commands/screenshot';
import { IMAGE_REF } from '../../src/commands/intent';
import { withBatch } from '../../src/journal/batch';
import { addToPreference, preferredPeople } from '../../src/pipeline/circles/preferences';
import type { LlmImage } from '../../src/llm/types';
import { FakeLlmClient, type FakeCall } from '../fakes/llm';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';
import { BRIEF_AT, commandsWorld, MIN, setSetting } from './world';

const at = (mins: number) => BRIEF_AT + mins * MIN;
const SCREENSHOT = { mime: 'image/png', uti: 'public.png', name: 'Screenshot 2026-10-14.png', bytes: 1_900_000, is_sticker: false };
const TEXT = 'Yb prioritize inviting this person to parties, is a great DJ';

function fakeAttachments(): AttachmentSource & { calls: ImageRef[] } {
  const calls: ImageRef[] = [];
  const img: LlmImage = { mediaType: 'image/jpeg', data: Buffer.from('synthetic profile screenshot').toString('base64'), width: 723, height: 1568 };
  return { configured: true, calls, image: async (ref) => (calls.push(ref), img) };
}

/** What Haiku answers for the headline text when it can see the profile (and only then). */
function partyAnswer(call: FakeCall, handle = '@yb.eval.rowan', name: string | null = 'Rowan Testperson') {
  const seen = call.images > 0;
  return {
    json: {
      intent: 'set_preference',
      image: seen ? { handle, name } : null,
      command: null,
      log: {
        people: [{ surface: 'this person', ref: seen ? IMAGE_REF : null }],
        kind: 'other',
        date: null,
        facts: seen ? [{ ref: IMAGE_REF, cat: 'activity_pref', value: 'great DJ' }] : [],
        note: null,
      },
      preferences: [{ surface: 'this person', ref: seen ? IMAGE_REF : null, kind: 'party_invites' }],
      question: null,
    },
  };
}

const party = (db: ReturnType<typeof memDb>) => [...preferredPeople(db, 'party_invites')];

describe('yb + profile screenshot: who, what they are, how to treat them', () => {
  it('an unknown username → a roster-only person with the Instagram identity, the fact, Party invites; one ack; undo reverts it all', async () => {
    const attachments = fakeAttachments();
    const llm = new FakeLlmClient({ responder: (call) => partyAnswer(call) });
    const w = commandsWorld({ llm, attachments });
    w.person('Sam', 'Rivera');
    const { commandId, messageId } = w.say(TEXT, at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });

    // The screenshot went to the intent route (Haiku), and only there.
    expect(attachments.calls).toEqual([{ messageGuid: w.db.prepare('SELECT source_msg_id FROM messages WHERE id = ?').pluck().get(messageId), index: 0 }]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ kind: 'intent', route: 'intent', model: 'claude-haiku-5-5', images: 1 });
    expect(llm.calls[0]!.userText).toContain('### IMAGE ATTACHED\nyes');

    const ident = w.db.prepare(`SELECT id, person_id, raw, source, status FROM identities WHERE kind = 'instagram_username' AND key = 'yb.eval.rowan'`).get() as Record<string, string>;
    expect(ident).toMatchObject({ raw: '@yb.eval.rowan', source: 'screenshot', status: 'active' });
    const person = ident.person_id!;
    expect(w.db.prepare('SELECT display_name, status, origin FROM people WHERE id = ?').get(person)).toEqual({ display_name: 'Rowan Testperson', status: 'roster_only', origin: 'screenshot' });
    expect(w.db.prepare('SELECT type, value, source, status FROM facts WHERE person_id = ?').get(person)).toEqual({ type: 'activity_pref', value: 'great DJ', source: 'user_log', status: 'confirmed' });
    expect(w.db.prepare('SELECT content FROM notes WHERE person_id = ?').pluck().get(person)).toBe(TEXT.replace(/^Yb /, ''));
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0); // a preference is not a meeting
    expect(w.db.prepare(`SELECT name, kind, status FROM circles WHERE signature = 'pref:party_invites'`).get()).toEqual({ name: 'Party invites', kind: 'user', status: 'active' });
    expect(party(w.db)).toEqual([person]);

    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Noted for Rowan T. (new, from your screenshot).\nNoted: “great DJ”\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`);
    expect(w.command(commandId)).toMatchObject({ status: 'handled', intent: 'set_preference' });
    expect(w.command(commandId).parsed).toMatchObject({ images: 1, llm: true });
    const batches = w.db.prepare(`SELECT kind, actor FROM change_batches ORDER BY rowid`).all();
    expect(batches).toEqual([
      { kind: 'create_person', actor: 'user' },
      { kind: 'text_log', actor: 'user' },
      { kind: 'circle', actor: 'user' },
    ]);

    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: note for Rowan T. + prioritized for party invites`);
    expect(w.db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(person)).toBe('suppressed');
    expect(w.db.prepare('SELECT status FROM facts WHERE person_id = ?').pluck().get(person)).toBe('rejected');
    expect(party(w.db)).toEqual([]);
  });

  it('a username someone already has → that person (no new one); sending it again later is idempotent', async () => {
    const llm = new FakeLlmClient({ responder: (call) => partyAnswer(call, 'Yb.Eval.Rowan') });
    const w = commandsWorld({ llm, attachments: fakeAttachments() });
    const rowan = w.person('Rowan', 'Testperson');
    w.db
      .prepare(
        `INSERT INTO identities (id, person_id, kind, key, raw, source, match_method, confidence, status, created_at, updated_at)
         VALUES ('ident-ig', ?, 'instagram_username', 'yb.eval.rowan', '@yb.eval.rowan', 'beeper', 'deterministic', 1, 'active', ?, ?)`,
      )
      .run(rowan, T0, T0);
    const before = w.db.prepare('SELECT count(*) FROM people').pluck().get();
    w.say(TEXT, at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });
    expect(w.db.prepare('SELECT count(*) FROM people').pluck().get()).toBe(before);
    expect(party(w.db)).toEqual([rowan]);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Noted for Rowan T.\nNoted: “great DJ”\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`);

    w.say(TEXT, at(10), { attachments: [SCREENSHOT] });
    await w.run({ now: at(11) });
    expect(party(w.db)).toEqual([rowan]);
    expect(w.db.prepare(`SELECT count(*) FROM facts WHERE person_id = ?`).pluck().get(rowan)).toBe(1); // the same fact isn't added twice
    expect(w.db.prepare(`SELECT count(*) FROM circles WHERE signature = 'pref:party_invites'`).pluck().get()).toBe(1);
  });

  it('a name typed in the text works without a screenshot; an ambiguous one is asked first', async () => {
    const llm = new FakeLlmClient({
      responder: (call) => {
        const tokens = [...call.userText.matchAll(/^(P\w+) = Sam [A-Z]\.$/gm)].map((m) => m[1]!);
        return {
          json: {
            intent: 'set_preference',
            image: null,
            command: null,
            log: null,
            preferences: [{ surface: 'Sam', ref: tokens.length === 1 ? tokens[0] : null, kind: 'party_invites' }],
            question: null,
          },
        };
      },
    });
    const w = commandsWorld({ llm, attachments: fakeAttachments() });
    const sam = w.person('Sam', 'Rivera');
    w.say('yb always invite Sam to my parties', at(0));
    await w.run({ now: at(1) });
    expect(party(w.db)).toEqual([sam]);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Noted for Sam R.\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`);

    const samK = w.person('Sam', 'Kowalski');
    w.say('yb always invite Sam to my parties', at(10));
    await w.run({ now: at(11) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Which Sam did you mean?\n1. Sam R.\n2. Sam K.\nReply 1 or 2.`);
    w.say('2', at(12));
    await w.run({ now: at(13) });
    expect(party(w.db).sort()).toEqual([sam, samK].sort());
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Noted for Sam K.\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`);
  });

  it('a preference about the screenshot person with no log at all: the person and the preference, no note of facts', async () => {
    const llm = new FakeLlmClient({
      responder: () => ({
        json: {
          intent: 'set_preference',
          image: { handle: 'yb.eval.rowan', name: 'Rowan Testperson' },
          command: null,
          log: null,
          preferences: [{ surface: 'them', ref: IMAGE_REF, kind: 'party_invites' }],
          question: null,
        },
      }),
    });
    const w = commandsWorld({ llm, attachments: fakeAttachments() });
    w.say('yb invite them to every party', at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });
    const person = w.db.prepare(`SELECT person_id FROM identities WHERE key = 'yb.eval.rowan'`).pluck().get() as string;
    expect(party(w.db)).toEqual([person]);
    expect(w.db.prepare('SELECT count(*) FROM facts').pluck().get()).toBe(0);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Noted for Rowan T. (new, from your screenshot).\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`);
  });

  it('a screenshot person whose "First L." is the owner’s own is acked by full name', async () => {
    const w = commandsWorld({ llm: new FakeLlmClient({ responder: (call) => partyAnswer(call) }), attachments: fakeAttachments() });
    // The owner as the resolver leaves them: a "Me" row, named by their Contacts card identity ("Rowan T." too).
    const me = w.person('Me', null, { kind: 'me', first_name: null, display_name: 'Me' });
    seedIdentity(w.db, me, 'addressbook_id', 'AB-OWNER-1', { display_name: 'Rowan Teller' });
    w.say(TEXT, at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(
      `${BOT_MARKER} ✓ Noted for Rowan Testperson (new, from your screenshot).\nNoted: “great DJ”\nPrioritized for party invites.\n\n(Text "undo" to take that back.)`,
    );
    const titles = w.db.prepare('SELECT title FROM change_batches ORDER BY rowid').pluck().all();
    expect(titles).toEqual(expect.arrayContaining(['Noted about Rowan Testperson (text)', 'Rowan Testperson: prioritized for party invites (text)']));
  });

  it('screenshots off in Settings → nothing is fetched or sent, and the reply says why', async () => {
    const attachments = fakeAttachments();
    const llm = new FakeLlmClient({ responder: (call) => partyAnswer(call) });
    const w = commandsWorld({ llm, attachments });
    setSetting(w.db, 'commands.read_images', false);
    w.say(TEXT, at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });
    expect(attachments.calls).toEqual([]);
    expect(llm.calls[0]!.images).toBe(0);
    expect(w.lastReply()).toBe(`${BOT_MARKER} Reading screenshots is off (Settings → Agent). Tell me who it is by name.`);
    expect(party(w.db)).toEqual([]);
  });

  it('a screenshot the model can read no username or known name off → a hint, nothing written', async () => {
    const llm = new FakeLlmClient({ responder: (call) => partyAnswer(call, null as never, 'Rowan') });
    const w = commandsWorld({ llm, attachments: fakeAttachments() });
    w.say(TEXT, at(0), { attachments: [SCREENSHOT] });
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I couldn't tell who that screenshot shows. Send the profile with the @username visible.`);
    expect(w.db.prepare('SELECT count(*) FROM facts').pluck().get()).toBe(0);
  });
});

describe('resolveScreenshotPerson', () => {
  const ctx = (db: ReturnType<typeof memDb>) => {
    let run: string | null = null;
    return {
      db,
      now: T0,
      source: 'screenshot',
      actor: 'user' as const,
      runId: () => (run ??= (db.prepare(`INSERT INTO runs (id, kind, status, started_at) VALUES ('run-1', 'command', 'running', ?) RETURNING id`).pluck().get(T0) as string)),
    };
  };
  const lite = (id: string, first: string, last: string) => ({ id, first, last, nickname: null, display: `${first} ${last}`, company: null, priority: false, lastAt: null });

  it('matches a handle by identity raw too, brings back a suppressed person, refuses service accounts', () => {
    const db = memDb();
    const p = seedPerson(db, { display_name: 'Rowan Testperson', first_name: 'Rowan', last_name: 'Testperson', status: 'suppressed' });
    db.prepare(
      `INSERT INTO identities (id, person_id, kind, key, raw, source, match_method, confidence, status, created_at, updated_at)
       VALUES ('i1', ?, 'beeper_user', 'opaque-1', '@Yb.Eval.Rowan', 'beeper', 'deterministic', 1, 'active', ?, ?)`,
    ).run(p, T0, T0);
    const r = resolveScreenshotPerson(ctx(db), { handle: 'yb.eval.rowan', name: null }, []);
    expect(r).toEqual({ ok: true, personId: p, created: false });
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(p)).toBe('roster_only');

    const svc = seedPerson(db, { display_name: 'Club Promo', status: 'service', kind: 'business' });
    db.prepare(
      `INSERT INTO identities (id, person_id, kind, key, raw, source, match_method, confidence, status, created_at, updated_at)
       VALUES ('i2', ?, 'instagram_username', 'club.promo.example', '@club.promo.example', 'beeper', 'deterministic', 1, 'service', ?, ?)`,
    ).run(svc, T0, T0);
    expect(resolveScreenshotPerson(ctx(db), { handle: 'club.promo.example', name: null }, [])).toEqual({ ok: false, reason: 'service' });
  });

  it('no username: a unique full-name match only (a first name alone, or two matches, is not enough)', () => {
    const db = memDb();
    const people = [lite('p1', 'Rowan', 'Testperson'), lite('p2', 'Avery', 'Example'), lite('p3', 'Avery', 'Example')];
    expect(resolveScreenshotPerson(ctx(db), { handle: null, name: 'Rowan Testperson 🎧' }, people)).toEqual({ ok: true, personId: 'p1', created: false });
    expect(resolveScreenshotPerson(ctx(db), { handle: null, name: 'Rowan' }, people)).toEqual({ ok: false, reason: 'unreadable' });
    expect(resolveScreenshotPerson(ctx(db), { handle: null, name: 'Avery Example' }, people)).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

describe('Party invites store', () => {
  it('one reserved user circle: created once, revived after a delete, members by canonical id', () => {
    const db = memDb();
    const a = seedPerson(db, { display_name: 'Avery Example' });
    const b = seedPerson(db, { display_name: 'Blake Example' });
    db.prepare(`INSERT INTO runs (id, kind, status, started_at) VALUES ('r', 'command', 'running', ?)`).run(T0);
    const add = (ids: string[]) => withBatch(db, { runId: 'r', kind: 'circle', title: 't', actor: 'user' }, (t) => addToPreference(t, 'party_invites', ids), { now: T0 });
    add([a]);
    add([a, b]);
    expect(db.prepare(`SELECT count(*) FROM circles WHERE signature = 'pref:party_invites'`).pluck().get()).toBe(1);
    expect([...preferredPeople(db, 'party_invites')].sort()).toEqual([a, b].sort());
    db.prepare(`UPDATE circles SET status = 'retracted'`).run();
    expect(preferredPeople(db, 'party_invites').size).toBe(0);
    add([b]);
    expect(db.prepare(`SELECT status FROM circles WHERE signature = 'pref:party_invites'`).pluck().get()).toBe('active');
  });
});
