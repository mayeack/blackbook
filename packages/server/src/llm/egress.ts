/**
 * THE egress choke point (PLAN "One egress choke point", intelligence §4.2). Every Claude call goes through it:
 * batch extraction, tie-break, digest composer, Ask tools, intent parser, circle naming, calendar adjudication.
 *
 *   createEgress(db)   the pseudonymizer over the local `pseudonyms` table (never sent) + the fail-closed scanner
 *                      + local de-tokenization. Callers pseudonymize packets; the client scans again.
 *   egressFetch(...)   the ONLY transport the Anthropic SDK is built with (llm/client.ts): every HTTP request is
 *                      checked against an endpoint allowlist and every outgoing user turn is scanned again right
 *                      before it leaves. A miss answers a local 400 (never sent, never retried).
 *
 * Tokens: persons → P<base36> (stable, global; always contain a digit so they never collide with words such as
 * "Pat" or "Pizza"), unresolved handles → H<n>, the owner → ME. In text: phones (libphonenumber
 * findPhoneNumbersInText + the raw-identifier shapes) → <phone:P…|H…> / <phone>, emails → <email>, @handles →
 * <ig:P…> when known else <handle>, URLs → <link:domain>, street addresses → <addr> (the city stays), digit runs
 * ≥6 that aren't refs (m:8812) → <num>, a known person's last name right after their first name → last initial.
 * Kept: first names, cities, companies, chat titles.
 *
 * The scanner FAILS CLOSED: a raw E.164/NANP number, email or @handle anywhere in an outgoing user turn blocks the
 * whole request (EgressBlocked). Images can't be scanned or pseudonymized: an image block leaves only when the
 * client approved its exact bytes (sha256) for this request on a route that allows images (llm/models.ts
 * maxImages: the self-thread intent route); every other image, document or URL/file-sourced block is refused.
 * Logs carry counts only.
 */
import { createHash } from 'node:crypto';
import { findPhoneNumbersInText } from 'libphonenumber-js';
import { maskPhone } from '@yb/shared';
import type { Statement } from 'better-sqlite3';
import type { DB } from '../db/connection';
import {
  EgressBlocked,
  LLM_IMAGE_TYPES,
  type Egress,
  type EgressFindingKind,
  type EgressPacket,
  type PseudonymizedPacket,
  type TokenMap,
  type TokenTarget,
} from './types';

// ---------------------------------------------------------------------------------------------- raw identifiers

/** Raw identifiers that must never leave: E.164 / NANP phone shapes, emails, @handles. */
export const RAW_IDENTIFIER_PATTERNS: Readonly<Record<Exclude<EgressFindingKind, 'not_implemented'>, RegExp>> = {
  phone: /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|\b\d{10,11}\b/g,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Any "@name" not inside an email local part ("ig:@x", "\"@x\"", "thx,@x" all count; emails are replaced first).
  handle: /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{2,30}\b/g,
};

/** Counts raw identifiers in `text` (empty = clean). Regex shapes only (the fake client mirrors this). */
export function findRawIdentifiers(text: string): { kind: EgressFindingKind; count: number }[] {
  const out: { kind: EgressFindingKind; count: number }[] = [];
  for (const [kind, re] of Object.entries(RAW_IDENTIFIER_PATTERNS) as [EgressFindingKind, RegExp][]) {
    const n = text.match(new RegExp(re.source, re.flags))?.length ?? 0;
    if (n) out.push({ kind, count: n });
  }
  return out;
}

const DATE_TIME = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/g;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** ≥7 digits with only phone separators between them. */
const PHONE_CANDIDATE = /\d(?:[\s().\-\u2010-\u2015\u00a0/]*\d){6,}/;

/**
 * Cheap pre-filter for libphonenumber (≈70× slower than the regexes): could `text` hold a phone number at all?
 * Date-times and UUIDs are set aside for the decision only; detection always runs on the full text, in context
 * (libphonenumber reads "2026-10-12 19" alone as a number but not "2026-10-12 19:04").
 */
