/**
 * Log acks name people unambiguously: "Sam R." unless that reads as the owner's own short name or as another
 * person's in the same command; then the full last name. Every name here is invented.
 */
import { describe, expect, it } from 'vitest';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { commandLabels, type PersonLite } from '../../src/commands/people';
import type { OwnerName } from '../../src/identity/ownerNames';
import { seedIdentity } from '../helpers';
import { BRIEF_AT, commandsWorld, MIN } from './world';

const at = (mins: number) => BRIEF_AT + mins * MIN;

let seq = 0;
const lite = (first: string | null, last: string | null, display = [first, last].filter(Boolean).join(' ')): PersonLite => ({
  id: `p${++seq}`,
  first,
  last,
  nickname: null,
  display,
  company: null,
  priority: false,
  lastAt: null,
});
const owner = (firstName: string, lastName: string | null): OwnerName => ({ firstName, lastName, displayName: '', nickname: null });

describe('commandLabels', () => {
  it('keeps "First L." when nothing collides', () => {
    const ava = lite('Ava', 'Quillfeather');
    const ben = lite('Ben', 'Ostrander');
    const label = commandLabels([ava, ben], [owner('Rowan', 'Teller')]);
    expect([label(ava), label(ben)]).toEqual(['Ava Q.', 'Ben O.']);
    expect(commandLabels([ava], [])(ava)).toBe('Ava Q.');
  });

  it('a short name that reads as the owner’s own gets the full last name', () => {
    const friend = lite('Rowan', 'Thistlewood');
    const other = lite('Rowan', 'Brightwater');
    const label = commandLabels([friend, other], [owner('Rowan', 'Teller')]);
    expect([label(friend), label(other)]).toEqual(['Rowan Thistlewood', 'Rowan B.']);
    // A display-name-only person collides by their display words and shows the whole display name.
    const shown = lite(null, null, 'Rowan Tamberlane');
    expect(commandLabels([shown], [owner('Rowan', 'Teller')])(shown)).toBe('Rowan Tamberlane');
  });

  it('two people with the same short name in one command both get the full last name', () => {
    const a = lite('Ben', 'Ostrander');
    const b = lite('Ben', 'Osgood');
    const c = lite('Cleo', 'Marsh');
    const label = commandLabels([a, b, c], []);
    expect([label(a), label(b), label(c)]).toEqual(['Ben Ostrander', 'Ben Osgood', 'Cleo M.']);
    // The same person named twice is no collision.
    expect(commandLabels([a, a], [])(a)).toBe('Ben O.');
  });
});

describe('log acks', () => {
  /** The owner as the resolver leaves them: a "Me" row, named by their Contacts card identity. */
  const withOwner = (w: ReturnType<typeof commandsWorld>, name: string) => {
    const me = w.person('Me', null, { kind: 'me', first_name: null, display_name: 'Me' });
    seedIdentity(w.db, me, 'addressbook_id', 'AB-OWNER-1', { display_name: name });
    return me;
  };

  it('a friend whose "First L." is the owner’s own is logged by full name; others keep "First L."', async () => {
    const w = commandsWorld();
    withOwner(w, 'Sam Rowe');
    const sam = w.person('Sam', 'Rivera');
    w.person('Priya', 'Shah');
    w.say('log: coffee with Sam and Priya yesterday', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged coffee with Sam Rivera and Priya S. yesterday.\n\n(Text "undo" to take that back.)`);
    expect(w.db.prepare(`SELECT title FROM change_batches WHERE kind = 'text_log' AND subject_person_id = ?`).pluck().get(sam)).toBe(
      'Logged coffee with Sam Rivera and Priya S. (text)',
    );
    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: log for Sam Rivera and Priya S. (coffee yesterday)`);
  });

  it('two people with the same "First L." in one log are both named in full', async () => {
    const w = commandsWorld();
    withOwner(w, 'Rowan Teller');
    w.person('Sam', 'Rivera');
    w.person('Sam', 'Reyes');
    w.say('log: dinner with Sam Rivera and Sam Reyes', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged a meal with Sam Rivera and Sam Reyes today.\n\n(Text "undo" to take that back.)`);
    // Alone, either is "Sam R." again: the collision is within the command.
    w.say('log: call with Sam Reyes', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged a call with Sam R. today.\n\n(Text "undo" to take that back.)`);
  });
});
