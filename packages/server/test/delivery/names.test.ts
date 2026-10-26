/**
 * Brief names that can't be misread: a friend whose "First L." is also the owner's own short name, or another
 * person's in the same brief, is named with the full last name in the template copy, the LLM copy (de-tokenized
 * locally; last names still never enter the packet), the `more` reply path and the reply acks. Every name here is
 * invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { digestItems } from '../../src/commands/context';
import { composeDigest } from '../../src/delivery/compose';
import { groundingIssues } from '../../src/delivery/grounding';
import { buildPacket } from '../../src/delivery/llmComposer';
import { selectedItemById } from '../../src/delivery/selection';
import { templateCopy } from '../../src/delivery/template';
import { BOT_MARKER } from '../../src/delivery/types';
import { createEgress } from '../../src/llm/egress';
import type { DB } from '../../src/db/connection';
import { seedIdentity, seedPerson } from '../helpers';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { buildWorld, DAY, DAY_DATE, personStats, seedDigest, seedSuggestion, TZ, zoned, type World } from './world';

const NOW = zoned(DAY_DATE, '07:30');
let w: World;

/** The owner as production has it: the "Me" row, named only by its Contacts card identity. */
function seedOwner(db: DB, fullName: string): string {
  const me = seedPerson(db, { display_name: 'Me', first_name: null, last_name: null, kind: 'me', origin: 'system' });
  seedIdentity(db, me, 'addressbook_id', `card-${uuidv7()}`, { display_name: fullName, source: 'addressbook', match_method: 'addressbook' });
  return me;
}

function fact(personId: string, type: string, value: string): void {
  w.db
    .prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0.9, 'confirmed', ?, 'test', ?, ?)`,
    )
    .run(uuidv7(), personId, type, value, value.toLowerCase(), NOW - DAY, NOW - DAY, NOW - DAY);
}

/** Ava Quillfeather (reads as an owner named Ava Quinn), Ben Ostrander and Ben Osgood (both "Ben O."), Cleo Marsh. */
function collidingDay(): { ids: string[]; osgood: string } {
  const T = zoned('2026-01-05', '12:00');
  const osgood = seedPerson(w.db, { display_name: 'Ben Osgood', first_name: 'Ben', last_name: 'Osgood', created_at: T, updated_at: T });
  personStats(w.db, w.ava, { silenceD: 41, expectedGapD: 9 });
  const ids = [
    seedSuggestion(w.db, { kind: 'fading', personId: w.ava, signals: { payload: { silenceD: 41, expectedGapD: 9 } } }),
    seedSuggestion(w.db, { kind: 'reply_debt', personId: w.ben, signals: { ageD: 2 } }),
    seedSuggestion(w.db, { kind: 'reply_debt', personId: osgood, signals: { ageD: 3 } }),
    seedSuggestion(w.db, { kind: 'cooling', personId: w.cleo, signals: {} }),
  ];
  seedDigest(w.db, DAY_DATE, ids);
  return { ids, osgood };
}

const template = async () => (await composeDigest(w.db, { llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() }, { localDate: DAY_DATE, now: NOW }))!;

beforeEach(() => {
  w = buildWorld();
});

describe('brief names', () => {
  it('unchanged default: "First L." when no one shares it with the owner or each other', async () => {
    seedOwner(w.db, 'Rowan Teller');
    personStats(w.db, w.ava, { silenceD: 41, expectedGapD: 9 });
    const ids = [
      seedSuggestion(w.db, { kind: 'fading', personId: w.ava, signals: { payload: { silenceD: 41, expectedGapD: 9 } } }),
      seedSuggestion(w.db, { kind: 'intro', personId: w.cleo, relatedPersonId: w.dora, signals: {} }),
    ];
    seedDigest(w.db, DAY_DATE, ids);
    const c = await template();
    expect(c.items.map((i) => i.headline)).toEqual(['Check in with Ava Q.', 'Introduce Cleo M. and Dora V.?']);
  });

  it('template copy: the owner’s own short name and a shared one in the brief get the full last name', async () => {
    seedOwner(w.db, 'Ava Quinn');
    collidingDay();
    const c = await template();
    expect(c.items.map((i) => i.headline)).toEqual(['Check in with Ava Quillfeather', 'Reply to Ben Ostrander', 'Reply to Ben Osgood', 'Catch up with Cleo M.']);
    expect(c.texts[0]).toContain(
      `${BOT_MARKER} Good morning! 4 things for today.\n\n1. Check in with Ava Quillfeather\nIt's been 6 weeks. You usually talk about once a week.\n\n`,
    );
    // The body keeps the first name: the headline right above it already says who.
    expect(c.texts[0]).toContain(`\n\n2. Reply to Ben Ostrander\nBen has been waiting 2 days for an answer.\n\n`);
    expect(w.db.prepare('SELECT title FROM suggestions WHERE id = ?').pluck().get(c.items[0]!.suggestionId)).toBe('Check in with Ava Quillfeather');
    // The reply acks name the items the same way.
    const digestId = w.db.prepare('SELECT id FROM digests WHERE local_date = ?').pluck().get(DAY_DATE) as string;
    expect(digestItems(w.db, digestId).map((i) => i.personLabel)).toEqual(['Ava Quillfeather', 'Ben Ostrander', 'Ben Osgood', 'Cleo M.']);
  });

  it('one item on its own (the `more` reply) still checks the owner’s name', () => {
    seedOwner(w.db, 'Ava Quinn');
    const id = seedSuggestion(w.db, { kind: 'cooling', personId: w.ava, signals: {} });
    expect(templateCopy(selectedItemById(w.db, id, 5)!, { db: w.db, now: NOW, timeZone: TZ }).headline).toBe('Catch up with Ava Quillfeather');
    const other = seedSuggestion(w.db, { kind: 'cooling', personId: w.ben, signals: {} });
    expect(templateCopy(selectedItemById(w.db, other, 5)!, { db: w.db, now: NOW, timeZone: TZ }).headline).toBe('Catch up with Ben O.');
  });
});