export function mayHoldPhone(text: string): boolean {
  return PHONE_CANDIDATE.test(text.replace(DATE_TIME, ' ').replace(UUID_SHAPE, ' '));
}

/** Every number libphonenumber can find (other formats, other regions), when the pre-filter says it's worth it. */
export function libPhones(text: string): ReturnType<typeof findPhoneNumbersInText> {
  return mayHoldPhone(text) ? findPhoneNumbersInText(text, 'US') : [];
}

/** The real scanner: the regex shapes plus every number libphonenumber can find (other formats, other regions). */
export function scanFindings(text: string): { kind: EgressFindingKind; count: number }[] {
  const out = findRawIdentifiers(text);
  const lib = libPhones(text).length;
  if (lib) {
    const phone = out.find((f) => f.kind === 'phone');
    if (phone) phone.count = Math.max(phone.count, lib);
    else out.push({ kind: 'phone', count: lib });
  }
  return out;
}

/** Throws EgressBlocked when `text` holds a raw identifier. */
export function scanText(text: string): void {
  const f = scanFindings(text);
  if (f.length) throw new EgressBlocked(f);
}

/** A refusal that isn't an identifier finding (bad endpoint, empty packet, unreadable body). */
export class EgressRefused extends EgressBlocked {
  constructor(readonly why: 'empty_packet' | 'endpoint' | 'body' | 'no_database' | 'media') {
    // 'not_implemented' is the contract's catch-all kind for "this can't go out".
    super([{ kind: 'not_implemented', count: 1 }]);
    this.message = `egress blocked: ${why}`;
  }
}

// ---------------------------------------------------------------------------------------------- outgoing requests

type Json = unknown;

/** The user-side text of one Messages request body (system prompt, tools and echoed assistant turns are code/model output). */
export function userTextOfParams(params: Json): string {
  const out: string[] = [];
  const messages = (params as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return '';
  for (const m of messages as { role?: unknown; content?: unknown }[]) {
    if (m?.role === 'assistant') continue;
    collectText(m?.content, out);
  }
  return out.join('\n');
}

function collectText(content: unknown, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content as { type?: unknown; text?: unknown; content?: unknown }[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'tool_result') collectText(b.content, out);
    // Media blocks are checked by checkMedia (approved bytes only), never read as text.
    else if (MEDIA_BLOCKS.has(b.type as string)) continue;
    // Anything else in a user turn is serialized and scanned as-is.
    else out.push(JSON.stringify(b));
  }
}

const MEDIA_BLOCKS = new Set(['image', 'document']);

/** sha256 (hex) of an image's base64 payload: what the client approves and the fetch checks. */
export const imageHash = (base64: string): string => createHash('sha256').update(base64, 'utf8').digest('hex');

/** Approves an image block's bytes for the request being sent (llm/client.ts holds the set). */
export type MediaApproval = (hash: string) => boolean;

/** Every media block in the user turns (tool results included). */
function mediaBlocks(content: unknown, out: Record<string, unknown>[]): void {
  if (!Array.isArray(content)) return;
  for (const b of content as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') mediaBlocks(b.content, out);
    else if (MEDIA_BLOCKS.has(b.type as string)) out.push(b);
  }
}

/**
 * Throws EgressRefused('media') unless every media block is a base64 image of an accepted type whose bytes `approve`
 * says the client approved. No approver (batches, any caller but the client's own parse) = no media at all.
 */
