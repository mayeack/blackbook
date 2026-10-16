import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Phone handles are keyed by E.164 (libphonenumber-js, default region US). Never by "last 10 digits":
 * that rule merged unrelated international numbers in the native app.
 */
export type PhoneKey =
  | { kind: 'e164'; key: string }
  /** SMS short codes (≤6 digits): service senders, never people. */
  | { kind: 'shortcode'; key: string }
  /** Unparseable numbers keep their digits so they stay stable keys, at reduced confidence. */
  | { kind: 'raw'; key: string };

export const RAW_PHONE_PREFIX = 'raw:';

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** A digit-only handle of ≤6 digits (spaces/dashes allowed, no leading "+"). */
export function isShortCode(raw: string): boolean {
  const s = raw.trim();
  if (!/^[\d\s().-]+$/.test(s)) return false;
  const d = digitsOf(s);
  return d.length >= 3 && d.length <= 6;
}

/** Looks like a phone number at all (vs an email, a urn:biz id, a chat guid). */
export function looksLikePhone(raw: string): boolean {
  const s = raw.trim();
  return /^\+?[\d\s().\- ]+$/.test(s) && digitsOf(s).length >= 3;
}

/**
 * Normalizes a phone handle: E.164 when libphonenumber considers it valid, a short code for ≤6 digits,
 * otherwise `raw:<digits>`. Returns null for input without digits.
 */
export function normalizePhone(raw: string, region: CountryCode = 'US'): PhoneKey | null {
  const s = raw.normalize('NFKC').trim();
  const d = digitsOf(s);
  if (!d) return null;
  if (isShortCode(s)) return { kind: 'shortcode', key: d };
  const parsed = parsePhoneNumberFromString(s, region);
  if (parsed?.isValid()) return { kind: 'e164', key: parsed.number };
  return { kind: 'raw', key: `${RAW_PHONE_PREFIX}${s.startsWith('+') ? '+' : ''}${d}` };
}

/** E.164 or null (convenience for callers that only accept valid numbers). */
export function toE164(raw: string, region: CountryCode = 'US'): string | null {
  const k = normalizePhone(raw, region);
  return k?.kind === 'e164' ? k.key : null;
}

export const isE164 = (s: string): boolean => /^\+[1-9]\d{6,14}$/.test(s);

/** "(512) •••-••34" style display for a phone with no known name; keeps area code + last two digits. */
export function maskPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  const national = digitsOf(parsed?.nationalNumber ?? e164);
  if (parsed?.countryCallingCode === '1' && national.length === 10) {
    return `(${national.slice(0, 3)}) •••-••${national.slice(8)}`;
  }
  return `+${parsed?.countryCallingCode ?? ''} ••• ${national.slice(-2)}`.trim();
}
