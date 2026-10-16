/** Lowercased, NFKC-normalized, trimmed email; null if it isn't shaped like one. */
export function normalizeEmail(raw: string): string | null {
  const s = raw.normalize('NFKC').trim().toLowerCase().replace(/^mailto:/, '');
  const at = s.lastIndexOf('@');
  if (at <= 0 || at !== s.indexOf('@')) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!local || /\s/.test(s) || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return null;
  return s;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical form used for MATCHING only (never stored as the identity key): Gmail ignores dots and
 * "+tags" in the local part, and googlemail.com is the same mailbox as gmail.com.
 */
export function emailMatchKey(raw: string): string | null {
  const e = normalizeEmail(raw);
  if (!e) return null;
  const [local, domain] = e.split('@') as [string, string];
  if (!GMAIL_DOMAINS.has(domain)) return e;
  return `${local.split('+')[0]!.replace(/\./g, '')}@gmail.com`;
}
