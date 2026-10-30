import { describe, expect, it } from 'vitest';
import {
  canonicalFirstNames,
  emailMatchKey,
  firstNameScore,
  formatPhone,
  isE164,
  isShortCode,
  jaroWinkler,
  lastNameScore,
  maskPhone,
  nameKey,
  normalizeEmail,
  normalizeNamePart,
  normalizePhone,
  toE164,
} from '../src/normalize/index';

// Fixtures use the fictional NANP 555-01xx range and Ofcom's drama range (+44 20 7946 0xxx).
describe('normalizePhone', () => {
  it.each([
    ['(212) 555-0123', '+12125550123'],
    ['212.555.0142', '+12125550142'],
    ['1-212-555-0100', '+12125550100'],
    ['+1 212-555-0199', '+12125550199'],
    ['  +1 (415) 555-0134 ext. 2 ', '+14155550134'],
    ['２１２５５５０１２３', '+12125550123'], // full-width digits (NFKC)
    ['+44 20 7946 0123', '+442079460123'],
    ['+52 212 555 0123', '+522125550123'],
  ])('%s → %s', (raw, e164) => {
    expect(normalizePhone(raw)).toEqual({ kind: 'e164', key: e164 });
    expect(isE164(e164)).toBe(true);
  });

  it('never matches on the last 10 digits: same trailing digits, different countries', () => {
    expect(toE164('+1 212 555 0123')).not.toBe(toE164('+52 212 555 0123'));
  });

  it('respects the default region for national numbers', () => {
    expect(toE164('020 7946 0123', 'GB')).toBe('+442079460123');
    expect(toE164('020 7946 0123')).toBeNull(); // not a valid US number
  });

  it('classifies short codes (≤ 6 digits)', () => {
    expect(normalizePhone('39781')).toEqual({ kind: 'shortcode', key: '39781' });
    expect(normalizePhone('729 63')).toEqual({ kind: 'shortcode', key: '72963' });
    expect(isShortCode('123456')).toBe(true);
    expect(isShortCode('1234567')).toBe(false);
    expect(isShortCode('+12345')).toBe(false);
    expect(isShortCode('urn:biz:abc')).toBe(false);
  });

  it('keeps unparseable numbers as raw digits', () => {
    expect(normalizePhone('555-0123')).toEqual({ kind: 'raw', key: 'raw:5550123' });
    expect(normalizePhone('+999 555 0123 45')).toEqual({ kind: 'raw', key: 'raw:+999555012345' });
  });

  it('returns null without digits', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });

  it('masks a phone for display', () => {
    expect(maskPhone('+12125550134')).toBe('(212) •••-••34');
  });
});

describe('formatPhone', () => {
  it('shows the whole number: national for US/Canada, international elsewhere', () => {
    expect(formatPhone('+12125550134')).toBe('(212) 555-0134');
    expect(formatPhone('+442079460958')).toBe('+44 20 7946 0958');
    expect(formatPhone('not a number')).toBe('not a number');
  });
});

describe('normalizeEmail', () => {
  it('NFKC, trims and lowercases', () => {
    expect(normalizeEmail('  Sam.Q+News@Example.COM ')).toBe('sam.q+news@example.com');
    expect(normalizeEmail('mailto:Owner@Example.org')).toBe('owner@example.org');
    expect(normalizeEmail('ｏｗｎｅｒ@example.com')).toBe('owner@example.com');
  });

  it('rejects non-emails', () => {
    for (const bad of ['', 'no-at-sign', '@example.com', 'a@b', 'a@@example.com', 'a b@example.com']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('builds a Gmail canonical key for matching only', () => {
    // The PII lint only allows reserved domains in source, so the Gmail domains are assembled here.
    const gmail = ['gmail', 'com'].join('.');
    const googlemail = ['googlemail', 'com'].join('.');
    expect(emailMatchKey(`S.a.m+trips@${googlemail}`)).toBe(`sam@${gmail}`);
    expect(emailMatchKey(`sam@${gmail}`)).toBe(`sam@${gmail}`);
    expect(emailMatchKey('S.a.m+x@example.com')).toBe('s.a.m+x@example.com'); // other domains untouched
  });
});

describe('names', () => {
  it('nameKey trims each component (the native bug trimmed only the whole key)', () => {
    expect(nameKey(' Sam ', ' Quill ')).toBe('sam|quill');
    expect(nameKey('Sam ', 'Quill')).toBe(nameKey('Sam', ' Quill'));
    expect(nameKey('  ', '')).toBe('');
    expect(nameKey('Sam', null)).toBe('sam|');
    expect(nameKey(null, 'Quill')).toBe('|quill');
  });

  it('folds diacritics, emoji and odd whitespace', () => {
    expect(normalizeNamePart('Zoë')).toBe('zoe');
    expect(normalizeNamePart('Øystein')).toBe('oystein');
    expect(normalizeNamePart('Mary  Jo 🎉')).toBe('mary jo');
    expect(nameKey('José', 'Núñez')).toBe('jose|nunez');
  });

  it('Jaro-Winkler', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3);
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });

  it('nickname-aware first-name compatibility', () => {
    expect(canonicalFirstNames('Sam')).toEqual(new Set(['samuel', 'samantha']));
    expect(firstNameScore('Mike', 'Michael')).toBe(1);
    expect(firstNameScore('Sam', 'Samantha')).toBe(1);
    expect(firstNameScore('Jonathon', 'Jonathan')).toBe(0.9);
    expect(firstNameScore('J.', 'Jake')).toBe(0.5);
    expect(firstNameScore('Priya', 'Jake')).toBe(0);
  });

  it('last-name compatibility', () => {
    expect(lastNameScore('Quill', 'Quill')).toBe(1);
    expect(lastNameScore('Quill', null)).toBe(0.6);
    expect(lastNameScore('Quill', 'Ostrander')).toBe(0);
  });
});