export function checkMedia(params: Json, approve?: MediaApproval): void {
  const messages = (params as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return;
  const found: Record<string, unknown>[] = [];
  for (const m of messages as { role?: unknown; content?: unknown }[]) if (m?.role !== 'assistant') mediaBlocks(m?.content, found);
  for (const b of found) {
    const src = b.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    const ok =
      b.type === 'image' &&
      src?.type === 'base64' &&
      (LLM_IMAGE_TYPES as readonly unknown[]).includes(src.media_type) &&
      typeof src.data === 'string' &&
      !!approve?.(imageHash(src.data));
    if (!ok) throw new EgressRefused('media');
  }
}

/** Scans every user turn of a Messages body or a Message Batches create body. Throws EgressBlocked. */
export function scanRequestBody(body: Json, approve?: MediaApproval): void {
  const requests = (body as { requests?: unknown })?.requests;
  if (Array.isArray(requests)) {
    for (const r of requests as { params?: unknown }[]) {
      scanText(userTextOfParams(r?.params));
      checkMedia(r?.params); // batches never carry images
    }
    return;
  }
  scanText(userTextOfParams(body));
  checkMedia(body, approve);
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** scanRequestBody for big batch bodies: yields the event loop every 50 requests (the iMessage tail keeps running). */
export async function scanRequestBodyAsync(body: Json, approve?: MediaApproval): Promise<void> {
  const requests = (body as { requests?: unknown })?.requests;
  if (!Array.isArray(requests)) return scanRequestBody(body, approve);
  for (const [i, r] of (requests as { params?: unknown }[]).entries()) {
    scanText(userTextOfParams(r?.params));
    checkMedia(r?.params);
    if (i % 50 === 49) await yieldLoop();
  }
}

const ALLOWED: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/messages$/ },
  { method: 'POST', path: /^\/v1\/messages\/batches$/ },
  { method: 'GET', path: /^\/v1\/messages\/batches\/[A-Za-z0-9_-]{1,128}$/ },
  { method: 'GET', path: /^\/v1\/messages\/batches\/[A-Za-z0-9_-]{1,128}\/results$/ },
];

/** Header on the local 400 that a blocked request answers (the client maps it to 'egress_blocked'). */
export const EGRESS_BLOCKED_HEADER = 'x-yb-egress';

export interface EgressFetchOptions {
  /** The real transport (global fetch in production; a fake in tests). */
  fetch: typeof fetch;
  /** Only this origin is reachable (default https://api.anthropic.com). */
  origin?: string;
  onBlocked?: (e: EgressBlocked) => void;
  /** Image bytes the client approved for the request in flight (absent = every image is refused). */
  approveMedia?: MediaApproval;
}

/**
 * THE single way out to Anthropic. llm/client.ts builds the SDK with this fetch and nothing else may reach the API
 * (test/llm/entryPoint.test.ts enforces it). Allowlisted endpoints only; JSON bodies only; user turns scanned.
 */
export function egressFetch(o: EgressFetchOptions): typeof fetch {
  const origin = o.origin ?? 'https://api.anthropic.com';
  const blocked = (e: EgressBlocked): Response => {
    o.onBlocked?.(e);
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Blocked by the local egress guard.' } }), {
      status: 400,
      headers: { 'content-type': 'application/json', [EGRESS_BLOCKED_HEADER]: 'blocked' },
    });
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return blocked(new EgressRefused('endpoint'));
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== origin || !ALLOWED.some((a) => a.method === method && a.path.test(url.pathname))) return blocked(new EgressRefused('endpoint'));
    if (method === 'POST') {
      const raw = init?.body;
      if (typeof raw !== 'string') return blocked(new EgressRefused('body'));
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return blocked(new EgressRefused('body'));
      }
      try {
        await scanRequestBodyAsync(body, o.approveMedia);
      } catch (e) {
        if (e instanceof EgressBlocked) return blocked(e);
        throw e;
      }
    } else if (init?.body != null) {
      return blocked(new EgressRefused('body'));
    }
    return o.fetch(input, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------- tokens

/** Person tokens always contain a digit (P1, P10, P1a, …): base36 values made only of letters are skipped. */
const PERSON_TOKEN = /^P[0-9a-z]*[0-9][0-9a-z]*$/;
const IDENTITY_TOKEN = /^H[0-9]+$/;
/** Tokens in free text: P… (with a digit), H<n>, ME. */
export const TOKEN_IN_TEXT = /(?<![\p{L}\p{N}_])(P[0-9a-z]*[0-9][0-9a-z]*|H[0-9]+|ME)(?![\p{L}\p{N}_])/gu;

export const isPersonToken = (t: string): boolean => PERSON_TOKEN.test(t);

/** n → base36 with at least one digit (skips values whose base36 is letters only). */
export function nextPersonOrdinal(n: number): number {
  let k = n;
  while (!/[0-9]/.test(k.toString(36))) k++;
  return k;
}

/** Every token in `text` (deduplicated, in order of appearance). */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_IN_TEXT)].map((m) => m[1]!))];
}