describe('brief names in LLM copy', () => {
  it('ambiguous people go by token only (no first name, no last name in the packet); tokens become the full name', async () => {
    seedOwner(w.db, 'Ava Quinn');
    const { osgood } = collidingDay();
    fact(w.ava, 'location_current', 'Lisbon');
    const egress = new FakeEgress();
    for (const id of [w.ava, w.ben, osgood, w.cleo]) egress.tokenFor(id);
    const llm = new FakeLlmClient().on(`digest:${DAY_DATE}`, {
      json: {
        items: [
          { n: 1, headline: 'Ask P1 how Lisbon is going', body: 'P1 is in Lisbon now.', openers: ['Hey P1! How is Lisbon treating you?'], cites: ['c1'] },
          { n: 2, headline: 'Reply to P2', body: null, openers: [], cites: [] },
          // A bare "Ben" could be either Ben: back to the template.
          { n: 3, headline: 'Reply to Ben', body: null, openers: [], cites: [] },
          { n: 4, headline: 'Catch up with Cleo', body: null, openers: [], cites: [] },
        ],
      },
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    const packet = llm.calls[0]!.userText;
    expect(packet).toContain('person: P1\n');
    expect(packet).toContain('plain version: Check in with P1\n');
    expect(packet).toContain('plain version: Reply to P2\n');
    expect(packet).toContain('person: P4 · first name Cleo');
    expect(packet).not.toMatch(/\bAva\b|\bBen\b|Quillfeather|Ostrander|Osgood|Quinn/);

    expect(c.items.map((i) => i.copy)).toEqual(['llm', 'llm', 'template', 'llm']);
    expect(c.items[0]).toMatchObject({ headline: 'Ask Ava Quillfeather how Lisbon is going', body: 'Ava Quillfeather is in Lisbon now.', openers: ['Hey Ava! How is Lisbon treating you?'] });
    expect(c.items.slice(1).map((i) => i.headline)).toEqual(['Reply to Ben Ostrander', 'Reply to Ben Osgood', 'Catch up with Cleo']);
  });

  it('through the real egress: the long name is applied locally and never sent', async () => {
    seedOwner(w.db, 'Ava Quinn');
    collidingDay();
    const egress = createEgress(w.db);
    const ta = egress.tokenFor(w.ava);
    const llm = new FakeLlmClient().on(`digest:${DAY_DATE}`, { json: { items: [{ n: 1, headline: `Check in with ${ta}`, body: null, openers: [], cites: [] }] } });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(llm.calls[0]!.userText).toContain(`person: ${ta}\n`);
    expect(llm.calls[0]!.userText).not.toMatch(/Quillfeather|Ostrander|Osgood/);
    expect(c.items[0]).toMatchObject({ copy: 'llm', headline: 'Check in with Ava Quillfeather' });
  });

  it('two token-only people in one plain version: the longer name goes first, so no last name is left behind', () => {
    seedOwner(w.db, 'Ben Oakes');
    const solo = seedPerson(w.db, { display_name: 'Ben', first_name: 'Ben', last_name: null });
    const osgood = seedPerson(w.db, { display_name: 'Ben Osgood', first_name: 'Ben', last_name: 'Osgood' });
    const id = seedSuggestion(w.db, { kind: 'intro', personId: solo, relatedPersonId: osgood, signals: {} });
    const item = selectedItemById(w.db, id, 1)!;
    const tpl = templateCopy(item, { db: w.db, now: NOW, timeZone: TZ });
    expect(tpl.headline).toBe('Introduce Ben and Ben Osgood?');
    const egress = new FakeEgress();
    const { sections } = buildPacket(w.db, egress, [item], new Map([[id, tpl]]), { localDate: DAY_DATE, now: NOW, timeZone: TZ, excludedConversationIds: new Set() });
    const text = sections.map((x) => x.text).join('\n');
    expect(text).toContain(`plain version: Introduce ${egress.tokenFor(solo)} and ${egress.tokenFor(osgood)}?`);
    expect(text).not.toMatch(/Osgood|\bBen\b/);
  });

  it('the grounding validator rejects an ambiguous first name in headline or body, never in an opener', () => {
    const packet = { text: 'person: P1\n[c1] fact: Ava sent photos', refIds: new Set(['c1']), ambiguousNames: new Set(['Ava']) };
    const out = (headline: string, body: string | null, openers: string[] = []) => ({ n: 1, headline, body, openers, cites: ['c1'] });
    expect(groundingIssues(out('Check in with Ava', null), packet)).toEqual(['headline: an ambiguous first name']);
    expect(groundingIssues(out('Check in with P1', "Ava's photos came through."), packet)).toEqual(['body: an ambiguous first name']);
    expect(groundingIssues(out('Check in with P1', 'P1 sent photos.', ['Hey Ava! Got the photos.']), packet)).toEqual([]);
    // Without ambiguous names nothing changes.
    expect(groundingIssues(out('Check in with Ava', null), { text: packet.text, refIds: packet.refIds })).toEqual([]);
  });
});
