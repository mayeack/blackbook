/**
 * GET /sources: one card per source from source_health + source_cursors, with counts from the episode, identity,
 * event, calendar, ticket and screenshot tables, and the one fix the owner can act on. The core sources (iMessage,
 * WhatsApp, Instagram via Beeper, the Instagram export, Partiful, Google Calendar, Contacts, Gmail, Google Photos)
 * always get a card, so a source that has never reported still shows how to set it up. Adapters that report under an
 * alias (e.g. 'calendar' for 'gcal', 'screenshot' identities for 'gphotos') fold into their card. Gmail and Google
 * Photos read their connection straight from the secrets table (each is its own Google grant); without SECRETS_KEY
 * their fix is the set-the-key guidance, since /google/connect refuses to start (the web remaps the Calendar card the
 * same way from /google/status).
 *
 * Error text, cursor scopes and detail strings pass through redact(): a per-chat scope can embed a phone. Counts
 * only: no names, handles or titles leave this module.
 */
import os from 'node:os';
import { Router } from 'express';
import { isConnected, type GoogleProduct } from '../adapters/calendar/google';
import type { DB } from '../db/connection';
import { redact } from '../ops/redact';
import type { RouteDeps } from './index';

export type SourceStatus = 'ok' | 'stale' | 'error' | 'auth_required' | 'contract_broken' | 'disabled' | 'unknown';

export interface SourceCursorView {
  scope: string;
  cursor: string;
  highWaterAt: number | null;
  updatedAt: number;
}

export interface SourceMessageCounts {
  total: number;
  last24h: number;
  last7d: number;
  oldestAt: number | null;
  newestAt: number | null;
}

/** Card counts; a key is present only when it applies to the source. */
export interface SourceCounts {
  conversations?: number;
  /** Visible people with at least one identity from this source. */
  people?: number;
  identities?: number;
  /** Partiful events. */
  events?: number;
  upcomingEvents?: number;
  /** Partiful guest-list rows. */
  guests?: number;
  calendars?: number;
  calendarEvents?: number;
  occasions?: number;
  contactCards?: number;
  /** Gmail: messages the ticket source looked at, those that were ticket mail, and the ticketed events. */
  emailsScanned?: number;
  ticketEmails?: number;
  tickets?: number;
  /** Google Photos: contact screenshots read, and how many linked to a person. */
  screenshots?: number;
  screenshotsLinked?: number;
  /** Calls in the Mac's call log. */
  calls?: number;
}

/** What the owner can do about a source; the web app words it and adds the button. */
export type SourceFixKind =
  | 'connect_google'
  | 'google_not_configured'
  /** Gmail / Google Photos: an OAuth client but no SECRETS_KEY, so a connect would be refused. */
  | 'google_secrets_missing'
  | 'sign_in_partiful'
  | 'link_whatsapp'
  | 'beeper_disconnected'
  | 'beeper_setup'
  | 'drop_instagram_export'
  | 'allow_contacts'
  | 'collector_setup'
  | 'contract_broken'
  | 'connect_gmail'
  | 'connect_gphotos';

export interface SourceFix {
  kind: SourceFixKind;
  /** drop_instagram_export: the watched folder, home shortened to "~". */
  folder?: string;
}

export interface SourceView {
  source: string;
  status: SourceStatus;
  lastOkAt: number | null;
  newestDataAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  details: unknown;
  /** Newest first, at most CURSOR_CAP; cursorCount has the full number. */
  cursors: SourceCursorView[];
  cursorCount: number;
  messages: SourceMessageCounts | null;
  counts: SourceCounts;
  /** false: this server lacks the configuration the source needs (e.g. no Google OAuth client). */
  configured: boolean;
  fix: SourceFix | null;
}

export interface SourcesView {
  sources: SourceView[];
  generatedAt: number;
}

/** What the server knows about its own source configuration (RouteDeps.config). */
export interface SourcesOptions {
  googleConfigured?: boolean;
  /** SECRETS_KEY is set, so a Google connect can store its token. */
  secretsAvailable?: boolean;
  beeperConfigured?: boolean;
  importsDir?: string;
}

interface CardDef {
  source: string;
  /** Other source names that report into this card. */
  aliases: readonly string[];
  /** Always shown, even before the source has ever reported. */
  core: boolean;
}

