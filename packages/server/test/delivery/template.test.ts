/**
 * Template copy reads like a person texting: a short action, then plain sentences. Edge inputs (titles ending in
 * punctuation, one-letter first names, unknown names, noun-phrase promises, future vs past due dates) never produce
 * broken English.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { selectedItemById } from '../../src/delivery/selection';
import { templateCopy } from '../../src/delivery/template';
import { seedPerson } from '../helpers';
import { buildWorld, DAY, DAY_DATE, seedSuggestion, TZ, zoned, type World } from './world';

const NOW = zoned(DAY_DATE, '07:30'); // a Wednesday
let w: World;

beforeEach(() => {
  w = buildWorld();
});

const copyOf = (id: string) => templateCopy(selectedItemById(w.db, id, 1)!, { db: w.db, now: NOW, timeZone: TZ });

function commitment(personId: string, owner: 'me' | 'them' | 'both', kind: string, what: string, dueAt: number): string {
  const id = uuidv7();
  w.db
    .prepare(
      `INSERT INTO commitments (id, person_id, owner, kind, what, due_end, due_precision, confidence, status, sensitive, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'date', 0.9, 'open', 0, ?, ?)`,
    )
    .run(id, personId, owner, kind, what, dueAt, NOW - DAY, NOW - DAY);
  return seedSuggestion(w.db, { kind: 'commitment_due', personId, commitmentId: id, signals: {} });
}

function occasion(title: string, startsAt: number): string {
  const id = uuidv7();
  w.db.prepare(`INSERT INTO occasions (id, kind, title, starts_at, created_at, updated_at) VALUES (?, 'social', ?, ?, ?, ?)`).run(id, title, startsAt, NOW, NOW);
  return id;
}

const BROKEN = /[.!?…]\.|[!?]\s+is\b|\s\.|^[a-z]/;

describe('template copy', () => {
  it('promises: an action reads "You told … you\'d …", a thing or a shared plan reads "Your plan with …"', () => {
    const later = zoned('2026-10-17', '12:00'); // Sat, ahead
    const before = zoned('2026-10-12', '12:00'); // Mon, past
    expect(copyOf(commitment(w.ava, 'me', 'send', 'send the trail map', later))).toMatchObject({ headline: "You told Ava Q. you'd send the trail map", body: "It's due Sat." });
    expect(copyOf(commitment(w.ava, 'both', 'meet', 'send-off dinner', later))).toMatchObject({ headline: 'Your plan with Ava Q.: send-off dinner', body: "It's planned for Sat." });
    expect(copyOf(commitment(w.ben, 'me', 'other', 'coffee at the usual place', before))).toMatchObject({
      headline: 'Your plan with Ben O.: coffee at the usual place',
      body: 'That was planned for Oct 12. Did it happen?',
    });
    // Someone else's promise that isn't due yet isn't "was due".
    expect(copyOf(commitment(w.cleo, 'them', 'send', 'send the photos', later))).toMatchObject({ headline: "Cleo M. said they'd send the photos", body: "It's due Sat." });
    expect(copyOf(commitment(w.cleo, 'them', 'send', 'send the photos!', before))).toMatchObject({
      headline: "Cleo M. said they'd send the photos",
      body: 'Maybe check in with Cleo. It was due Oct 12.',
    });
  });

  it('a vague promise shows no invented date; one-sided promises keep who owes what', () => {
    const id = uuidv7();
    w.db
      .prepare(
        `INSERT INTO commitments (id, person_id, owner, kind, what, due_precision, confidence, status, sensitive, created_at, updated_at)
         VALUES (?, ?, 'both', 'meet', 'coffee sometime', 'vague', 0.9, 'open', 0, ?, ?)`,
      )
      .run(id, w.ava, NOW - 22 * DAY, NOW - 22 * DAY);
    // The generator's payload carries a made-up due moment for vague promises; it must not show.
    const vague = seedSuggestion(w.db, { kind: 'commitment_due', personId: w.ava, commitmentId: id, signals: { owner: 'both', dueAt: NOW - DAY, precision: 'vague' } });
    expect(copyOf(vague)).toEqual({ headline: 'Your plan with Ava Q.: coffee sometime', body: null, openers: [] });
    const later = zoned('2026-10-17', '12:00');
    expect(copyOf(commitment(w.ben, 'them', 'send', 'forward the lease', later)).headline).toBe('Ben O. owes you: forward the lease');
    expect(copyOf(commitment(w.cleo, 'me', 'send', 'the Denver restaurant list', later)).headline).toBe('Your promise to Cleo M.: the Denver restaurant list');
  });

  it('titles that end in punctuation, one-letter first names and unknown names never break a sentence', () => {
    const jay = seedPerson(w.db, { display_name: 'J. Sato', first_name: 'J.', last_name: 'Sato' });
    const game = occasion('Game night?', zoned(DAY_DATE, '19:00'));
    const party = occasion('Halloween Party!', NOW - 2 * DAY);
    const brief = seedSuggestion(w.db, { kind: 'pre_event_brief', personId: w.ava, occasionId: game, signals: {} });
    const follow = seedSuggestion(w.db, { kind: 'event_followup', personId: w.ava, occasionId: party, signals: {} });
    const owed = seedSuggestion(w.db, { kind: 'commitment_due', personId: jay, signals: { owner: 'them' } });
    expect(copyOf(brief).headline).toBe('Game night is today at 7pm');
    expect(copyOf(follow).body).toBe('You saw Ava at Halloween Party! A quick "great to see you" goes a long way.');
    expect(copyOf(owed).body).toBe('Maybe check in with J.');
    const nameless = seedPerson(w.db, { display_name: '(555) 010-0000', first_name: null, last_name: null });
    const debt = seedSuggestion(w.db, { kind: 'reply_debt', personId: nameless, signals: { ageD: 3 } });
    const c = copyOf(debt);
    expect(c.body).toBe('Someone has been waiting 3 days for an answer.');
    for (const x of [brief, follow, owed, debt].map(copyOf)) {
      expect(x.headline).not.toMatch(BROKEN);
      if (x.body) expect(x.body).not.toMatch(BROKEN);
    }
  });

  it('party invites: whom to invite to the event you host, naming who is on the Party invites list', () => {
    const invite = (people: string[], signals: Record<string, unknown>, occasionId?: string) => {
      const id = seedSuggestion(w.db, { kind: 'party_invite', personId: people[0], occasionId, signals });
      w.db.prepare('UPDATE suggestions SET person_ids = ? WHERE id = ?').run(JSON.stringify(people), id);
      return id;
    };
    const game = occasion('Game night!', zoned('2026-10-17', '19:00')); // Sat
    w.db.prepare(`INSERT INTO circles (id, name, kind, signature, status, created_at, updated_at) VALUES ('pi', 'Party invites', 'user', 'pref:party_invites', 'active', ?, ?)`).run(NOW, NOW);
    w.db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, excluded, created_at, updated_at) VALUES ('pi', ?, 'user', 0, ?, ?)`).run(w.ava, NOW, NOW);
    const three = copyOf(invite([w.ava, w.ben, w.cleo], { daysOut: 3, partyInvites: 1 }, game));
    expect(three).toEqual({
      headline: 'Who to invite to Game night',
      body: "You're hosting on Sat. Ava Q., Ben O. and Cleo M. aren't on the guest list yet. Ava is on your Party invites list.",
      openers: [],
    });
    expect(copyOf(invite([w.ava], { daysOut: 3, partyInvites: 1 }, game)).body).toBe("You're hosting on Sat. Ava Q. isn't on the guest list yet. They're on your Party invites list.");
    expect(copyOf(invite([w.ben, w.cleo], { startsAt: zoned('2026-10-24', '20:00') }))).toMatchObject({
      headline: 'Who to invite on Oct 24',
      body: "You're hosting on Oct 24. Ben O. and Cleo M. aren't on the guest list yet.",
    });
    // Two Avas in one item: the Party invites one is named in full, not as a bare "Ava".
    const ava2 = seedPerson(w.db, { display_name: 'Ava Lindqvist', first_name: 'Ava', last_name: 'Lindqvist' });
    expect(copyOf(invite([w.ava, ava2], { daysOut: 3, partyInvites: 1 }, game)).body).toBe(
      "You're hosting on Sat. Ava Q. and Ava L. aren't on the guest list yet. Ava Q. is on your Party invites list.",
    );
    for (const x of [three]) {
      expect(x.headline).not.toMatch(BROKEN);
      expect(x.body).not.toMatch(BROKEN);
    }
  });
});
