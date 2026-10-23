import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { uuidv7 } from '@yb/shared';
import type { OcrLine, OcrResponse } from '@yb/shared/collector/v1';
import { screenshotFile, writeScreenshot } from '../../src/adapters/gphotos/files';
import { disconnectGphotos } from '../../src/adapters/gphotos/jobs';
import type { DB } from '../../src/db/connection';
import { undoRun } from '../../src/journal/undo';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError, OcrRouteMissingError, type ScreenshotOcr } from '../../src/screenshots/ocr';
import { MAX_ATTEMPTS, OCR_BATCH, processPendingScreenshots } from '../../src/screenshots/process';
import { memDb, seedIdentity, seedPerson, T0, tempDir } from '../helpers';
import { CARD_EMAIL, CARD_NAME, CARD_PHONE, contactCard, IG_HANDLE, IG_NAME, igProfile, plainPhoto } from './fixtures';

const OWNER_PHONE = '+12125550100';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A stand-in OCR client: each image's text names its scenario; an Error answer is thrown. */
class StubOcr implements ScreenshotOcr {
  calls = 0;
  /** Runs while a call is in flight (the owner acting meanwhile). */
  during?: () => Promise<unknown> | void;
  constructor(private readonly answers: Record<string, OcrLine[] | Error>) {}
  async ocr(image: Buffer): Promise<OcrResponse> {
    this.calls++;
    await this.during?.();
    const a = this.answers[image.toString('utf8')];
    if (a === undefined) throw new Error('no such scenario');
    if (a instanceof Error) throw a;
    return { api: 'v1', generated_at: T0, width: 1170, height: 2532, lines: a };
  }
  async close(): Promise<void> {}
}

function setup() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example' });
  seedIdentity(db, me, 'phone', OWNER_PHONE);
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { db, dir: t.dir };
}

let seq = 0;
/** A downloaded screenshot: the row plus its file holding the scenario name. */
function shot(db: DB, dir: string, scenario: string, o: { takenAt?: number | null; attempts?: number; file?: boolean } = {}): string {
  const id = uuidv7(T0 + seq++);
  if (o.file !== false) writeScreenshot(dir, id, Buffer.from(scenario));
  db.prepare(
    `INSERT INTO contact_screenshots (id, source, source_ref, session_id, taken_at, status, attempts, created_at, updated_at)
     VALUES (?, 'gphotos', ?, 'sess-1', ?, 'downloaded', ?, ?, ?)`,
  ).run(id, `media-${seq}`, o.takenAt === undefined ? T0 - 3_600_000 : o.takenAt, o.attempts ?? 0, T0 + seq, T0 + seq);
  return id;
}

const row = (db: DB, id: string) =>
  db.prepare('SELECT status, kind, person_id, found, attempts, error_class FROM contact_screenshots WHERE id = ?').get(id) as {
    status: string;
    kind: string | null;
    person_id: string | null;
    found: string;
    attempts: number;
    error_class: string | null;
  };

