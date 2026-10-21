/**
 * The Gmail ticket source over a fake Gmail (adapters/gmail/{api,sync,jobs}.ts): list → triage → fetch → clean →
 * gmail_messages 'pending' with a masked excerpt and ticket_parties; known messages are never fetched again; the
 * high-water mark and the backfill walk; the per-run caps; health and auth handling (403 insufficientPermissions →
 * auth_required, no backoff); and counts-only logs.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { gmailApi } from '../../../src/adapters/gmail/api';
import { gmailJobs, runGmailSync } from '../../../src/adapters/gmail/jobs';
import { backfillFrom, GMAIL_SOURCE, isBackfilling, LIST_SCOPE, syncGmail } from '../../../src/adapters/gmail/sync';
import { connectedClient, GMAIL_REFRESH_TOKEN_SECRET, guardedFetch } from '../../../src/adapters/calendar/google';
import { cursorMeta, readCursor, writeCursor } from '../../../src/adapters/common/cursors';
import type { DB } from '../../../src/db/connection';
import type { LogFields, Logger } from '../../../src/ops/logger';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { setSecret } from '../../../src/security/secrets';
import { writeSettings } from '../../../src/settings/registry';
import { memDb, seedIdentity, seedPerson } from '../../helpers';
import { addr, CLIENT, FakeGmail, FRIEND_FROM, orderHtml, OWNER_EMAIL, REFRESH_TOKEN, VENDOR_DOMAIN, VENDOR_FROM } from './fakeGmail';

const KEY = crypto.randomBytes(32);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 16);
const DANA_EMAIL = addr('dana.reyes', 'example.com');

const fakes: FakeGmail[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(o: { connected?: boolean } = {}) {
  const db = memDb();
  writeSettings(db, { tz: 'America/New_York', 'gmail.extra_senders': [VENDOR_DOMAIN] }, { actor: 'user', now: NOW });
  const me = seedPerson(db, { kind: 'me', display_name: 'Sam Varga', first_name: 'Sam', last_name: 'Varga', status: 'active' });
  seedIdentity(db, me, 'email', OWNER_EMAIL);
  const g = new FakeGmail();
  fakes.push(g);
  if (o.connected !== false) setSecret(db, KEY, GMAIL_REFRESH_TOKEN_SECRET, REFRESH_TOKEN, NOW);
  return { db, g };
}

function captureLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) => void lines.push({ level, event, fields });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const ctx = (db: DB, now: number, log: Logger = captureLog()): JobContext => ({ db, jobRunId: 1, trigger: 'manual', now: () => now, log, signal: new AbortController().signal });
const deps = (g: FakeGmail) => ({ google: CLIENT, secretsKey: KEY, fetch: g.fetch });
const api = (db: DB, g: FakeGmail) => gmailApi(connectedClient(db, KEY, CLIENT, g.fetch, 'gmail')!);

const row = (db: DB, id: string) => db.prepare('SELECT * FROM gmail_messages WHERE gmail_id = ?').get(id) as Record<string, unknown> | undefined;
const health = (db: DB) => db.prepare('SELECT status, last_error, details FROM source_health WHERE source = ?').get(GMAIL_SOURCE) as { status: string; last_error: string | null; details: string } | undefined;

/** A realistic inbox: transactional, marketing, unrelated, owner-sent, a pass, a transfer and a forward. */
function inbox(g: FakeGmail) {
  const h = 3_600_000;
  return {
    order: g.add({ at: NOW - 5 * h, from: VENDOR_FROM, subject: 'Your order confirmation', html: orderHtml({ seats: 2 }) }),
    presale: g.add({ at: NOW - 6 * h, from: VENDOR_FROM, subject: 'Presale starts tomorrow: Halcy Drift', html: '<p>Presale code inside</p>' }),
    lunch: g.add({ at: NOW - 7 * h, from: FRIEND_FROM, subject: 'Lunch on Friday?', text: 'Lunch?' }),
    question: g.add({ at: NOW - 8 * h, from: FRIEND_FROM, subject: 'Re: tickets for Saturday?', text: 'Do you still have the tickets?' }),
    meetup: g.add({
      at: NOW - 9 * h,
      from: `Design Meetup <${addr('events', 'meetup.example')}>`,
      subject: 'Registration confirmed: Design Meetup',
      text: `You're registered for Design Meetup on Thu, Nov 12 at 6:30 PM.\n${'See you there. '.repeat(20)}`,
      attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar' }],
    }),
    sent: g.add({ at: NOW - 10 * h, from: `Sam Varga <${OWNER_EMAIL}>`, subject: 'Fwd: Your tickets for Lumen Arcade', text: 'fyi', labelIds: ['SENT'] }),
    transfer: g.add({
      at: NOW - 11 * h,
      from: VENDOR_FROM,
      subject: 'Your tickets are on their way to Dana Reyes',
      text: `Hi Sam,\nYou sent 2 tickets to Dana Reyes (${DANA_EMAIL}) for Lumen Arcade, Sat, Nov 7.\nDana Reyes has 7 days to accept.\n${'Ticket details. '.repeat(15)}`,
    }),
    forward: g.add({
      at: NOW - 12 * h,
      from: FRIEND_FROM,
      subject: 'Fwd: Your order confirmation',
      text: `Sam, you're coming with us! Rowan\n---------- Forwarded message ---------\nFrom: Tickets Example <${addr('noreply', VENDOR_DOMAIN)}>\nTo: Rowan Quill <${addr('rowan.quill', 'example.com')}>\n\nHi Rowan,\nYour order is confirmed: 2 tickets to Lumen Arcade, Sat, Nov 7. Order #: AB-1234.\n${'Details. '.repeat(30)}`,
    }),
  };
}

