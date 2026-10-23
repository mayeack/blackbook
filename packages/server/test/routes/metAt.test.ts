/**
 * The person page's "Met at" (routes/personExtras.ts over intel/metAt/store.ts): GET /people/:id/met lists the
 * person's active links (earliest event first, any merged-away record's included, sensitive targets never), and
 * POST /people/:id/met/:linkId/wrong rejects one through the journal: undoable from Today, and only for that person's
 * own links. Synthetic world: invented names and titles.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { BatchRef, MetAtList, uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { createApp } from '../../src/http/app';
import { undoBatch } from '../../src/journal/undo';
import { metAtWrong, personMetAt } from '../../src/routes/personExtras';
import { memDb, seedPerson, T0 } from '../helpers';
import { DAY } from './world';

const HOUR = 3_600_000;
const JSON_HEADERS = { 'x-yb': '1', 'content-type': 'application/json' };
const devApp = (db: DB) => createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

function occasion(db: DB, title: string, startsAt: number, o: { sensitive?: number; mergedInto?: string; eventId?: string } = {}): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO occasions (id, kind, is_social, title, starts_at, venue_text, sensitive, merged_into_id, event_id, status, created_at, updated_at)
     VALUES (?, 'social', 1, ?, ?, 'The Hall', ?, ?, ?, 'active', ?, ?)`,
  ).run(id, title, startsAt, o.sensitive ?? 0, o.mergedInto ?? null, o.eventId ?? null, T0, T0);
  return id;
}

function partiful(db: DB, title: string, startsAt: number): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO events (id, source, source_event_id, title, starts_at, location_text, created_at, updated_at) VALUES (?, 'partiful', ?, ?, ?, 'A Loft', ?, ?)`,
  ).run(id, `pf-${id}`, title, startsAt, T0, T0);
  return id;
}

function link(db: DB, personId: string, target: { occasion?: string; event?: string }, o: { status?: string; signal?: string; confidence?: number } = {}): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO person_met_at (id, person_id, occasion_id, event_id, target_key, signal, signal_at, confidence, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inferred', ?, ?)`,
  ).run(
    id,
    personId,
    target.occasion ?? null,
    target.event ?? null,
    target.occasion ? `o:${target.occasion}` : `e:${target.event}`,
    o.signal ?? 'instagram_follow',
    T0 + HOUR,
    o.confidence ?? 0.8,
    o.status ?? 'active',
    T0,
    T0,
  );
  return id;
}

function world() {
  const db = memDb();
  const ana = seedPerson(db, { first_name: 'Ana', last_name: 'Zed', display_name: 'Ana Zed' });
  const anaDup = seedPerson(db, { first_name: 'Ana', last_name: 'Zed-Dup', display_name: 'Ana Zed-Dup' });
  db.prepare(`UPDATE people SET status = 'merged', merged_into_id = ? WHERE id = ?`).run(ana, anaDup);
  const bo = seedPerson(db, { first_name: 'Bo', last_name: 'Abel', display_name: 'Bo Abel' });
  const hidden = seedPerson(db, { first_name: 'Hal', last_name: 'Hidden', display_name: 'Hal Hidden', is_hidden: 1 });
  rebuildPersonCanon(db);
  return { db, ana, anaDup, bo, hidden };
}

describe('GET /api/v1/people/:id/met', () => {
  it('lists active links earliest event first: merged records included, occasions resolved, sensitive targets never', async () => {
    const { db, ana, anaDup } = world();
    const show = occasion(db, 'Neon Nights', T0 - 2 * DAY);
    const oldShow = occasion(db, 'Neon Nights (copy)', T0 - 2 * DAY, { mergedInto: show });
    const pf = partiful(db, 'Rooftop Social', T0 - 9 * DAY);
    const clinic = occasion(db, 'Clinic', T0 - DAY, { sensitive: 1 });
    const l1 = link(db, anaDup, { occasion: oldShow }, { signal: 'contact_screenshot', confidence: 0.85 });
    const l2 = link(db, ana, { event: pf }, { signal: 'instagram_dm', confidence: 0.65 });
    link(db, ana, { occasion: clinic });
    link(db, ana, { occasion: show }, { status: 'withdrawn' });
    db.prepare(`INSERT INTO contact_screenshots (id, source, source_ref, status, person_id, created_at, updated_at) VALUES (?, 'gphotos', 'item-1', 'linked', ?, ?, ?)`).run(
      uuidv7(),
      anaDup,
      T0,
      T0,
    );

    const res = await request(devApp(db)).get(`/api/v1/people/${anaDup}/met`);
    expect(res.status).toBe(200);
    const list = MetAtList.parse(res.body);
    expect(list.personId).toBe(ana);
    expect(list.links).toEqual([
      {
        id: l2,
        target: { type: 'event', id: pf },
        title: 'Rooftop Social',
        startsAt: T0 - 9 * DAY,
        venue: 'A Loft',
        href: `/e/${pf}`,
        signal: 'instagram_dm',
        signalAt: T0 + HOUR,
        confidence: 0.65,
        screenshot: true,
      },
      {
        id: l1,
        target: { type: 'occasion', id: show },
        title: 'Neon Nights',
        startsAt: T0 - 2 * DAY,
        venue: 'The Hall',
        href: `/e/${show}`,
        signal: 'contact_screenshot',
        signalAt: T0 + HOUR,
        confidence: 0.85,
        screenshot: true,
      },
    ]);
    expect(res.text).not.toContain('Clinic');
  });

  it('a Partiful event a get-together now covers is shown as that get-together', () => {
    const { db, bo } = world();
    const pf = partiful(db, 'Rooftop Social', T0 - 3 * DAY);
    const occ = occasion(db, 'Rooftop Social (calendar)', T0 - 3 * DAY, { eventId: pf });
    link(db, bo, { event: pf });
    expect(personMetAt(db, bo).links.map((l) => [l.target, l.href])).toEqual([[{ type: 'occasion', id: occ }, `/e/${occ}`]]);
  });

  it('nobody: an empty list; hidden people and unknown ids answer 404', async () => {
    const { db, bo, hidden } = world();
    const app = devApp(db);
    expect((await request(app).get(`/api/v1/people/${bo}/met`)).body).toEqual({ personId: bo, links: [] });
    expect((await request(app).get(`/api/v1/people/${hidden}/met`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/people/${uuidv7()}/met`)).status).toBe(404);
    expect((await request(app).get('/api/v1/people/not-an-id/met')).status).toBe(400);
  });
});

describe('POST /api/v1/people/:id/met/:linkId/wrong', () => {
  it('rejects the link in one journaled user batch; undo restores it', async () => {
    const { db, ana, anaDup } = world();
    const show = occasion(db, 'Neon Nights', T0 - 2 * DAY);
    const l = link(db, anaDup, { occasion: show });
    const app = devApp(db);

    expect((await request(app).post(`/api/v1/people/${ana}/met/${l}/wrong`).send({})).status).toBe(403); // CSRF
    const res = await request(app).post(`/api/v1/people/${ana}/met/${l}/wrong`).set(JSON_HEADERS).send({});
    expect(res.status).toBe(200);
    const { batchId } = BatchRef.parse(res.body);
    expect(batchId).toEqual(expect.any(String));
    expect(db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(l)).toBe('rejected');
    const batch = db.prepare('SELECT b.kind, b.actor, b.subject_person_id, r.kind AS run_kind FROM change_batches b JOIN runs r ON r.id = b.run_id WHERE b.id = ?').get(batchId) as Record<
      string,
      unknown
    >;
    expect(batch).toEqual({ kind: 'met_at', actor: 'user', subject_person_id: ana, run_kind: 'user' });
    expect((await request(app).get(`/api/v1/people/${ana}/met`)).body.links).toEqual([]);

    // Again: nothing left to change.
    expect((await request(app).post(`/api/v1/people/${ana}/met/${l}/wrong`).set(JSON_HEADERS).send({})).body).toEqual({ batchId: null });

    undoBatch(db, batchId!);
    expect(db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(l)).toBe('active');
    expect(MetAtList.parse((await request(app).get(`/api/v1/people/${ana}/met`)).body).links.map((x) => x.id)).toEqual([l]);
  });

  it('rejects every active link of the person’s records to the same happening in one batch (merge chain, Partiful twin)', () => {
    const { db, ana, anaDup, bo } = world();
    const pf = partiful(db, 'Rooftop Social', T0 - 3 * DAY);
    const show = occasion(db, 'Rooftop Social', T0 - 3 * DAY, { eventId: pf });
    const oldShow = occasion(db, 'Rooftop Social (copy)', T0 - 3 * DAY, { mergedInto: show });
    const other = occasion(db, 'Neon Nights', T0 - 9 * DAY);
    const shown = link(db, ana, { occasion: show }, { confidence: 0.85 });
    const dupOld = link(db, anaDup, { occasion: oldShow }, { confidence: 0.7 }); // a merged-in record, older occasion copy
    const dupEvent = link(db, anaDup, { event: pf }, { confidence: 0.6 }); // the Partiful event the occasion stands for
    const elsewhere = link(db, ana, { occasion: other });
    const bos = link(db, bo, { occasion: show });

    // The page shows the one best link per happening.
    expect(personMetAt(db, ana).links.map((l) => l.id).sort()).toEqual([shown, elsewhere].sort());
    const { batchId } = metAtWrong(db, ana, shown, T0);
    const status = (id: string) => db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(id);
    expect([shown, dupOld, dupEvent].map(status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(status(elsewhere)).toBe('active');
    expect(status(bos)).toBe('active'); // someone else's link to the same show is theirs
    expect(personMetAt(db, ana).links.map((l) => l.id)).toEqual([elsewhere]);
    expect(db.prepare('SELECT count(*) FROM change_batches').pluck().get()).toBe(1);

    undoBatch(db, batchId!);
    expect([shown, dupOld, dupEvent].map(status)).toEqual(['active', 'active', 'active']);
  });

  it('only the person’s own links: another person’s or an unknown link is a 404, a withdrawn one changes nothing', () => {
    const { db, ana, bo } = world();
    const show = occasion(db, 'Neon Nights', T0 - 2 * DAY);
    const anas = link(db, ana, { occasion: show });
    const withdrawn = link(db, bo, { occasion: show }, { status: 'withdrawn' });
    expect(() => metAtWrong(db, bo, anas)).toThrow(/not found/);
    expect(() => metAtWrong(db, bo, uuidv7())).toThrow(/not found/);
    expect(metAtWrong(db, bo, withdrawn)).toEqual({ batchId: null });
    expect(db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(anas)).toBe('active');
    expect(db.prepare('SELECT count(*) FROM change_batches').pluck().get()).toBe(0);
  });
});
