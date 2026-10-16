import { describe, expect, it } from 'vitest';
import {
  cityFromAddress,
  coreDataMs,
  decodeStringArray,
  foundationLocalDate,
  instagramUsername,
  legacyBirthday,
  linkedinUrl,
  parseCustomFields,
  PlistShapeError,
  TAPBACK_SUMMARY,
  xUsername,
  zidToUuid,
} from '../../src/migration/convert';
import { encodeBplist, keyedDictionary, keyedStringArray, plainStringArray } from './fixture';
import { BIRTHDAY_1990_03_15, SWIFT_NO_YEAR_MAR_15, TZ } from './scenario';
import { UID } from 'bplist-parser';

const shapeError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlistShapeError) return e.reason;
    throw e;
  }
  return null;
};

describe('legacy value conversions', () => {
  it('formats 16-byte ZID blobs as lowercase 8-4-4-4-12 and rejects other sizes', () => {
    const blob = Buffer.from([0xc0, 0xff, 0xee, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 1]);
    expect(zidToUuid(blob)).toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(zidToUuid(Buffer.alloc(15))).toBeNull();
    expect(zidToUuid('C0FFEE00-0000-4000-8000-000000000001')).toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(zidToUuid(null)).toBeNull();
  });

  it('shifts Core Data seconds (INTEGER or REAL) to Unix ms', () => {
    expect(coreDataMs(0)).toBe(978_307_200_000);
    expect(coreDataMs(1.25)).toBe(978_307_201_250);
    expect(coreDataMs(null)).toBeNull();
  });

  it('reads birthdays in local time; year 1 (Foundation, Julian) and 1604 (CNContact) mean "no year"', () => {
    expect(legacyBirthday(BIRTHDAY_1990_03_15, TZ)).toEqual({ value: '1990-03-15', noYear: false });
    // Vectors computed with Swift's Calendar(identifier: .gregorian) in Los Angeles:
    expect(legacyBirthday(SWIFT_NO_YEAR_MAR_15, TZ)).toEqual({ value: '--03-15', noYear: true });
    expect(legacyBirthday(-63114048422, TZ)).toEqual({ value: '--01-01', noYear: true }); // proleptic Gregorian would say Dec 30, 1 BC
    expect(legacyBirthday(-63082598822, TZ)).toEqual({ value: '--12-31', noYear: true });
    expect(legacyBirthday(-12521750822, TZ)).toEqual({ value: '--03-15', noYear: true }); // 1604-03-15
    // The same instant is a different calendar day in another zone: the zone matters.
    expect(legacyBirthday(BIRTHDAY_1990_03_15, 'Asia/Tokyo')?.value).toBe('1990-03-15');
    expect(legacyBirthday(BIRTHDAY_1990_03_15 - 3600, 'UTC')?.value).toBe('1990-03-15');
    expect(legacyBirthday(null, TZ)).toBeNull();
  });

  it('switches to the Julian calendar before 1582-10-15, like Foundation', () => {
    const ms = (s: number) => (s + 978_307_200) * 1000;
    expect(foundationLocalDate(ms(-63107741222), TZ)).toEqual({ y: 1, m: 3, d: 15 });
    expect(foundationLocalDate(Date.UTC(1582, 9, 15), 'UTC')).toEqual({ y: 1582, m: 10, d: 15 });
    expect(foundationLocalDate(Date.UTC(1582, 9, 14), 'UTC')).toEqual({ y: 1582, m: 10, d: 4 });
  });

  it('decodes plain bplist string arrays and NSKeyedArchiver NSArray-of-string archives', () => {
    expect(decodeStringArray(plainStringArray(['a', 'b']))).toEqual({ values: ['a', 'b'], encoding: 'plain' });
    expect(decodeStringArray(keyedStringArray(['(212) 555-0101', 'Café']))).toEqual({ values: ['(212) 555-0101', 'Café'], encoding: 'keyed_archive' });
    expect(decodeStringArray(keyedStringArray([]))).toEqual({ values: [], encoding: 'keyed_archive' });
    expect(decodeStringArray(null)).toEqual({ values: [], encoding: 'empty' });
    // NSString members stored as objects
    const nsString = encodeBplist({
      $version: 100000,
      $archiver: 'NSKeyedArchiver',
      $top: { root: new UID(1) },
      $objects: [
        '$null',
        { 'NS.objects': [new UID(2)], $class: new UID(4) },
        { 'NS.string': 'x', $class: new UID(3) },
        { $classname: 'NSMutableString', $classes: ['NSMutableString', 'NSString', 'NSObject'] },
        { $classname: 'NSMutableArray', $classes: ['NSMutableArray', 'NSArray', 'NSObject'] },
      ],
    });
    expect(decodeStringArray(nsString).values).toEqual(['x']);
  });

  it('refuses every other plist shape with a reason', () => {
    expect(shapeError(() => decodeStringArray(keyedDictionary()))).toMatch(/root class NSDictionary/);
    expect(shapeError(() => decodeStringArray(encodeBplist([1, 'a'])))).toMatch(/not a string/);
    expect(shapeError(() => decodeStringArray(encodeBplist({ a: 'b' })))).toMatch(/not an array/);
    expect(shapeError(() => decodeStringArray(Buffer.from('["json"]')))).toMatch(/not a bplist00/);
    expect(shapeError(() => decodeStringArray(Buffer.from('bplist00garbage')))).toMatch(/unparseable/);
  });

  it('parses custom fields JSON and drops internal keys', () => {
    expect(parseCustomFields(Buffer.from('{"nickname":"Al","lastEnriched":"x"}'))).toEqual({ nickname: 'Al' });
    expect(parseCustomFields(Buffer.from('{}'))).toBeNull();
    expect(parseCustomFields(null)).toBeNull();
    expect(shapeError(() => parseCustomFields('[1]'))).toMatch(/not a JSON object/);
  });

  it('normalizes social handles', () => {
    expect(instagramUsername('@Robin.Park')).toBe('robin.park');
    expect(instagramUsername('https://www.instagram.com/robin.park/?hl=en')).toBe('robin.park');
    expect(instagramUsername('not a handle!')).toBeNull();
    expect(xUsername('https://x.com/RobinP')).toBe('robinp');
    expect(xUsername('@robin_p')).toBe('robin_p');
    expect(linkedinUrl('linkedin.com/in/Robin-Park-0101/')).toBe('https://www.linkedin.com/in/robin-park-0101');
    expect(linkedinUrl('https://example.com/profile?x=1')).toBe('https://example.com/profile');
  });

  it('finds "City, ST" in US-style addresses only', () => {
    expect(cityFromAddress('12 Example St, Springfield, IL 62701')).toBe('Springfield, IL');
    expect(cityFromAddress('12 Example St\nSpringfield IL 62701')).toBe('Springfield, IL');
    expect(cityFromAddress('Apt 4, 99 Sample Rd, Portland, or')).toBe('Portland, OR');
    expect(cityFromAddress('somewhere nice')).toBeNull();
  });

  it('recognizes tapback summaries', () => {
    for (const s of ['Loved “see you”', 'Laughed at "ok"', 'Emphasized “x”', 'Reacted 🎉 to “x”', 'Removed a heart from “x”']) {
      expect(TAPBACK_SUMMARY.test(s)).toBe(true);
    }
    expect(TAPBACK_SUMMARY.test('Loved the show last night')).toBe(false);
  });
});