describe('a pass', () => {
  it('lists, triages on metadata, fetches only candidates, stores masked excerpts, refs and counterparties', async () => {
    const { db, g } = setup();
    const m = inbox(g);
    const log = captureLog();
    const out = await runGmailSync(ctx(db, NOW, log), deps(g));
    expect(out).toMatchObject({ status: 'ok' });

    // Gmail did the coarse filtering: unrelated and owner-sent mail was never even fetched.
    const gets = g.callsTo(/\/messages\/[^/]+$/);
    const fetched = (id: string, format: string) => gets.some((c) => c.path.endsWith(id) && c.query.get('format') === format);
    expect(fetched(m.lunch, 'metadata') || fetched(m.sent, 'metadata')).toBe(false);
    for (const id of [m.order, m.presale, m.question, m.meetup, m.transfer, m.forward]) expect(fetched(id, 'metadata'), id).toBe(true);
    for (const id of [m.order, m.meetup, m.transfer, m.forward]) expect(fetched(id, 'full'), id).toBe(true);
    for (const id of [m.presale, m.question]) expect(fetched(id, 'full'), id).toBe(false);
    expect(gets.find((c) => c.query.get('format') === 'metadata')!.query.getAll('metadataHeaders')).toEqual(['From', 'Subject']);

    expect(row(db, m.order)).toMatchObject({ triage: 'candidate', parse_status: 'pending', vendor: VENDOR_DOMAIN, from_domain: VENDOR_DOMAIN });
    expect(row(db, m.presale)).toMatchObject({ triage: 'marketing', parse_status: 'skipped', clean_text: null, subject: 'Presale starts tomorrow: Halcy Drift' });
    expect(row(db, m.question)).toMatchObject({ triage: 'ignored', parse_status: 'skipped', subject: null, clean_text: null, from_domain: 'example.com' });
    expect(row(db, m.meetup)).toMatchObject({ triage: 'candidate', vendor: null });
    expect(row(db, m.forward)).toMatchObject({ triage: 'candidate', vendor: null });
    expect(row(db, m.lunch)).toBeUndefined();
    expect(row(db, m.sent)).toBeUndefined();

    const refs = JSON.parse(row(db, m.order)!.refs as string);
    expect(refs).toMatchObject({ vendorEventId: 'ticketmaster:0b00abcd12345678', orderRef: '12-34567/NY', qty: 2, qtySource: 'json_ld_seats' });
    expect(JSON.parse(row(db, m.meetup)!.refs as string)).toMatchObject({ ics: true, weekdays: { '11-12': 4 } });
    expect(JSON.parse(row(db, m.forward)!.refs as string)).toMatchObject({ forwarded: true, orderRef: 'AB-1234' });

    // Counterparties are local; their names, the owner's and the forwarder's never reach the excerpt.
    expect(db.prepare('SELECT gmail_id, direction, name, email_key, quantity FROM ticket_parties').all()).toEqual([
      { gmail_id: m.transfer, direction: 'sent_to', name: 'Dana Reyes', email_key: DANA_EMAIL, quantity: 2 },
    ]);
    const excerpts = db.prepare('SELECT clean_text FROM gmail_messages WHERE clean_text IS NOT NULL').pluck().all() as string[];
    expect(excerpts).toHaveLength(4);
    for (const t of excerpts) {
      const c = JSON.parse(t) as { s: string; t: string };
      for (const never of ['Dana', 'Reyes', 'Varga', 'Sam', 'Rowan', 'Quill', DANA_EMAIL, '12-34567']) expect(`${c.s}\n${c.t}`, never).not.toContain(never);
    }

    // Health, cursor, and counts-only logs.
    expect(health(db)).toMatchObject({ status: 'ok', last_error: null });
    expect(JSON.parse(health(db)!.details)).toMatchObject({ connected: true, candidates: 4, pending: 4, backfilling: false }); // nothing older to walk
    const cur = readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!;
    expect(cur.high_water_at).toBe(NOW - 5 * 3_600_000);
    const logged = JSON.stringify(log.lines);
    for (const never of ['Dana', 'Reyes', 'Varga', 'Rowan', '@', 'order confirmation', 'Presale', m.order, m.transfer]) expect(logged, never).not.toContain(never);
    expect(log.lines.find((l) => l.event === 'gmail.sync')?.fields?.counts).toMatchObject({ candidates: 4, marketing: 1, ignored: 1, fetched: 4, parties: 1 });

    // A second pass looks at nothing it has seen.
    g.calls.length = 0;
    const again = await syncGmail(db, api(db, g), { now: NOW + 30 * 60_000 });
    expect(g.callsTo(/\/messages\/[^/]+$/)).toEqual([]);
    expect(again).toMatchObject({ metadata: 0, fetched: 0, known: 6 });
  });

  it('skips and reads disabled before Gmail is connected', async () => {
    const { db, g } = setup({ connected: false });
    inbox(g);
    expect(await runGmailSync(ctx(db, NOW), deps(g))).toEqual({ status: 'skipped', stats: { not_connected: 1 } });
    expect(health(db)).toMatchObject({ status: 'disabled' });
    expect(g.calls).toEqual([]);
  });

  it('the job definition: gmail, every 30 min', () => {
    const jobs = gmailJobs(deps(new FakeGmail()));
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['gmail', { kind: 'interval', everyMs: 30 * 60_000 }]]);
  });
});