// ---------------------------------------------------------------------------------------------- text scrubbing

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const BARE_URL_RE = /\b(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|me|co|us|ly|gg|tv)\/[^\s<>"'`)\]]*/gi;
const STREET =
  /\b\d{1,6}\s+[A-Z][\w.]*(?:\s[A-Z][\w.]*)*\s(?:St|Ave|Rd|Blvd|Dr|Ln|Way|Ct|Pl|Pkwy|Hwy|Street|Avenue|Road|Boulevard|Drive|Lane|Court|Place|Parkway|Highway)\b\.?/g;
/** Digit runs ≥6 that aren't part of a word or a ref like m:8812 / ↩m:8801 or a decimal. */
const DIGIT_RUN = /(?<![\w.]|[A-Za-z]:)\d{6,}(?!\w)/g;
const HANDLE = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._]{2,30})\b/g;

function domainOf(raw: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '').toLowerCase().slice(0, 60);
  } catch {
    return 'url';
  }
}

/** "@Handle" → "handle" when it fits Instagram's username rules. */
function igKey(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------- the egress

interface PersonRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  kind: string;
  merged_into_id: string | null;
}

class SqliteEgress implements Egress {
  private personOrdinal: number | null = null;
  private identityOrdinal: number | null = null;
  private readonly byToken = new Map<string, TokenTarget>();
  private readonly byPerson = new Map<string, string>();
  private readonly byIdentity = new Map<string, string>();

  private readonly q: {
    person: Statement;
    mergedInto: Statement;
  };

  constructor(private readonly db: DB) {
    this.q = {
      person: db.prepare('SELECT id, first_name, last_name, display_name, kind, merged_into_id FROM people WHERE id = ?'),
      mergedInto: db.prepare('SELECT merged_into_id FROM people WHERE id = ?'),
    };
  }

  // ---- tokens

  private person(id: string): PersonRow | undefined {
    return this.q.person.get(id) as PersonRow | undefined;
  }

