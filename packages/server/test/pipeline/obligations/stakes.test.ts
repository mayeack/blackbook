import { describe, expect, it } from 'vitest';
import { guessStakes, higherStakes, stakesOf } from '../../../src/pipeline/obligations/stakes';

describe('stakes', () => {
  it('guesses money, housing and bookings high and small logistics low; everything else is normal', () => {
    const cases: [string, Parameters<typeof guessStakes>[1], string][] = [
      ['bring tomatoes', 'other', 'low'],
      ['get a broom for Ava', 'other', 'low'],
      ['wear a costume to the party', 'plan', 'low'],
      ['arrive at the show around 11', 'plan', 'low'],
      ['order food, two of whatever Sam gets', 'other', 'low'],
      ['save the empty jars for the party', 'other', 'low'],
      ['pay $200 for the cabin', 'other', 'high'],
      ['pay the housing share by Monday', 'other', 'high'],
      ['be reference for next landlord', 'other', 'high'],
      ['give notice before moving out', 'other', 'high'],
      ['book the hotel for the work trip', 'plan', 'high'],
      // A money word wins over a small-task verb.
      ['bring the deposit check', 'other', 'high'],
      // A meet-up or a call is never a small task, whatever its verb.
      ['get a drink after work', 'meet', 'normal'],
      ['send the trail map', 'send', 'normal'],
      ['dinner at the new noodle place', 'meet', 'normal'],
      ['link Sam with the neighbor', 'intro', 'normal'],
    ];
    expect(cases.map(([what, kind]) => [what, guessStakes(what, kind)])).toEqual(cases.map(([what, , want]) => [what, want]));
  });

  it("a row's label wins over the guess; a repeat keeps the higher of two labels", () => {
    expect(stakesOf({ stakes: 'high', what: 'bring tomatoes', kind: 'other' })).toBe('high');
    expect(stakesOf({ stakes: null, what: 'bring tomatoes', kind: 'other' })).toBe('low');
    expect(stakesOf({ stakes: 'bogus', what: 'pay rent', kind: 'other' })).toBe('high');
    expect([higherStakes('low', 'high'), higherStakes('high', 'low'), higherStakes('normal', 'low'), higherStakes('low', 'low')]).toEqual(['high', 'high', 'normal', 'low']);
  });
});
