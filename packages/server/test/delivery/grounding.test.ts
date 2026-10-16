import { describe, expect, it } from 'vitest';
import { groundingIssues, packetVocabulary, ungroundedTokens, type ComposerItemOut } from '../../src/delivery/grounding';

const PACKET = [
  '### brief',
  'date: Wed Oct 14',
  '### item 1',
  'kind: fading (they have gone quiet compared with their usual rhythm)',
  'person: P1 · first name Ava',
  'signals: quiet 41 days · usually every 9 days',
  '[c1] fact (location current): Lisbon',
  '[c2] message Oct 3, from them: started pottery classes',
].join('\n');

const item = (o: Partial<ComposerItemOut> = {}): ComposerItemOut => ({
  n: 1,
  headline: 'Check in with P1 — quiet 41 days, usually every 9',
  body: 'P1 moved to Lisbon and started pottery.',
  openers: ['Hey Ava! How is Lisbon treating you?'],
  cites: ['c1', 'c2'],
  ...o,
});

const packet = { text: PACKET, refIds: new Set(['c1', 'c2']) };

describe('digest grounding validator', () => {
  it('accepts copy whose names, places and numbers all come from the packet', () => {
    expect(groundingIssues(item(), packet)).toEqual([]);
  });

  it('rejects invented names, places and numbers', () => {
    expect(groundingIssues(item({ headline: 'Check in with Marcus about Denver' }), packet).join(' ')).toMatch(/ungrounded/);
    expect(groundingIssues(item({ body: 'It has been 52 days.' }), packet).join(' ')).toMatch(/ungrounded/);
    expect(groundingIssues(item({ openers: ['Hey Ava, how was Tokyo?'] }), packet).join(' ')).toMatch(/opener 1: ungrounded/);
    // weekday / month names and sentence words are whitelisted; numbers still must be in the packet
    expect(groundingIssues(item({ headline: 'Say hi to P1 on Friday' }), packet)).toEqual([]);
    expect(groundingIssues(item({ headline: 'Say hi to P1 before Oct 14' }), packet)).toEqual([]);
    expect(groundingIssues(item({ headline: 'Say hi to P1 before Oct 15' }), packet).join(' ')).toMatch(/ungrounded/);
  });

  it('checks citations, bounds and identifiers', () => {
    expect(groundingIssues(item({ cites: ['c9'] }), packet).join(' ')).toMatch(/not in the packet/);
    expect(groundingIssues(item({ cites: [] }), packet)).toContain('openers without a citation');
    expect(groundingIssues(item({ cites: [], openers: [] }), packet)).toEqual([]);
    expect(groundingIssues(item({ headline: 'x'.repeat(91) }), packet).join(' ')).toMatch(/headline: longer than 90/);
    expect(groundingIssues(item({ body: 'a '.repeat(130) }), packet).join(' ')).toMatch(/body: longer than 240/);
    expect(groundingIssues(item({ openers: ['a', 'b', 'c'] }), packet).join(' ')).toMatch(/more than 2 openers/);
    expect(groundingIssues(item({ openers: ['y'.repeat(161)] }), packet).join(' ')).toMatch(/opener 1: longer than 160/);
    expect(groundingIssues(item({ body: 'Call P1 at 202-555-0123' }), packet).join(' ')).toMatch(/phone/);
    expect(groundingIssues(item({ body: 'Mail P1 at ava@example.com' }), packet).join(' ')).toMatch(/email/);
    expect(groundingIssues(item({ body: 'See yeackbot.com/p/1' }), packet).join(' ')).toMatch(/link/);
    expect(groundingIssues(item({ body: 'P1 owes you $40' }), packet).join(' ')).toMatch(/amount/);
    expect(groundingIssues(item({ body: 'P1 said "started pottery classes and it is going really well"' }), packet).join(' ')).toMatch(/quote longer/);
    expect(groundingIssues(item({ headline: '   ' }), packet)).toContain('headline: empty');
    expect(groundingIssues(item({ body: 'Ask P1 how the surgery went' }), packet).join(' ')).toMatch(/sensitive topic/);
  });

  it('never echoes the offending tokens in its issues (they may be names)', () => {
    const issues = groundingIssues(item({ headline: 'Ping Marcus Hollowell' }), packet);
    expect(issues.join(' ')).not.toMatch(/Marcus|Hollowell/);
  });

  it('vocabulary handles possessives, tokens and numbers', () => {
    const v = packetVocabulary(PACKET);
    expect(ungroundedTokens("Ava's pottery in Lisbon, 41 days", v)).toEqual([]);
    expect(ungroundedTokens('P1 and P7', v)).toEqual(['P7']);
    expect(ungroundedTokens("I'm glad you're back", v)).toEqual([]);
  });
});
