import { describe, expect, it } from 'vitest';
import { peopleLinesOf } from '../../src/ask/people-list';
import type { PersonRow } from '../../src/ask/retrieval';

const person = (id: string, first: string, last: string): PersonRow => ({
  id,
  display_name: `${first} ${last}`,
  first_name: first,
  last_name: last,
  nickname: null,
  company: null,
  job_title: null,
  status: 'active',
});
const PEOPLE: Record<string, PersonRow> = { P1a: person('p-1', 'Sam', 'Rivera'), P2b: person('p-2', 'Jess', 'Kim') };
const opts = (peopleQuestion = true) => ({
  person: (t: string) => PEOPLE[t] ?? null,
  display: (s: string) => s.replace(/\bP1a\b/g, 'Sam Rivera').replace(/\bP2b\b/g, 'Jess Kim'),
  peopleQuestion,
});
const shape = (text: string, peopleQuestion = true) => {
  const r = peopleLinesOf(text, opts(peopleQuestion));
  return r && { intro: r.intro, people: r.people.map((p) => [p.person.id, p.detail]), note: r.note };
};

describe('peopleLinesOf', () => {
  it('reads one line per person in the shapes the model writes', () => {
    expect(shape('2 people in Austin:\n- P1a — lives in Austin [F2c]\n• P2b – East Austin [F3]; works at Acme [F4]')).toEqual({
      intro: '2 people in Austin:',
      people: [
        ['p-1', 'lives in Austin [F2c]'],
        ['p-2', 'East Austin [F3]; works at Acme [F4]'],
      ],
      note: '',
    });
    expect(shape('1. **P1a**: climbs [F7]\n2. P2b - knows P1a [m:3k]')?.people).toEqual([
      ['p-1', 'climbs [F7]'],
      ['p-2', 'knows Sam Rivera [m:3k]'],
    ]);
    // A citation between the token and the dash moves to the end; the person's own [P1a] goes.
    expect(shape('- P1a [P1a] [F2c] — lives in Austin')?.people).toEqual([['p-1', 'lives in Austin [F2c]']]);
    // Without a bullet, a token and a dash still make a person line.
    expect(shape('P1a — lives in Austin [F2c]')?.people).toEqual([['p-1', 'lives in Austin [F2c]']]);
  });

  it('merges a person listed twice and keeps text after the list as the note', () => {
    expect(shape('- P1a — climbs [F7]\n- P2b — climbs too\n- P1a — lives in Austin [F2c]\nThat’s everyone.')).toEqual({
      intro: '',
      people: [
        ['p-1', 'climbs [F7] · lives in Austin [F2c]'],
        ['p-2', 'climbs too'],
      ],
      note: 'That’s everyone.',
    });
  });

  it('is not a list: prose, a bullet that isn’t a person line, unknown tokens, a lone line off a "who" question', () => {
    expect(shape('P1a lives in Austin [F2c] and so does P2b.')).toBeNull();
    expect(shape('- P1a — lives in Austin\n- the potluck [E4]')).toBeNull();
    expect(shape('- P1a and P2b went together [E4]')).toBeNull();
    expect(shape('- P9z — someone unknown')).toBeNull();
    expect(shape('- P1a — into bouldering [F7]', false)).toBeNull();
    expect(shape('- P1a — into bouldering [F7]\n- P2b — into pottery', false)?.people).toHaveLength(2);
    expect(shape('Nobody in Lisbon turned up.')).toBeNull();
  });
});
