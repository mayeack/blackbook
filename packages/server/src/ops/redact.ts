const MAX = 300;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const E164 = /\+\d[\d\s().-]{6,18}\d/g;
const NANP = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g;
const DIGIT_RUN = /\d{7,}/g;

/**
 * Scrubs free text before it can reach a log line or an error response: emails, phone numbers (E.164 and
 * formatted US) and digit runs of 7+ are masked, then the result is truncated to 300 characters.
 */
export function redact(input: unknown, max = MAX): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input);
  s = s.replace(EMAIL, '[email]').replace(E164, '[phone]').replace(NANP, '[phone]').replace(DIGIT_RUN, '[num]');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