describe('auth and errors', () => {
  it('403 insufficientPermissions → auth_required, skipped (no failure backoff), nothing thrown', async () => {
    const { db, g } = setup();
    inbox(g);
    g.failAll = { status: 403, reason: 'insufficientPermissions' };
    const out = await runGmailSync(ctx(db, NOW), deps(g));
    expect(out).toEqual({ status: 'skipped', stats: { auth_required: 1 } });
    expect(health(db)).toMatchObject({ status: 'auth_required' });
  });

  it('a revoked grant (invalid_grant) → auth_required; the API not enabled → an error card, skipped', async () => {
    const { db, g } = setup();
    g.refreshTokens.clear();
    expect(await runGmailSync(ctx(db, NOW), deps(g))).toEqual({ status: 'skipped', stats: { auth_required: 1 } });
    expect(health(db)!.status).toBe('auth_required');
    const second = setup();
    second.g.failAll = { status: 403, reason: 'accessNotConfigured' };
    expect(await runGmailSync(ctx(second.db, NOW), deps(second.g))).toEqual({ status: 'skipped', stats: { api_disabled: 1 } });
    expect(health(second.db)).toMatchObject({ status: 'error', last_error: 'The Gmail API is not enabled in the Google Cloud project.' });
  });

  it('a server error on the listing throws (the scheduler backs off) and records an error', async () => {
    const { db, g } = setup();
    g.failAll = { status: 500, reason: 'backendError' };
    await expect(runGmailSync(ctx(db, NOW), deps(g))).rejects.toThrow(/500/);
    expect(health(db)!.status).toBe('error');
  });

  it('one message failing to fetch stays pending for the next run; a vanished one is skipped', async () => {
    const { db, g } = setup();
    const m = inbox(g);
    g.failGet.set(m.transfer, 503);
    const first = await syncGmail(db, api(db, g), { now: NOW });
    expect(first.fetch_failed).toBe(1);
    expect(row(db, m.transfer)).toBeUndefined();
    // The mark doesn't move past a listing with a hole in it.
    expect(readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!.high_water_at).toBeNull();
    g.failGet.delete(m.transfer);
    g.failGet.set(m.forward, 404);
    db.prepare('UPDATE gmail_messages SET clean_text = NULL WHERE gmail_id = ?').run(m.forward);
    await syncGmail(db, api(db, g), { now: NOW + 60_000 });
    expect(row(db, m.transfer)).toMatchObject({ triage: 'candidate', parse_status: 'pending' });
    expect(row(db, m.forward)).toMatchObject({ parse_status: 'skipped', error_class: 'gone' });
  });

  it('every request stays on the read-only allowlist', async () => {
    const refused = guardedFetch(new FakeGmail().fetch);
    await expect(refused('https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/trash', { method: 'POST' })).rejects.toThrow(/allowlist/);
    await expect(refused('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST' })).rejects.toThrow(/allowlist/);
  });
});

