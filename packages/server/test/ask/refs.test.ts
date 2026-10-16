import { describe, expect, it } from 'vitest';
import { b36, decodeRef, detokenize, eventRef, factRef, messageRef, parseB36, processAnswer, refKind, validateCitations } from '../../src/ask/refs';
import { DeltaFilter } from '../../src/ask/stream';

const names: Record<string, string> = { P1: 'Sam Rivera', P2: 'Jess Kim' };
const personName = (t: string) => names[t] ?? null;
const personFirst = (t: string) => names[t]?.split(' ')[0] ?? null;

describe('citation ids', () => {
  it('encode numbers in base36 so no id is a long digit run', () => {
    expect(messageRef(123456789)).toBe(`m:${(123456789).toString(36)}`);
    expect(messageRef(123456789)).not.toMatch(/\d{6}/);
    expect(factRef(881)).toBe('Foh');
    expect(eventRef(12)).toBe('Ec');
    expect(parseB36(b36(987654))).toBe(987654);
    expect(parseB36('ZZ')).toBeNull();
    expect(decodeRef('m:2n9c')).toEqual({ kind: 'message', n: parseInt('2n9c', 36) });
    expect(decodeRef('P1a')).toEqual({ kind: 'person', token: 'P1a' });
    expect(refKind('X1')).toBeNull();
  });

  it('strips ids no tool returned, keeps valid ones, splits groups, counts violations', () => {
    const citable = new Set(['F1', 'm:2', 'P1']);
    const v = validateCitations('Sam lives in Austin [F1][F9]. They talked [m:2, m:77]. Pizza [Pizza] [E5].', { citable });
    expect(v.text).toBe('Sam lives in Austin [F1]. They talked [m:2]. Pizza [Pizza].');
    expect(v.cited).toEqual(['F1', 'm:2']);
    expect(v.violations).toBe(3);
  });

  it('folds "Name (P1)" and "P1 (Name)" into the token, then de-tokenizes for display', () => {
    const out = processAnswer('Sam R. (P1) and P2 (Jess K.) both live in Austin [F1]; ME too. Ask P1 [P1].', {
      citable: new Set(['F1', 'P1']),
      personName,
      personFirst,
      me: 'you',
    });
    expect(out.text).toBe('Sam Rivera and Jess Kim both live in Austin [F1]; you too. Ask Sam Rivera [P1].');
    expect(out.modelText).toBe('P1 and P2 both live in Austin [F1]; ME too. Ask P1 [P1].');
    expect(out.personTokens).toEqual(['P1', 'P2']);
    expect(out.cited).toEqual(['F1', 'P1']);
  });

  it('unknown tokens and egress placeholders are left readable', () => {
    expect(detokenize('P9 sent <phone:P1> and <email> from <addr>', personName)).toBe('P9 sent a phone number and an email from an address');
  });
});

describe('DeltaFilter', () => {
  it('streams names and valid citations even when deltas split tokens and brackets', () => {
    const out: string[] = [];
    const cites: string[] = [];
    const f = new DeltaFilter({ citable: () => new Set(['F1', 'm:2']), personName, emit: (t) => out.push(t), onCitation: (id) => cites.push(id) });
    for (const d of ['P', '1 lives in Aus', 'tin [F', '1] and P2 said so [m', ':2][m:9]', '. Done']) f.push(d);
    f.end();
    expect(out.join('')).toBe('Sam Rivera lives in Austin [F1] and Jess Kim said so [m:2]. Done');
    expect(cites).toEqual(['F1', 'm:2']);
  });
});