/** Card order on the screen. */
const CARDS: readonly CardDef[] = [
  { source: 'collector', aliases: [], core: false },
  { source: 'imessage', aliases: [], core: true },
  { source: 'whatsapp', aliases: [], core: true },
  { source: 'beeper', aliases: ['instagram'], core: true },
  { source: 'instagram_dyi', aliases: ['ig_dyi', 'instagram_export'], core: true },
  { source: 'partiful', aliases: [], core: true },
  { source: 'gcal', aliases: ['calendar', 'google_calendar'], core: true },
  { source: 'addressbook', aliases: ['contacts'], core: true },
  { source: 'gmail', aliases: [], core: true },
  { source: 'gphotos', aliases: ['screenshot', 'google_photos'], core: true },
  { source: 'calls', aliases: [], core: true },
];

/** The Google product behind a card whose connection is its own grant (the secrets table knows). */
const PRODUCT_CARDS: Readonly<Record<string, GoogleProduct>> = { gmail: 'gmail', gphotos: 'photos' };

/** The card a source name reports into (itself when it isn't a known alias). */
/** source_health rows that belong to an outbound channel, not an ingest source. */
const NOT_SOURCES: ReadonlySet<string> = new Set(['gmail_send']);

export function cardFor(source: string): string {
  return CARDS.find((c) => c.source === source || c.aliases.includes(source))?.source ?? source;
}

const rank = (s: string) => {
  const i = CARDS.findIndex((c) => c.source === s);
  return i === -1 ? CARDS.length : i;
};

/** Worst first: a card folded from several health rows shows the most urgent one. */
const SEVERITY: readonly SourceStatus[] = ['auth_required', 'contract_broken', 'error', 'stale', 'ok', 'disabled', 'unknown'];

const CURSOR_CAP = 20;
const DAY = 86_400_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Redacts every string inside parsed JSON (keys kept). */
function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redact(v);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
}