describe('cursors', () => {
  it('the high-water mark re-lists two days of overlap; a metadata cap holds it back until the listing is done', async () => {
    const { db, g } = setup();
    const ids = [1, 2, 3, 4].map((h) => g.add({ at: NOW - h * 3_600_000, from: VENDOR_FROM, subject: 'Your order confirmation', text: 'Order #: R-100'.padEnd(250, '.') }));
    const first = await syncGmail(db, api(db, g), { now: NOW, limits: { metadataPerRun: 2 } });
    expect(first).toMatchObject({ metadata: 2, budget_cut: 1 });
    expect(readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!.high_water_at).toBeNull();
    await syncGmail(db, api(db, g), { now: NOW + 60_000, limits: { metadataPerRun: 2 } });
    expect(ids.every((id) => row(db, id))).toBe(true);
    expect(readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!.high_water_at).toBe(NOW - 3_600_000);
    // The next listing starts two days before the mark.
    g.calls.length = 0;
    await syncGmail(db, api(db, g), { now: NOW + 2 * 60_000 });
    const q = g.callsTo(/\/messages$/)[0]!.query.get('q')!;
    expect(q.startsWith(`after:${Math.floor((NOW - 3_600_000 - 2 * DAY) / 1000)} -in:sent`)).toBe(true);
  });

  it('the backfill walks back one page per run to now − gmail.backfill_days, then stops', async () => {
    const { db, g } = setup();
    writeSettings(db, { 'gmail.backfill_days': 30 }, { actor: 'user', now: NOW });
    const days = [3, 8, 13, 18, 25, 40];
    const ids = days.map((d) => g.add({ at: NOW - d * DAY, from: VENDOR_FROM, subject: 'Your order confirmation', text: `Order #: R-${d}00`.padEnd(250, '.') }));
    const run = (k: number) => syncGmail(db, api(db, g), { now: NOW + k * 60_000, limits: { pageSize: 2 } });
    const seen = () => ids.filter((id) => row(db, id)).length;

    await run(0);
    expect(seen()).toBe(2);
    const meta = () => cursorMeta<{ backfillBefore: number; backfillFrom: number }>(readCursor(db, GMAIL_SOURCE, LIST_SCOPE));
    expect(meta().backfillFrom).toBe(NOW - 2 * DAY);
    // The next page starts at the oldest message's second again (before: has whole-second resolution).
    expect(meta().backfillBefore).toBe(NOW - 8 * DAY + 1000);
    expect(isBackfilling(db, NOW)).toBe(true);
    expect(backfillFrom(db, NOW)).toBe(NOW - 2 * DAY);

    await run(1);
    expect(seen()).toBe(3); // day 8 again (known: no metadata fetch) and day 13
    expect(meta().backfillBefore).toBe(NOW - 13 * DAY + 1000);
    let k = 2;
    let last = await run(k);
    while (!last.backfill_done && k < 10) last = await run(++k);
    expect(last.backfill_done).toBe(1);
    expect(seen()).toBe(5); // day 40 is past the 30-day floor
    expect(row(db, ids[5]!)).toBeUndefined();
    expect(isBackfilling(db, NOW + (k + 1) * 60_000)).toBe(false);
    expect(backfillFrom(db, NOW + (k + 1) * 60_000)).toBeNull();

    // Done: later passes list nothing older.
    g.calls.length = 0;
    const after = await run(k + 1);
    expect(after.backfill_pages).toBe(0);
    // Raising the setting resumes the walk.
    writeSettings(db, { 'gmail.backfill_days': 60 }, { actor: 'user', now: NOW });
    for (let n = 0; n < 4 && !row(db, ids[5]!); n++) await run(k + 2 + n);
    expect(row(db, ids[5]!)).toMatchObject({ triage: 'candidate' });
  });

  it('a backfill page boundary inside one second drops nothing (mails of one order often share a second)', async () => {
    const { db, g } = setup();
    writeSettings(db, { 'gmail.backfill_days': 30 }, { actor: 'user', now: NOW });
    const t = NOW - 5 * DAY; // a whole second
    const mk = (at: number, n: number) => g.add({ at, from: VENDOR_FROM, subject: 'Your order confirmation', text: `Order #: R-${n}00`.padEnd(250, '.') });
    const ids = [mk(NOW - 3 * DAY, 1), mk(t + 500, 2), mk(t + 100, 3)];
    for (let k = 0; k < 4; k++) await syncGmail(db, api(db, g), { now: NOW + k * 60_000, limits: { pageSize: 2 } });
    expect(ids.map((id) => row(db, id)?.triage)).toEqual(['candidate', 'candidate', 'candidate']);
  });

  it('until a whole steady listing was seen, the steady range keeps starting where the backfill started (no gap)', async () => {
    const { db, g } = setup();
    const HOUR = 3_600_000;
    const mk = (at: number, n: number) => g.add({ at, from: VENDOR_FROM, subject: 'Your order confirmation', text: `Order #: R-${n}00`.padEnd(250, '.') });
    // The first pass can't read one mail near the start of its range (a transient error), so it sets no mark; the
    // backfill starts below that range. A newer mail then sets the mark more than two days past the missed one: a
    // steady range that slid with `now` would have dropped it between the two walks for good.
    const missed = mk(NOW - 47 * HOUR, 1);
    g.failGet.set(missed, 503);
    await syncGmail(db, api(db, g), { now: NOW });
    expect(row(db, missed)).toBeUndefined();
    g.failGet.delete(missed);
    const later = mk(NOW + 2 * HOUR, 2);
    await syncGmail(db, api(db, g), { now: NOW + 3 * HOUR });
    await syncGmail(db, api(db, g), { now: NOW + 4 * HOUR });
    expect(row(db, later)).toMatchObject({ triage: 'candidate' });
    expect(row(db, missed)).toMatchObject({ triage: 'candidate' });
    expect(readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!.high_water_at).toBe(NOW + 2 * HOUR);
  });

  it('a steady range too long for one run is walked down to the mark, which moves only once all of it was seen', async () => {
    const { db, g } = setup();
    writeSettings(db, { 'gmail.backfill_days': 30 }, { actor: 'user', now: NOW });
    // A grant that lapsed for weeks: the mark is 20 days old, the backfill long done, and the range since holds more
    // matching mail than one run lists.
    const hw = NOW - 20 * DAY;
    writeCursor(db, GMAIL_SOURCE, LIST_SCOPE, 'v1', NOW, { highWaterAt: hw, meta: { backfillBefore: NOW - 30 * DAY, backfillFrom: hw } });
    const ids = Array.from({ length: 14 }, (_, i) => g.add({ at: NOW - (i + 1) * DAY, from: VENDOR_FROM, subject: 'Your order confirmation', text: `Order #: R-${i + 1}00`.padEnd(250, '.') }));
    const run = (k: number) => syncGmail(db, api(db, g), { now: NOW + k * 60_000, limits: { pageSize: 2, steadyPages: 2 } });
    const mark = () => readCursor(db, GMAIL_SOURCE, LIST_SCOPE)!.high_water_at;
    let k = 0;
    while (mark() === hw && k < 20) await run(k++);
    expect(ids.filter((id) => !row(db, id))).toEqual([]);
    // The mark never skipped ahead of mail it had not seen.
    expect(mark()).toBe(NOW - DAY);
    expect(cursorMeta<Record<string, unknown>>(readCursor(db, GMAIL_SOURCE, LIST_SCOPE))).not.toHaveProperty('steadyBefore');
    // From there the steady listing fits in one run again.
    await run(k++);
    expect(mark()).toBe(NOW - DAY);
  });

  it('a message Gmail keeps answering in an unexpected shape is given up after three runs', async () => {
    const { db, g } = setup();
    const id = g.add({ at: NOW - 3_600_000, from: VENDOR_FROM, subject: 'Your order confirmation', text: 'Order #: R-500'.padEnd(250, '.') });
    g.badFull.add(id);
    for (let k = 0; k < 3; k++) {
      const s = await syncGmail(db, api(db, g), { now: NOW + k * 60_000 });
      expect(s.fetch_failed).toBe(1);
    }
    expect(row(db, id)).toMatchObject({ parse_status: 'failed', error_class: 'contract', attempts: 3, clean_text: null });
    g.calls.length = 0;
    await syncGmail(db, api(db, g), { now: NOW + 10 * 60_000 });
    expect(g.callsTo(/\/messages\/[^/]+$/)).toEqual([]);
  });
});
