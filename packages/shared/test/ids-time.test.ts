import { describe, expect, it, vi } from 'vitest';
import { isUuid, shortId, uuidv7, uuidv7Time } from '../src/ids';
import { addDays, APPLE_EPOCH_OFFSET_S, chatDbDateToMs, coreDataSecondsToMs, localParts, msToChatDbNanos } from '../src/time';

describe('uuidv7', () => {
  it('has the v7 layout and embeds the time', async () => {
    // uuidv7 clamps to the latest time it has minted, so use a fresh module: this must not depend on test order.
    vi.resetModules();
    const fresh = await import('../src/ids');
    const t = Date.UTC(2026, 9, 14, 12, 0, 0);
    const id = fresh.uuidv7(t);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(uuidv7Time(id)).toBe(t);
  });

  it('is monotonic within one millisecond and when the clock steps back', () => {
    const t = Date.UTC(2030, 0, 1);
    const ids = Array.from({ length: 5000 }, () => uuidv7(t));
    ids.push(uuidv7(t - 10_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('shortId', () => {
  it('is stable, 4 Crockford base32 chars by default', () => {
    const id = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    expect(shortId(id)).toBe(shortId(id));
    expect(shortId(id)).toMatch(/^[0-9a-hjkmnp-tv-z]{4}$/);
    expect(shortId(id.toUpperCase())).toBe(shortId(id));
    expect(shortId(id, 6)).toHaveLength(6);
    expect(() => shortId(id, 9)).toThrow();
  });

  it('spreads ids', () => {
    const set = new Set(Array.from({ length: 1000 }, () => shortId(uuidv7())));
    expect(set.size).toBeGreaterThan(990);
  });
});

describe('Core Data / chat.db time', () => {
  it('coreDataSecondsToMs', () => {
    expect(coreDataSecondsToMs(0)).toBe(978_307_200_000);
    expect(coreDataSecondsToMs(1.5)).toBe(978_307_201_500);
    expect(coreDataSecondsToMs(813_000_000.1234)).toBe(Math.round((813_000_000.1234 + APPLE_EPOCH_OFFSET_S) * 1000));
  });

  it('chatDbDateToMs handles nanoseconds, seconds, bigint and empty', () => {
    const ms = Date.UTC(2026, 9, 13, 19, 4, 5, 123);
    const ns = msToChatDbNanos(ms);
    expect(chatDbDateToMs(ns)).toBe(ms);
    expect(chatDbDateToMs(Number(ns))).toBe(ms);
    expect(chatDbDateToMs(500_000_000)).toBe(coreDataSecondsToMs(500_000_000)); // pre-10.13 seconds
    expect(chatDbDateToMs(0)).toBeNull();
    expect(chatDbDateToMs(null)).toBeNull();
  });

  it('localParts in a given zone', () => {
    const t = Date.UTC(2026, 9, 14, 7, 30); // 02:30 in Chicago (CDT)
    expect(localParts(t, 'America/Chicago')).toEqual({ date: '2026-10-14', hhmm: '02:30', dow: 3 });
    expect(localParts(Date.UTC(2026, 9, 14, 4, 0), 'America/Chicago').date).toBe('2026-10-13');
    expect(localParts(Date.UTC(2026, 9, 14, 0, 5), 'UTC').hhmm).toBe('00:05');
  });

  it('addDays', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