function parseDetails(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return redactDeep(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** "~/Yeackbot Imports" rather than the absolute path. */
export function displayFolder(dir: string | undefined, home = os.homedir()): string {
  if (!dir) return '~/Yeackbot Imports';
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

interface HealthRow {
  source: string;
  status: SourceStatus;
  last_ok_at: number | null;
  newest_data_at: number | null;
  last_error: string | null;
  details: string | null;
  checked_at: number;
}

const maxOf = (xs: (number | null | undefined)[]) => xs.reduce<number | null>((m, x) => (x == null ? m : m == null ? x : Math.max(m, x)), null);
const minOf = (xs: (number | null | undefined)[]) => xs.reduce<number | null>((m, x) => (x == null ? m : m == null ? x : Math.min(m, x)), null);

/** The reason words adapters put in last_error / details, for picking the fix. Never shown as-is. */
function reasonText(h: HealthRow | undefined, details: unknown): string {
  const d = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
  const words = [h?.last_error, d.reason, d.code, d.state, d.account, d.accountStatus].filter((x): x is string => typeof x === 'string');
  return words.join(' ').toLowerCase();
}

/** details.connected as the Google route records it (true after the OAuth callback, false after Disconnect). */
function connectedFlag(details: unknown): boolean | null {
  const v = details && typeof details === 'object' ? (details as Record<string, unknown>).connected : undefined;
  return typeof v === 'boolean' ? v : null;
}

function fixFor(
  source: string,
  status: SourceStatus,
  hasData: boolean,
  reason: string,
  details: unknown,
  o: Required<SourcesOptions>,
  connected: ReadonlySet<GoogleProduct>,
): SourceFix | null {
  const needsYou = status === 'auth_required';
  const neverRan = status === 'unknown' && !hasData;
  switch (source) {
    case 'gmail':
    case 'gphotos': {
      if (!o.googleConfigured) return { kind: 'google_not_configured' };
      if (needsYou || !connected.has(PRODUCT_CARDS[source]!) || /revoked|invalid_grant|reconnect|insufficient/.test(reason)) {
        if (!o.secretsAvailable) return { kind: 'google_secrets_missing' };
        return { kind: source === 'gmail' ? 'connect_gmail' : 'connect_gphotos' };
      }
      break;
    }
    case 'gcal': {
      if (!o.googleConfigured) return { kind: 'google_not_configured' };
      const connected = connectedFlag(details);
      if (needsYou || connected === false || (connected === null && (neverRan || status === 'disabled')) || /revoked|invalid_grant|reconnect/.test(reason))
        return { kind: 'connect_google' };
      break;
    }
    case 'partiful':
      if (needsYou || neverRan || /sign.?in|log.?in|logged.?out|session/.test(reason)) return { kind: 'sign_in_partiful' };
      break;
    case 'whatsapp':
      if (needsYou || neverRan || /not.?linked|unlinked|logged.?out|not.?installed/.test(reason)) return { kind: 'link_whatsapp' };
      break;
    case 'beeper':
      if (needsYou || /disconnect|logged.?out|signed.?out/.test(reason)) return { kind: 'beeper_disconnected' };
      if (neverRan) return { kind: 'beeper_setup' };
      break;
    case 'instagram_dyi':
      if (needsYou || neverRan || status === 'stale') return { kind: 'drop_instagram_export', folder: displayFolder(o.importsDir) };
      break;
    case 'addressbook':
      if (needsYou || /denied|not.?authori[sz]ed|permission/.test(reason)) return { kind: 'allow_contacts' };
      break;
    case 'imessage':
    case 'collector':
    case 'calls':
      if (needsYou || neverRan) return { kind: 'collector_setup' };
      break;
  }
  if (status === 'contract_broken') return { kind: 'contract_broken' };
  return null;
}

/** Per-card counts. Each map is card → value; the queries group by raw source and fold through cardFor(). */
function countsByCard(db: DB, now: number): Map<string, SourceCounts> {
  const out = new Map<string, SourceCounts>();
  const add = (source: string, key: keyof SourceCounts, n: number) => {
    const card = cardFor(source);
    const c = out.get(card) ?? {};
    c[key] = (c[key] ?? 0) + n;
    out.set(card, c);
  };
  for (const r of db.prepare('SELECT source, count(*) AS n FROM conversations GROUP BY source').all() as { source: string; n: number }[])
    add(r.source, 'conversations', r.n);
  for (const r of db
    .prepare(`SELECT source, count(*) AS n FROM identities WHERE status <> 'detached' GROUP BY source`)
    .all() as { source: string; n: number }[])
    add(r.source, 'identities', r.n);

  // People are counted once per card even when two aliases link the same person.
  const people = db
    .prepare(
      `SELECT DISTINCT i.source, pv.id AS pid
       FROM identities i
       LEFT JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN person_visible pv ON pv.id = coalesce(pc.canonical_id, i.person_id)
       WHERE i.status <> 'detached'`,
    )
    .all() as { source: string; pid: string }[];
  const perCard = new Map<string, Set<string>>();
  for (const r of people) {
    const card = cardFor(r.source);
    const set = perCard.get(card) ?? new Set<string>();
    set.add(r.pid);
    perCard.set(card, set);
  }
  for (const [card, set] of perCard) add(card, 'people', set.size);

  const cards = db.prepare(`SELECT count(*) FROM identities WHERE kind = 'addressbook_id' AND status <> 'detached'`).pluck().get() as number;
  if (cards > 0) add('addressbook', 'contactCards', cards);

  const calls = db.prepare('SELECT count(*) FROM calls').pluck().get() as number;
  if (calls > 0) add('calls', 'calls', calls);

  const ev = db
    .prepare(`SELECT count(*) AS n, coalesce(sum(starts_at >= ?), 0) AS up FROM events WHERE source = 'partiful'`)
    .get(now) as { n: number; up: number };
  const guests = db
    .prepare(`SELECT count(*) FROM event_attendees a JOIN events e ON e.id = a.event_id WHERE e.source = 'partiful' AND a.source = 'partiful'`)
    .pluck()
    .get() as number;
  if (ev.n > 0) {
    add('partiful', 'events', ev.n);
    add('partiful', 'upcomingEvents', ev.up);
  }
  if (guests > 0) add('partiful', 'guests', guests);

  const cal = db
    .prepare(`SELECT count(*) AS n, count(DISTINCT calendar_id) AS cals FROM calendar_events WHERE status <> 'cancelled'`)
    .get() as { n: number; cals: number };
  if (cal.n > 0) {
    add('gcal', 'calendarEvents', cal.n);
    add('gcal', 'calendars', cal.cals);
  }
  const occ = db.prepare(`SELECT count(*) FROM occasions WHERE status = 'active'`).pluck().get() as number;
  if (occ > 0) add('gcal', 'occasions', occ);

  const mail = db.prepare(`SELECT count(*) AS n, coalesce(sum(triage = 'candidate'), 0) AS tickets FROM gmail_messages`).get() as { n: number; tickets: number };
  if (mail.n > 0) add('gmail', 'emailsScanned', mail.n);
  if (mail.tickets > 0) add('gmail', 'ticketEmails', mail.tickets);
  const tickets = db.prepare('SELECT count(*) FROM ticket_events WHERE merged_into_id IS NULL').pluck().get() as number;
  if (tickets > 0) add('gmail', 'tickets', tickets);
  // Linked to a visible person, as Settings → Email & photos counts them (adapters/gphotos/sessions.ts).
  const shots = db
    .prepare(
      `SELECT count(*) AS n,
              coalesce(sum(cs.status = 'linked' AND EXISTS (SELECT 1 FROM person_canon pc JOIN person_visible pv ON pv.id = pc.canonical_id
                                                           WHERE pc.person_id = cs.person_id)), 0) AS linked
       FROM contact_screenshots cs`,
    )
    .get() as { n: number; linked: number };
  if (shots.n > 0) add('gphotos', 'screenshots', shots.n);
  if (shots.linked > 0) add('gphotos', 'screenshotsLinked', shots.linked);
  return out;
}

export function sourcesView(db: DB, now = Date.now(), opts: SourcesOptions = {}): SourcesView {
  const o: Required<SourcesOptions> = {
    googleConfigured: opts.googleConfigured ?? false,
    secretsAvailable: opts.secretsAvailable ?? false,
    beeperConfigured: opts.beeperConfigured ?? false,
    importsDir: opts.importsDir ?? '',
  };
  const health = db.prepare('SELECT * FROM source_health').all() as HealthRow[];
  const cursors = db.prepare('SELECT source, scope, cursor, high_water_at, updated_at FROM source_cursors ORDER BY updated_at DESC, source, scope').all() as {
    source: string;
    scope: string;
    cursor: string;
    high_water_at: number | null;
    updated_at: number;
  }[];
  const msgCounts = db
    .prepare(
      `SELECT source, count(*) AS total,
              coalesce(sum(sent_at >= @d1), 0) AS d1, coalesce(sum(sent_at >= @d7), 0) AS d7,
              min(sent_at) AS oldest, max(sent_at) AS newest
       FROM messages GROUP BY source`,
    )
    .all({ d1: now - DAY, d7: now - 7 * DAY }) as { source: string; total: number; d1: number; d7: number; oldest: number | null; newest: number | null }[];
  const counts = countsByCard(db, now);
  const connected = new Set(Object.values(PRODUCT_CARDS).filter((p) => isConnected(db, p)));

  const names = new Set<string>([
    ...CARDS.filter((c) => c.core).map((c) => c.source),
    // Delivery channels are not sources (gmail_send: the weekly email; its status lives in Settings → Email & photos).
    ...[...health, ...cursors, ...msgCounts].map((x) => cardFor(x.source)).filter((s) => !NOT_SOURCES.has(s)),
  ]);
  const sources = [...names]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((source): SourceView => {
      const hs = health.filter((x) => cardFor(x.source) === source);
      const h = [...hs].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || b.checked_at - a.checked_at)[0];
      const cs = cursors.filter((c) => cardFor(c.source) === source);
      const ms = msgCounts.filter((c) => cardFor(c.source) === source);
      const messages: SourceMessageCounts | null = ms.length
        ? {
            total: ms.reduce((n, m) => n + m.total, 0),
            last24h: ms.reduce((n, m) => n + m.d1, 0),
            last7d: ms.reduce((n, m) => n + m.d7, 0),
            oldestAt: minOf(ms.map((m) => m.oldest)),
            newestAt: maxOf(ms.map((m) => m.newest)),
          }
        : null;
      const c = counts.get(source) ?? {};
      const status = h?.status ?? 'unknown';
      const details = parseDetails(h?.details ?? null);
      const hasData = messages != null || cs.length > 0 || Object.values(c).some((n) => n > 0);
      const configured =
        source === 'gcal' || Object.hasOwn(PRODUCT_CARDS, source) ? o.googleConfigured : source === 'beeper' ? o.beeperConfigured || hs.length > 0 : true;
      return {
        source,
        status,
        lastOkAt: maxOf(hs.map((x) => x.last_ok_at)),
        newestDataAt: maxOf(hs.map((x) => x.newest_data_at)) ?? messages?.newestAt ?? null,
        checkedAt: maxOf(hs.map((x) => x.checked_at)),
        lastError: h?.last_error ? redact(h.last_error) : null,
        details,
        cursors: cs.slice(0, CURSOR_CAP).map((x) => ({
          scope: redact(x.scope, 80),
          cursor: clip(redact(x.cursor), 32),
          highWaterAt: x.high_water_at,
          updatedAt: x.updated_at,
        })),
        cursorCount: cs.length,
        messages,
        counts: c,
        configured,
        fix: fixFor(source, status, hasData, reasonText(h, details), details, o, connected),
      };
    });
  return { sources, generatedAt: now };
}

export function sourcesRoutes({ db, config }: RouteDeps): Router {
  const r = Router();
  const opts: SourcesOptions = {
    googleConfigured: config?.google != null,
    secretsAvailable: config?.secretsKey != null,
    beeperConfigured: Boolean(config?.beeper.token || config?.secretsKey),
    importsDir: config?.importsDir,
  };
  r.get('/sources', (_req, res) => {
    res.json(sourcesView(db, Date.now(), opts) satisfies SourcesView);
  });
  return r;
}
