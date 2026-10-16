/**
 * A Contacts card (collector ContactCard) → what yeackbot uses from it: display fields, a comparable name, and
 * its identity keys (E.164 phones, emails, Instagram usernames from social profiles by `service` — not by label,
 * the old ContactSyncService bug — and from instagram.com URLs). The content hash covers only those, so edits to
 * fields yeackbot ignores (postal addresses, notes) don't re-apply a card.
 */
import crypto from 'node:crypto';
import type { ContactCard } from '@yb/shared/collector/v1';
import { normalizeExternalKey, type ExternalKey } from '../../identity/external';
import { fieldsName, parseName, type PersonName } from '../../identity/matcherNames';

export type CardKeyKind = 'phone' | 'email' | 'instagram_username';

export interface CardKey {
  kind: CardKeyKind;
  raw: string;
  norm: ExternalKey;
}

/** Display fields applied to the card's person (null = the card doesn't say). */
export interface CardFields {
  displayName: string | null;
  given: string | null;
  family: string | null;
  nickname: string | null;
  org: string | null;
  job: string | null;
  /** 'YYYY-MM-DD' or '--MM-DD' (display only: no birthday features). */
  birthday: string | null;
}

export interface ParsedCard {
  id: string;
  fields: CardFields;
  name: PersonName | null;
  keys: CardKey[];
  modifiedAt: number | null;
  hash: string;
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : null;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** {y?, m, d} → people.birthday format; a missing or sentinel year (CNContact uses 1604) becomes '--MM-DD'. */
export function cardBirthday(b: ContactCard['birthday']): string | null {
  if (!b) return null;
  const year = b.y && b.y >= 1800 && b.y <= 2200 ? b.y : null;
  const probe = new Date(Date.UTC(year ?? 2000, b.m - 1, b.d));
  if (probe.getUTCMonth() !== b.m - 1 || probe.getUTCDate() !== b.d) return null;
  return year ? `${year}-${pad(b.m)}-${pad(b.d)}` : `--${pad(b.m)}-${pad(b.d)}`;
}

/** The card's display name: "Given Family", else nickname, else organization; null for an empty card. */
export function cardDisplayName(f: Pick<CardFields, 'given' | 'family' | 'nickname' | 'org'>): string | null {
  return clean([f.given, f.family].filter(Boolean).join(' ')) ?? f.nickname ?? f.org;
}

const INSTAGRAM_URL = /(^|\/\/|\.)instagram\.com\//i;

export function parseCard(c: ContactCard): ParsedCard {
  const given = clean(c.given);
  const family = clean(c.family);
  const nickname = clean(c.nickname);
  const org = clean(c.org);
  const fields: CardFields = {
    displayName: cardDisplayName({ given, family, nickname, org }),
    given,
    family,
    nickname,
    org,
    job: clean(c.job),
    birthday: cardBirthday(c.birthday),
  };
  const keys: CardKey[] = [];
  const seen = new Set<string>();
  const add = (kind: CardKeyKind, raw: string | null | undefined) => {
    if (!raw?.trim()) return;
    const norm = normalizeExternalKey(kind, raw);
    // A short code on a card (a bank's alert number) is a service sender, never a person's key.
    if (!norm || norm.kind === 'shortcode') return;
    const sig = `${norm.kind}\u0000${norm.key}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    keys.push({ kind, raw: raw.trim(), norm });
  };
  for (const p of c.phones) add('phone', p.value);
  for (const e of c.emails) add('email', e.value);
  for (const s of c.social) {
    const service = s.service?.toLowerCase() ?? '';
    if (service.includes('instagram')) add('instagram_username', s.username ?? s.url);
    else if (!service && s.url && INSTAGRAM_URL.test(s.url)) add('instagram_username', s.url);
  }
  for (const u of c.urls) if (INSTAGRAM_URL.test(u.value)) add('instagram_username', u.value);

  const name = fieldsName(given, family) ?? (nickname ? parseName(nickname) : null);
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ fields, keys: keys.map((k) => `${k.norm.kind}:${k.norm.key}`).sort() }))
    .digest('hex');
  return { id: c.id, fields, name, keys, modifiedAt: c.modified_at, hash };
}

export const keySig = (k: { kind: string; key: string }): string => `${k.kind}\u0000${k.key}`;
