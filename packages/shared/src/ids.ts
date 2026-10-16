// Web Crypto is a global in Node ≥19 and every browser; typed locally so this file needs no DOM/node lib.
type RandomSource = { getRandomValues<T extends Uint8Array>(array: T): T };
const rng = (): RandomSource => (globalThis as unknown as { crypto: RandomSource }).crypto;

let lastMs = -1;
let counter = 0;

/**
 * RFC 9562 UUIDv7: 48-bit Unix ms + 12-bit counter (rand_a) + 62 random bits. Monotonic within this process:
 * ids minted in the same millisecond (or after the clock steps back) still sort in creation order.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  let ms = Math.max(Math.floor(nowMs), lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) {
      ms++;
      counter = 0;
    }
  } else {
    counter = rng().getRandomValues(new Uint8Array(1))[0]! & 0x7f; // random start, room to count up
  }
  lastMs = ms;
  const b = rng().getRandomValues(new Uint8Array(16));
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** Unix ms embedded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable short handle for an id (default 4 Crockford base32 chars = 20 bits), for compact citations and
 * URLs. Deterministic but not unique: callers resolve collisions against their own table.
 */
export function shortId(id: string, length = 4): string {
  if (!Number.isInteger(length) || length < 1 || length > 6) throw new RangeError('shortId length must be 1–6');
  let h = fnv1a32(id.toLowerCase());
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD[h & 31];
    h >>>= 5;
  }
  return out;
}