  /** Follows merge pointers; unknown ids stay as they are. */
  private canonical(id: string): string {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      const row = this.q.mergedInto.get(cur) as { merged_into_id: string | null } | undefined;
      if (!row?.merged_into_id) return cur;
      cur = row.merged_into_id;
    }
    return cur;
  }

  private meId(): string | null {
    return (
      (this.db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined) ??
      null
    );
  }

  tokenFor(personId: string): string {
    const id = this.canonical(personId);
    if (this.person(id)?.kind === 'me') return 'ME';
    const cached = this.byPerson.get(id);
    if (cached) return cached;
    const existing = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'person' AND ref_id = ?`).pluck().get(id) as string | undefined;
    if (existing) {
      this.byPerson.set(id, existing);
      return existing;
    }
    if (this.personOrdinal === null) {
      const all = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'person'`).pluck().all() as string[];
      this.personOrdinal = all.reduce((max, t) => Math.max(max, PERSON_TOKEN.test(t) ? parseInt(t.slice(1), 36) : 0), 0);
    }
    const insert = this.db.prepare(`INSERT INTO pseudonyms (token, kind, ref_id, created_at) VALUES (?, 'person', ?, ?) ON CONFLICT DO NOTHING`);
    for (;;) {
      this.personOrdinal = nextPersonOrdinal(this.personOrdinal + 1);
      const token = `P${this.personOrdinal.toString(36)}`;
      if (insert.run(token, id, Date.now()).changes) {
        this.byPerson.set(id, token);
        return token;
      }
      const raced = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'person' AND ref_id = ?`).pluck().get(id) as string | undefined;
      if (raced) return raced;
    }
  }

  /** The stable H<n> token for an unresolved identity (created on first use). */
  identityToken(identityId: string): string {
    const cached = this.byIdentity.get(identityId);
    if (cached) return cached;
    const existing = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'identity' AND ref_id = ?`).pluck().get(identityId) as string | undefined;
    if (existing) {
      this.byIdentity.set(identityId, existing);
      return existing;
    }
    if (this.identityOrdinal === null) {
      const all = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'identity'`).pluck().all() as string[];
      this.identityOrdinal = all.reduce((max, t) => Math.max(max, IDENTITY_TOKEN.test(t) ? Number(t.slice(1)) : 0), 0);
    }
    const insert = this.db.prepare(`INSERT INTO pseudonyms (token, kind, ref_id, created_at) VALUES (?, 'identity', ?, ?) ON CONFLICT DO NOTHING`);
    for (;;) {
      this.identityOrdinal += 1;
      const token = `H${this.identityOrdinal}`;
      if (insert.run(token, identityId, Date.now()).changes) {
        this.byIdentity.set(identityId, token);
        return token;
      }
      const raced = this.db.prepare(`SELECT token FROM pseudonyms WHERE kind = 'identity' AND ref_id = ?`).pluck().get(identityId) as string | undefined;
      if (raced) return raced;
    }
  }

  resolveToken(token: string): TokenTarget | null {
    if (token === 'ME') {
      const me = this.meId();
      return me ? { kind: 'me', id: me } : null;
    }
    const cached = this.byToken.get(token);
    if (cached) return cached.kind === 'person' ? { kind: 'person', id: this.canonical(cached.id) } : cached;
    if (!PERSON_TOKEN.test(token) && !IDENTITY_TOKEN.test(token)) return null;
    const row = this.db.prepare('SELECT kind, ref_id FROM pseudonyms WHERE token = ?').get(token) as { kind: string; ref_id: string } | undefined;
    if (!row) return null;
    const target: TokenTarget = row.kind === 'identity' ? { kind: 'identity', id: row.ref_id } : { kind: 'person', id: row.ref_id };
    this.byToken.set(token, target);
    return target.kind === 'person' ? { kind: 'person', id: this.canonical(target.id) } : target;
  }

  // ---- identities seen in text

  private identityByKey(kind: string, key: string): { id: string; person_id: string } | undefined {
    return this.db.prepare(`SELECT id, person_id FROM identities WHERE kind = ? AND key = ? AND status = 'active'`).get(kind, key) as
      | { id: string; person_id: string }
      | undefined;
  }

  /** P…/H…/ME for an identity found in text, or null (unknown). */
  private tokenForIdentity(ident: { id: string; person_id: string } | undefined, unresolved: Set<string>, map: TokenMap): string | null {
    if (!ident) return null;
    if (unresolved.has(ident.id)) {
      const t = this.identityToken(ident.id);
      map[t] = { kind: 'identity', id: ident.id };
      return t;
    }
    const t = this.tokenFor(ident.person_id);
    map[t] = t === 'ME' ? { kind: 'me', id: this.canonical(ident.person_id) } : { kind: 'person', id: this.canonical(ident.person_id) };
    return t;
  }

  // ---- packets

  pseudonymize(packet: EgressPacket): PseudonymizedPacket {
    if (!packet.sections.length) throw new EgressRefused('empty_packet');
    const tokenMap: TokenMap = {};
    const replaced: Record<string, number> = {};
    const bump = (k: string, n = 1) => (replaced[k] = (replaced[k] ?? 0) + n);

    for (const p of packet.people ?? []) {
      const t = p.isMe ? 'ME' : this.tokenFor(p.personId);
      tokenMap[t] = t === 'ME' ? { kind: 'me', id: p.personId } : { kind: 'person', id: this.canonical(p.personId) };
    }
    const unresolved = new Set(packet.identityIds ?? []);
    for (const id of unresolved) tokenMap[this.identityToken(id)] = { kind: 'identity', id };

    const fullNames = (packet.people ?? [])
      .filter((p) => p.firstName?.trim() && p.lastName?.trim())
      .map((p) => ({
        re: new RegExp(`(?<![\\p{L}\\p{N}])(${escapeRe(p.firstName!.trim())})\\s+${escapeRe(p.lastName!.trim())}(?![\\p{L}\\p{N}])`, 'giu'),
        initial: `${[...p.lastName!.trim()][0]!.toUpperCase()}.`,
      }));

    const sections = packet.sections.map((s) => ({ name: s.name, text: this.scrub(s.text, unresolved, tokenMap, fullNames, bump) }));
    const text = sections.map((s) => `### ${s.name}\n${s.text}`).join('\n\n');
    // Belt and braces: the output must pass the scanner it will meet again in the client.
    scanText(text);
    return { sections, text, tokenMap, replaced };
  }

  private scrub(
    input: string,
    unresolved: Set<string>,
    map: TokenMap,
    fullNames: { re: RegExp; initial: string }[],
    bump: (k: string, n?: number) => void,
  ): string {
    // Opaque ids pass through untouched (their digit runs aren't numbers).
    const kept: string[] = [];
    let text = input.normalize('NFC').replace(UUID, (m) => `\u0000${kept.push(m) - 1}\u0000`);

    text = text.replace(URL_RE, (m) => (bump('link'), `<link:${domainOf(m)}>`));
    text = text.replace(BARE_URL_RE, (m) => (bump('link'), `<link:${domainOf(m)}>`));
    text = text.replace(new RegExp(RAW_IDENTIFIER_PATTERNS.email.source, 'g'), () => (bump('email'), '<email>'));

    // Phones: libphonenumber first (every format and region it knows), then the raw shapes it rejects.
    const found = libPhones(text);
    if (found.length) {
      let out = '';
      let at = 0;
      for (const f of found) {
        out += text.slice(at, f.startsAt);
        const token = this.tokenForIdentity(this.identityByKey('phone', f.number.number), unresolved, map);
        out += token ? `<phone:${token}>` : '<phone>';
        at = f.endsAt;
        bump('phone');
      }
      text = out + text.slice(at);
    }
    text = text.replace(new RegExp(RAW_IDENTIFIER_PATTERNS.phone.source, 'g'), () => (bump('phone'), '<phone>'));

    text = this.replaceHandles(text, unresolved, map, bump);
    text = text.replace(STREET, () => (bump('addr'), '<addr>'));
    text = text.replace(DIGIT_RUN, () => (bump('num'), '<num>'));
    for (const n of fullNames) text = text.replace(n.re, (_m, first: string) => (bump('last_name'), `${first} ${n.initial}`));

    text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
    // Once more at the end: a later step can expose a handle the scanner would block ("1234567@x" → "<num>@x",
    // an "@" right before a kept UUID).
    return this.replaceHandles(text, unresolved, map, bump);
  }

  /**
   * @handles → <ig:P…|H…|ME> when known, else <handle>, repeated until none is left: in "@a@b" the lookbehind sees
   * the letter before "@b", so it only becomes a match once "@a" is replaced. Every pass that changes the text
   * removes an "@" (the replacements contain none), so the loop ends.
   */
  private replaceHandles(text: string, unresolved: Set<string>, map: TokenMap, bump: (k: string, n?: number) => void): string {
    for (let prev = ''; prev !== text; ) {
      prev = text;
      text = text.replace(HANDLE, (_m, handle: string) => {
        bump('handle');
        const key = igKey(handle);
        const token = key ? this.tokenForIdentity(this.identityByKey('instagram_username', key), unresolved, map) : null;
        return token ? `<ig:${token}>` : '<handle>';
      });
    }
    return text;
  }

  scan(text: string): void {
    scanText(text);
  }

  // ---- local display

  private displayOf(target: TokenTarget, token: string, cache: Map<string, string>): string {
    const key = `${target.kind}:${target.id}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let out = token;
    if (target.kind === 'me') out = 'you';
    else if (target.kind === 'person') {
      const p = this.person(this.canonical(target.id));
      if (p?.kind === 'me') out = 'you';
      else if (p) {
        const first = p.first_name?.trim();
        const last = p.last_name?.trim();
        const name = first ? (last ? `${first} ${[...last][0]!.toUpperCase()}.` : first) : p.display_name;
        out = scanFindings(name).length ? 'a contact' : name;
      }
    } else if (target.kind === 'identity') {
      const i = this.db.prepare('SELECT kind, key, display_name FROM identities WHERE id = ?').get(target.id) as
        | { kind: string; key: string; display_name: string | null }
        | undefined;
      if (i?.display_name && !scanFindings(i.display_name).length) out = i.display_name;
      else if (i?.kind === 'phone' && i.key.startsWith('+')) out = maskPhone(i.key);
      else if (i) out = 'an unknown contact';
    }
    cache.set(key, out);
    return out;
  }

  detokenize(text: string, map: TokenMap): string {
    const cache = new Map<string, string>();
    return text.replace(TOKEN_IN_TEXT, (m: string, token: string) => {
      const target = map[token] ?? this.resolveToken(token);
      return !target || target.kind === 'mention' ? m : this.displayOf(target, token, cache);
    });
  }
}

/** Without a database nothing can be pseudonymized: pseudonymize/tokenFor fail closed; scan still works. */
class ClosedEgress implements Egress {
  pseudonymize(): PseudonymizedPacket {
    throw new EgressRefused('no_database');
  }
  scan(text: string): void {
    scanText(text);
  }
  detokenize(text: string): string {
    return text;
  }
  tokenFor(): string {
    throw new EgressRefused('no_database');
  }
  resolveToken(): TokenTarget | null {
    return null;
  }
}

export type SqlEgress = Egress & { identityToken(identityId: string): string };

export function createEgress(db: DB): SqlEgress;
export function createEgress(db: DB | null): Egress;
export function createEgress(db: DB | null): Egress {
  return db ? new SqliteEgress(db) : new ClosedEgress();
}

// ---------------------------------------------------------------------------------------------- display helpers

/**
 * De-tokenizes for display but leaves citation ids in brackets ([P17], [m:8812]) for the caller to resolve
 * (Ask streams answer text whose citations are resolved by `citation` events).
 */
export function detokenizeKeepingCitations(egress: Egress, text: string, map: TokenMap = {}): string {
  return text
    .split(/(\[[^\]\s]{1,40}\])/)
    .map((part, i) => (i % 2 === 1 ? part : egress.detokenize(part, map)))
    .join('');
}

/**
 * Stream-safe de-tokenizer for text deltas: holds back a trailing partial word (a token may be split across
 * deltas) and an unclosed citation bracket, so every emitted piece is final.
 */
export class DeltaDetokenizer {
  private pending = '';
  constructor(
    private readonly egress: Egress,
    private readonly map: TokenMap = {},
  ) {}

  push(delta: string): string {
    this.pending += delta;
    let cut = this.pending.length;
    const tail = /[\p{L}\p{N}_]+$/u.exec(this.pending);
    if (tail) cut = tail.index;
    const open = this.pending.lastIndexOf('[');
    if (open >= 0 && this.pending.indexOf(']', open) < 0 && this.pending.length - open <= 40) cut = Math.min(cut, open);
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return ready ? detokenizeKeepingCitations(this.egress, ready, this.map) : '';
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest ? detokenizeKeepingCitations(this.egress, rest, this.map) : '';
  }
}

/** Person ids behind the person tokens in `text` (for the exclusion check at the choke point). */
export function personIdsIn(egress: Egress, text: string): string[] {
  const out = new Set<string>();
  for (const t of tokensIn(text)) {
    if (!isPersonToken(t)) continue;
    const target = egress.resolveToken(t);
    if (target?.kind === 'person') out.add(target.id);
  }
  return [...out];
}