describe('processPendingScreenshots', () => {
  it('reads, resolves and records each screenshot, then deletes its file', async () => {
    const { db, dir } = setup();
    const card = shot(db, dir, 'card');
    const ig = shot(db, dir, 'ig');
    const plain = shot(db, dir, 'plain');
    const blank = shot(db, dir, 'blank');
    const ocr = new StubOcr({ card: contactCard(), ig: igProfile(), plain: plainPhoto(), blank: [{ text: '  ', confidence: 0.4, x: 0, y: 0, w: 0.1, h: 0.1 }] });
    const st = await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 });
    expect(st).toMatchObject({ ocr: 4, linked: 2, created: 2, no_contact: 1, no_text: 1, failed: 0, retry: 0, route_missing: 0, unavailable: 0 });
    expect(row(db, card)).toMatchObject({ status: 'linked', kind: 'contact_card', attempts: 1, error_class: null });
    expect(row(db, ig)).toMatchObject({ status: 'linked', kind: 'instagram_profile' });
    expect(row(db, plain)).toMatchObject({ status: 'no_contact', kind: 'other', person_id: null });
    expect(row(db, blank)).toMatchObject({ status: 'no_text', kind: null, person_id: null });
    for (const id of [card, ig, plain, blank]) expect(fs.existsSync(screenshotFile(dir, id))).toBe(false);
    // The new people carry the screenshot's taken time as their identities' first sighting.
    const p = row(db, card).person_id!;
    expect(db.prepare(`SELECT first_seen_at FROM identities WHERE person_id = ? AND kind = 'phone'`).pluck().get(p)).toBe(T0 - 3_600_000);
  });

  it('stores counts only: no phone, email, handle, name or OCR text in any row', async () => {
    const { db, dir } = setup();
    shot(db, dir, 'card');
    shot(db, dir, 'ig');
    await processPendingScreenshots(db, { dataDir: dir, ocr: new StubOcr({ card: contactCard(), ig: igProfile() }), now: T0 });
    const dump = JSON.stringify(db.prepare('SELECT * FROM contact_screenshots').all());
    for (const pii of [CARD_PHONE, '555-0142', CARD_EMAIL, CARD_NAME, IG_HANDLE, IG_NAME, 'Coffee']) expect(dump).not.toContain(pii);
    const found = (db.prepare(`SELECT found FROM contact_screenshots WHERE kind = 'contact_card'`).pluck().get() as string) ?? '{}';
    expect(JSON.parse(found)).toEqual({ phones: 1, emails: 1, handles: 0, name: true, via: 'phone' });
  });

  it("all of a pass's people share one import run; undoing it suppresses them", async () => {
    const { db, dir } = setup();
    const a = shot(db, dir, 'card');
    const b = shot(db, dir, 'ig');
    await processPendingScreenshots(db, { dataDir: dir, ocr: new StubOcr({ card: contactCard(), ig: igProfile() }), now: T0, jobRunId: null });
    const runs = db.prepare(`SELECT id, kind, status FROM runs`).all() as { id: string; kind: string; status: string }[];
    expect(runs.map((r) => [r.kind, r.status])).toEqual([['import', 'ok']]);
    undoRun(db, runs[0]!.id, { now: T0 + 1000 });
    for (const id of [a, b]) {
      expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(row(db, id).person_id)).toBe('suppressed');
    }
  });

  it('a pass with nothing new to write leaves no run behind', async () => {
    const { db, dir } = setup();
    shot(db, dir, 'plain');
    await processPendingScreenshots(db, { dataDir: dir, ocr: new StubOcr({ plain: plainPhoto() }), now: T0 });
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(0);
  });

  it('a missing file fails the row without calling the collector', async () => {
    const { db, dir } = setup();
    const id = shot(db, dir, 'card', { file: false });
    const ocr = new StubOcr({ card: contactCard() });
    const st = await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 });
    expect(st.failed).toBe(1);
    expect(ocr.calls).toBe(0);
    expect(row(db, id)).toMatchObject({ status: 'failed', error_class: 'file_missing' });
  });

  it('no OCR route, or no collector, stops the step and leaves every file waiting', async () => {
    for (const [err, flag] of [
      [new OcrRouteMissingError(), 'route_missing'],
      [new CollectorUnavailableError('unreachable', 'down'), 'unavailable'],
      [new CollectorHttpError(401, 'unauthorized'), 'unavailable'],
    ] as const) {
      const { db, dir } = setup();
      const ids = [shot(db, dir, 'x'), shot(db, dir, 'y')];
      const ocr = new StubOcr({ x: err, y: contactCard() });
      const st = await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 });
      expect(st[flag]).toBe(1);
      expect(ocr.calls).toBe(1);
      for (const id of ids) {
        expect(row(db, id)).toMatchObject({ status: 'downloaded', attempts: 0 });
        expect(fs.existsSync(screenshotFile(dir, id))).toBe(true);
      }
    }
  });

  it('413 and image_unreadable are final; other collector errors retry until MAX_ATTEMPTS', async () => {
    const { db, dir } = setup();
    const big = shot(db, dir, 'big');
    const bad = shot(db, dir, 'bad');
    const flaky = shot(db, dir, 'flaky');
    const broken = shot(db, dir, 'broken', { attempts: MAX_ATTEMPTS - 1 });
    const ocr = new StubOcr({
      big: new CollectorHttpError(413, 'payload_too_large'),
      bad: new CollectorHttpError(422, 'image_unreadable'),
      flaky: new CollectorHttpError(503, 'unavailable'),
      broken: new CollectorContractError('vision_ocr', 1, ['lines']),
    });
    const st = await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 });
    expect(st).toMatchObject({ failed: 3, retry: 1 });
    expect(row(db, big)).toMatchObject({ status: 'failed', error_class: 'payload_too_large' });
    expect(row(db, bad)).toMatchObject({ status: 'failed', error_class: 'image_unreadable' });
    expect(row(db, flaky)).toMatchObject({ status: 'downloaded', attempts: 1, error_class: 'http_503' });
    expect(fs.existsSync(screenshotFile(dir, flaky))).toBe(true);
    expect(row(db, broken)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error_class: 'contract' });
    for (const id of [big, bad, broken]) expect(fs.existsSync(screenshotFile(dir, id))).toBe(false);
  });

  it(`reads at most ${OCR_BATCH} per pass, oldest first, and stops when aborted`, async () => {
    const { db, dir } = setup();
    const ids = Array.from({ length: OCR_BATCH + 2 }, () => shot(db, dir, 'plain'));
    const ocr = new StubOcr({ plain: plainPhoto() });
    expect((await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 })).ocr).toBe(OCR_BATCH);
    expect(ids.slice(-2).map((id) => row(db, id).status)).toEqual(['downloaded', 'downloaded']);
    const ac = new AbortController();
    ac.abort();
    expect((await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0, signal: ac.signal })).ocr).toBe(0);
    expect((await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0, limit: 1 })).ocr).toBe(1);
  });

  it('a disconnect while a screenshot is being read: neither it nor the rest of the batch is resolved or relabelled', async () => {
    for (const [deleteData, first] of [
      [false, 'card'],
      [true, 'card'],
      [false, 'flaky'],
    ] as const) {
      const { db, dir } = setup();
      const ids = [shot(db, dir, first), shot(db, dir, 'ig'), shot(db, dir, 'plain')];
      const people = db.prepare('SELECT count(*) FROM people').pluck().get();
      const ocr = new StubOcr({ card: contactCard(), flaky: new CollectorHttpError(503, 'unavailable'), ig: igProfile(), plain: plainPhoto() });
      ocr.during = () => {
        ocr.during = undefined;
        return disconnectGphotos(db, { dataDir: dir, deleteData, now: T0 + 1000 });
      };
      const st = await processPendingScreenshots(db, { dataDir: dir, ocr, now: T0 + 2000 });
      expect(st).toMatchObject({ linked: 0, created: 0, failed: 0, retry: 0, no_contact: 0, fenced: 3 });
      expect(ocr.calls).toBe(1);
      expect(db.prepare('SELECT count(*) FROM people').pluck().get()).toBe(people);
      const rows = db.prepare('SELECT id, status, error_class, attempts, person_id FROM contact_screenshots ORDER BY id').all();
      expect(rows).toEqual(deleteData ? [] : ids.map((id) => ({ id, status: 'expired', error_class: 'disconnected', attempts: 0, person_id: null })));
      for (const id of ids) expect(fs.existsSync(screenshotFile(dir, id))).toBe(false);
    }
  });
});
