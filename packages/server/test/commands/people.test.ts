import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { IMAGE_REF, imageHandle, validateIntent, type IntentOutput } from '../../src/commands/intent';
import { deterministicKind } from '../../src/commands/log';
import { distinctLabels, findMentions, intentCandidates, resolveSurface, type PersonLite } from '../../src/commands/people';
import { finalizeReply, scrub, shortName, stableRef } from '../../src/commands/text';

let seq = 0;
const p = (first: string | null, last: string | null, extra: Partial<PersonLite> = {}): PersonLite => ({
  id: `p${++seq}`,
  first,
  last,
  nickname: null,
  display: [first, last].filter(Boolean).join(' ') || 'Someone',
  company: null,
  priority: false,
  lastAt: null,
  ...extra,
});

const samR = p('Sam', 'Rivera', { lastAt: 200 });
const samK = p('Samuel', 'Kowalski', { lastAt: 100 });
const priya = p('Priya', 'Shah');
const will = p('William', 'Ortega', { nickname: 'Will' });
const people = [samR, samK, priya, will];

describe('name resolution for log:', () => {
  it('exact first names beat nickname families; a last initial or last name narrows', () => {
    expect(findMentions('coffee with Sam', people).map((m) => m.candidates.map((c) => c.id))).toEqual([[samR.id]]);
    expect(findMentions('coffee with Samuel', people)[0]!.candidates.map((c) => c.id)).toEqual([samK.id]);
    expect(findMentions('dinner with sam k', [p('Sam', 'Rivera'), p('Sam', 'Kowalski')])[0]!.candidates.map((c) => c.last)).toEqual(['Kowalski']);
    expect(findMentions('drinks with Sam Kowalski', [samR, p('Sam', 'Kowalski')])[0]!.candidates.map((c) => c.last)).toEqual(['Kowalski']);
  });

  it('two people of the same first name are ambiguous, ranked by recent contact', () => {
    const a = p('Sam', 'Rivera', { lastAt: 1 });
    const b = p('Sam', 'Kowalski', { lastAt: 9 });
    const m = findMentions('lunch with Sam', [a, b]);
    expect(m).toHaveLength(1);
    expect(m[0]!.candidates.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(distinctLabels(m[0]!.candidates)).toEqual(['Sam K.', 'Sam R.']);
    expect(distinctLabels([p('Sam', 'Rivera'), p('Sam', 'Rhodes')])).toEqual(['Sam Rivera', 'Sam Rhodes']);
  });

  it('several people; lowercase names need a connector; common words are not names', () => {
    expect(findMentions('Coffee with Sam and priya', people).map((m) => m.candidates[0]!.id)).toEqual([samR.id, priya.id]);
    expect(findMentions('Will call the plumber', people)).toEqual([]);
    expect(findMentions('met will at the gym', people).map((m) => m.candidates[0]!.id)).toEqual([will.id]);
    expect(findMentions('priya was there', people)).toEqual([]);
    expect(findMentions('brunch on Sunday', people)).toEqual([]);
  });

  it('surfaces from the intent parser and candidate lists', () => {
    expect(resolveSurface('Sam R.', [p('Sam', 'Rivera'), p('Sam', 'Kowalski')]).map((c) => c.last)).toEqual(['Rivera']);
    expect(intentCandidates('dinner w/ Sam and Priya', people).map((c) => c.id).sort()).toEqual([samR.id, priya.id].sort());
  });

  it('log kinds from keywords', () => {
    expect(deterministicKind('coffee with Sam')).toBe('coffee');
    expect(deterministicKind('called Priya')).toBe('call');
    expect(deterministicKind('dinner at the new place')).toBe('meal');
    expect(deterministicKind('beers with Will')).toBe('drinks');
    expect(deterministicKind('ran into Sam')).toBe('met');
    expect(deterministicKind('Sam is moving')).toBe('other');
  });
});

describe('reply text', () => {
  it('short names, scrubbing, marker, collector-valid client refs', () => {
    expect(shortName({ first_name: 'Sam', last_name: 'rivera', display_name: 'x' })).toBe('Sam R.');
    expect(shortName({ first_name: null, last_name: null, display_name: 'Priya Shah' })).toBe('Priya S.');
    expect(scrub('mail sam@example.com or call (512) 555-0101, see https://example.com/a and yeackbot.com/p/x')).toBe(
      'mail … or call …, see and yeackbot.com/p/x',
    );
    expect(finalizeReply('hello')).toBe(`${BOT_MARKER} hello`);
    expect(finalizeReply(`${BOT_MARKER} hi`)).toBe(`${BOT_MARKER} hi`);
    const ref = stableRef('a', 'b');
    expect(z.uuid().safeParse(ref).success).toBe(true);
    expect(stableRef('a', 'b')).toBe(ref);
    expect(stableRef('a', 'c')).not.toBe(ref);
  });
});

describe('intent output bounds (the API enforces none)', () => {
  const ok: IntentOutput = {
    gist: 'g',
    sure: true,
    intent: 'log_interaction',
    image: null,
    command: null,
    reminder: null,
    question: null,
    log: { people: [{ surface: 'Sam', ref: 'P1' }], kind: 'coffee', date: '2026-10-14', facts: [{ ref: 'P1', cat: 'interest', value: 'bouldering' }], note: null },
    preferences: [],
  };
  it('accepts a well-formed answer and rejects unknown tokens, stray fact refs and bad dates', () => {
    const tokens = new Set(['P1']);
    expect(validateIntent(ok, tokens)).toEqual([]);
    expect(validateIntent({ ...ok, log: { ...ok.log!, people: [{ surface: 'Sam', ref: 'P9' }] } }, tokens)).toContain('unknown ref');
    expect(validateIntent({ ...ok, log: { ...ok.log!, facts: [{ ref: 'P2', cat: 'interest', value: 'x' }] } }, tokens)).toContain('fact ref not among people');
    expect(validateIntent({ ...ok, log: { ...ok.log!, date: 'tomorrow' } }, tokens)).toContain('bad date');
    expect(validateIntent({ ...ok, intent: 'command', log: null }, tokens)).toContain('command missing');
    expect(validateIntent({ ...ok, intent: 'command', command: { verb: 'done', nums: [99], dur: null }, log: null }, tokens)).toContain(
      'command.nums out of range',
    );
  });

  it('screenshots: IMG is a ref only with an image that shows a username or name; set_preference needs preferences', () => {
    const tokens = new Set(['P1']);
    const pref: IntentOutput = {
      ...ok,
      intent: 'set_preference',
      image: { handle: 'yb.eval.rowan', name: 'Rowan Testperson' },
      log: { people: [{ surface: 'this person', ref: IMAGE_REF }], kind: 'other', date: null, facts: [{ ref: IMAGE_REF, cat: 'activity_pref', value: 'great DJ' }], note: null },
      preferences: [{ surface: 'this person', ref: IMAGE_REF, action: 'invite_first' }],
    };
    expect(validateIntent(pref, tokens, true)).toEqual([]);
    expect(validateIntent(pref, tokens, false)).toEqual(expect.arrayContaining(['image without an attachment', 'unknown ref', 'unknown preference ref']));
    expect(validateIntent({ ...pref, image: { handle: null, name: null } }, tokens, true)).toContain('unknown ref');
    expect(validateIntent({ ...pref, image: { handle: 'not a handle!', name: null } }, tokens, true)).toContain('bad image handle');
    expect(validateIntent({ ...pref, preferences: [] }, tokens, true)).toContain('preferences missing');
    expect(validateIntent({ ...pref, preferences: [{ surface: 'Sam', ref: 'P9', action: 'invite_first' }] }, tokens, true)).toContain('unknown preference ref');
    expect(imageHandle('@Yb.Eval.Rowan')).toBe('yb.eval.rowan');
    expect(imageHandle('instagram.com/someone')).toBeNull();
    expect(imageHandle(null)).toBeNull();
  });
});
