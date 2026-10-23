import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../../src/db/canon';
import { mergePeople } from '../../../src/identity/merge';
import { metAtJobs } from '../../../src/intel/metAt/jobs';
import { runMetAt } from '../../../src/intel/metAt/run';
import { activeMetAtLinks, rejectMetAtLinks } from '../../../src/intel/metAt/store';
import { withBatch } from '../../../src/journal/batch';
import { undoBatch, undoRun } from '../../../src/journal/undo';
import { nullLogger } from '../../../src/ops/logger';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { newRun, seedIdentity } from '../../helpers';
import { chat } from '../../pipeline/occasions/world';
import { DAY, HOUR, metWorld, MIN, NOW, on, type MetWorld } from './world';

let w: MetWorld;

interface Row {
  id: string;
  person_id: string;
  occasion_id: string | null;
  event_id: string | null;
  target_key: string;
  signal: string;
  signal_at: number;
  signals: string;
  confidence: number;
  status: string;
  source: string;
  run_id: string | null;
}

const rows = (personId?: string): Row[] =>
  (personId
    ? w.db.prepare('SELECT * FROM person_met_at WHERE person_id = ? ORDER BY created_at, id').all(personId)
    : w.db.prepare('SELECT * FROM person_met_at ORDER BY created_at, id').all()) as Row[];
const one = (personId: string): Row | undefined => rows(personId).find((r) => r.status === 'active');
const run = (now = NOW) => runMetAt(w.db, { now });
const batches = () => w.db.prepare('SELECT count(*) FROM change_batches').pluck().get() as number;

beforeEach(() => {
  w = metWorld();
});

describe('signals', () => {
  it('each signal kind links a new person to the show around it, with its base × gap × weight', async () => {
    const show = w.ticketShow({ title: 'Neon Harbor Live', start: on(-10, 20), performers: ['Neon Harbor'], venue: 'Lumen Hall' });
    const ana = w.stranger('Ana', 'Sample');
    const bo = w.person('Bo', 'Example');
    const cy = w.person('Cy', 'Placeholder');
    const dee = w.stranger('Dee', 'Fictional');
    w.shot(ana, on(-10, 22));
    w.card(bo, { createdAt: on(-10, 21) });
    w.follow(cy, on(-9, 3)); // 3 h after the 4 h default end
    w.igDm(dee, { firstAt: on(-10, 23) });

    const r = await run();
    expect(r.complete).toBe(true);
    expect(r.runId).not.toBeNull();
    expect(r.counts).toMatchObject({ inserted: 4, derived: 4, brought_forward: 2 });
    const o = `o:${show.occasionId}`;
    expect(one(ana)).toMatchObject({ target_key: o, signal: 'contact_screenshot', signal_at: on(-10, 22), confidence: 0.85, source: 'inferred', run_id: r.runId });
    expect(one(bo)).toMatchObject({ target_key: o, signal: 'contact_added', confidence: 0.8 });
    expect(one(cy)).toMatchObject({ target_key: o, signal: 'instagram_follow', confidence: 0.675 });
    expect(one(dee)).toMatchObject({ target_key: o, signal: 'instagram_dm', confidence: 0.65 });
    expect(JSON.parse(one(cy)!.signals)).toEqual([{ s: 'instagram_follow', t: on(-9, 3), c: 0.675 }]);
    // Ana (roster-only, 0.85) is brought forward; Dee (0.65) too; both in the run's met_at batches.
    expect(w.status(ana)).toBe('provisional');
    expect(w.status(dee)).toBe('provisional');
    expect(w.db.prepare(`SELECT DISTINCT kind FROM change_batches WHERE run_id = ?`).pluck().all(r.runId)).toEqual(['met_at']);
    expect(w.db.prepare(`SELECT status, json_extract(summary, '$.inserted') AS n FROM runs WHERE id = ?`).get(r.runId)).toEqual({ status: 'ok', n: 4 });
  });

  it('instagram_follow: only the owner following them, never follower-only; a burst of ≥ 10 within 30 min is dropped', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const fan = w.person('Fan', 'Sample');
    w.follow(fan, on(-10, 21), { direction: 'follower' });
    const burst = Array.from({ length: 10 }, (_, i) => w.person(`Burst${i}`, 'Sample'));
    burst.forEach((p, i) => w.follow(p, on(-10, 21, i * 3)));
    const fine = Array.from({ length: 9 }, (_, i) => w.person(`Calm${i}`, 'Sample'));
    fine.forEach((p, i) => w.follow(p, on(-10, 22, i * 3)));
    const r = await run();
    expect(one(fan)).toBeUndefined();
    for (const p of burst) expect(one(p)).toBeUndefined();
    for (const p of fine) expect(one(p)).toBeDefined();
    expect(r.counts).toMatchObject({ signals_follows_burst: 10, signals_follows: 9 });
  });

  it('instagram_dm: a real first message (DYI-matched, or born while watched) AND the owner writing in its first session', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const ok = w.person('Ok', 'Sample');
    const silent = w.person('Silent', 'Sample');
    const partial = w.person('Partial', 'Sample');
    const old = w.person('Old', 'Sample');
    const late = w.person('Late', 'Sample');
    const dyi = w.person('Dyi', 'Sample');
    const own = w.person('Own', 'Sample');
    const request = w.person('Request', 'Sample');
    const dyiSilent = w.person('Quiet', 'Sample');
    w.igDm(ok, { firstAt: on(-10, 22) });
    w.igDm(silent, { firstAt: on(-10, 22), ownerReplyAfter: null });
    w.igDm(partial, { firstAt: on(-10, 22), complete: false });
    w.igDm(old, { firstAt: on(-10, 22), createdAt: on(-10, 22) + 3 * DAY });
    w.igDm(late, { firstAt: on(-10, 22), ownerReplyAfter: 3 * HOUR }); // a new session
    // DYI history is complete, so neither a partial Beeper history nor a late row matters…
    w.igDm(dyi, { firstAt: on(-10, 22), complete: false, createdAt: on(-10, 22) + 30 * DAY, dyi: true });
    w.igDm(own, { firstAt: on(-10, 22), source: 'instagram_dyi' });
    // …but an export also holds unanswered message requests: the owner never wrote back.
    w.igDm(request, { firstAt: on(-10, 22), ownerReplyAfter: null, source: 'instagram_dyi' });
    w.igDm(dyiSilent, { firstAt: on(-10, 22), ownerReplyAfter: null, complete: false, createdAt: on(-10, 22) + 30 * DAY, dyi: true });
    const r = await run();
    expect(one(ok)?.signal).toBe('instagram_dm');
    expect(one(dyi)?.signal).toBe('instagram_dm');
    expect(one(own)?.signal).toBe('instagram_dm');
    for (const p of [silent, partial, old, late, request, dyiSilent]) expect(one(p)).toBeUndefined();
    expect(r.counts).toMatchObject({ signals_dms: 3, signals_dms_untrusted: 6 });
  });

  it('instagram_dm: the person’s earliest direct chat decides', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const p = w.person('Twice', 'Sample');
    w.igDm(p, { firstAt: on(-10, 22), ownerReplyAfter: null }); // their first chat: unanswered
    w.igDm(p, { firstAt: on(-10, 23) }); // a second, answered chat an hour later
    expect((await run()).counts.signals_dms_untrusted).toBe(1);
    expect(one(p)).toBeUndefined();
  });

  it('contact_added: bulks (≥ 5 creation times within 2 min), the first dump, unnamed and removed cards never count', async () => {
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    // The first address-book pass, long before the show: cards without a creation date are the dump.
    const dumped = w.person('Dumped', 'Sample');
    w.card(dumped, { createdAt: null, firstSeenAt: on(-40, 3) });
    const laterSeen = w.person('Seen', 'Sample');
    w.card(laterSeen, { createdAt: null, firstSeenAt: on(-10, 23) });
    // Five cards created within two minutes at the show (an import): none count.
    const bulk = Array.from({ length: 5 }, (_, i) => w.person(`Bulk${i}`, 'Sample'));
    bulk.forEach((p, i) => w.card(p, { createdAt: on(-10, 21, 0) + i * 20_000 }));
    // Four within two minutes: fine.
    const four = Array.from({ length: 4 }, (_, i) => w.person(`Four${i}`, 'Sample'));
    four.forEach((p, i) => w.card(p, { createdAt: on(-10, 22, 0) + i * 20_000 }));
    // A device setup: 30 cards stamped seconds apart during a festival. None count.
    const fest = w.ticketShow({ title: 'Meadow Days', start: on(-30, 12), end: null, category: 'festival' });
    const setup = Array.from({ length: 30 }, (_, i) => w.person(`Setup${i}`, 'Sample'));
    setup.forEach((p, i) => w.card(p, { createdAt: on(-30, 15) + i * 2_000 }));
    // Fifteen added one by one over that festival day: a social day, not a bulk. All count.
    const met = Array.from({ length: 15 }, (_, i) => w.person(`Met${i}`, 'Sample'));
    met.forEach((p, i) => w.card(p, { createdAt: on(-30, 12, 10) + i * 35 * MIN }));
    const unnamed = w.person('Unnamed', 'Sample');
    w.card(unnamed, { createdAt: on(-10, 23, 30), given: null, family: null });
    const removed = w.person('Removed', 'Sample');
    w.card(removed, { createdAt: on(-10, 23, 40), removed: true });
    const r = await run();
    expect(one(dumped)).toBeUndefined();
    expect(one(laterSeen)).toMatchObject({ target_key: `o:${show.occasionId}`, signal: 'contact_added', signal_at: on(-10, 23) });
    for (const p of [...bulk, ...setup, unnamed, removed]) expect(one(p)).toBeUndefined();
    for (const p of four) expect(one(p)?.confidence).toBe(0.8);
    for (const p of met) expect(one(p)).toMatchObject({ target_key: `o:${fest.occasionId}`, confidence: 0.8 });
    expect(r.counts).toMatchObject({ signals_cards_bulk: 35, signals_cards_first_dump: 1, signals_cards_unnamed: 1 });
  });

  it('a card with only a given name counts; a card with neither name does not', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const given = w.person('Given', 'Only');
    w.card(given, { createdAt: on(-10, 21), family: null });
    const family = w.person('Family', 'Only');
    w.card(family, { createdAt: on(-10, 21, 30), given: '  ', family: 'Only' });
    const blank = w.person('Blank', 'Card');
    w.card(blank, { createdAt: on(-10, 22), given: ' ', family: '' });
    await run();
    expect(one(given)?.signal).toBe('contact_added');
    expect(one(family)?.signal).toBe('contact_added');
    expect(one(blank)).toBeUndefined();
  });

  it('only people: business, service and suppressed records never get links', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const shop = w.person('Corner', 'Shop', { extra: { kind: 'business' } });
    const svc = w.person('Ticket', 'Desk', { extra: { status: 'service' } });
    const gone = w.person('Gone', 'Sample', { extra: { status: 'suppressed' } });
    const fine = w.person('Fine', 'Sample');
    for (const p of [shop, svc, gone, fine]) w.follow(p, on(-10, 21));
    const r = await run();
    for (const p of [shop, svc, gone]) expect(one(p)).toBeUndefined();
    expect(one(fine)).toBeDefined();
    expect(r.counts.inserted).toBe(1);
  });

  it('contact_screenshot: an IG profile with ≥ 5k followers is not contact info; only linked rows count', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const star = w.person('Star', 'Sample');
    const small = w.person('Small', 'Sample');
    const pending = w.person('Pending', 'Sample');
    w.shot(star, on(-10, 21), { followers: 12_000 });
    w.shot(small, on(-10, 21), { followers: 800 });
    w.shot(pending, on(-10, 21), { status: 'ambiguous' });
    const r = await run();
    expect(one(star)).toBeUndefined();
    expect(one(small)?.signal).toBe('contact_screenshot');
    expect(one(pending)).toBeUndefined();
    expect(r.counts.signals_screenshots_followers).toBe(1);
  });

  it('several signals on one happening combine (noisy-OR, capped at 0.95); the strongest names the link', async () => {
    const party = w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    const fay = w.person('Fay', 'Sample');
    w.follow(fay, on(-10, 21));
    w.card(fay, { createdAt: on(-10, 22) });
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-5, 20) });
    const gus = w.person('Gus', 'Sample');
    w.follow(gus, on(-5, 21));
    w.shot(gus, on(-5, 22));
    await run();
    // Social occasion: 0.75·0.85 and 0.8·0.85 → 1 − 0.3625·0.32.
    expect(one(fay)).toMatchObject({ target_key: `o:${party}`, signal: 'contact_added', confidence: 0.884 });
    expect(JSON.parse(one(fay)!.signals)).toEqual([
      { s: 'contact_added', t: on(-10, 22), c: 0.68 },
      { s: 'instagram_follow', t: on(-10, 21), c: 0.638 },
    ]);
    expect(one(gus)).toMatchObject({ target_key: `o:${show.occasionId}`, signal: 'contact_screenshot', confidence: 0.95 });
  });
});

describe('events', () => {
  it('Partiful: going counts at full weight, a maybe RSVP is no event, an occasion linked to a maybe weighs 0.85', async () => {
    const going = w.partiful({ title: 'Garden dinner', start: on(-12, 19), myRsvp: 'GOING' });
    w.partiful({ title: 'Loft hang', start: on(-8, 19), myRsvp: 'MAYBE' });
    const maybeEv = w.partiful({ title: 'Studio night', start: on(-4, 19), myRsvp: 'MAYBE' });
    const linked = w.social({ title: 'Studio night', start: on(-4, 19), end: on(-4, 22), eventId: maybeEv });
    const a = w.person('Aya', 'Sample');
    const b = w.person('Ben', 'Sample');
    const c = w.person('Cal', 'Sample');
    w.follow(a, on(-12, 20));
    w.follow(b, on(-8, 20));
    w.follow(c, on(-4, 20));
    await run();
    expect(one(a)).toMatchObject({ target_key: `e:${going}`, event_id: going, occasion_id: null, confidence: 0.75 });
    expect(one(b)).toBeUndefined();
    expect(one(c)).toMatchObject({ target_key: `o:${linked}`, confidence: 0.638 });
  });

  it('a ticket weighs 1.0 only while held; a sold ticket leaves a plain social occasion (0.85)', async () => {
    const held = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const sold = w.ticketShow({ title: 'Paper Lanterns', start: on(-5, 20) });
    w.db.prepare(`UPDATE ticket_events SET status = 'sold', held = 0 WHERE id = ?`).run(sold.ticketId);
    const a = w.person('Aya', 'Sample');
    const b = w.person('Ben', 'Sample');
    w.follow(a, on(-10, 21));
    w.follow(b, on(-5, 21));
    await run();
    expect(one(a)).toMatchObject({ target_key: `o:${held.occasionId}`, confidence: 0.75 });
    expect(one(b)).toMatchObject({ target_key: `o:${sold.occasionId}`, confidence: 0.638 });
  });

  it('a ticket with no end gets 6 h for a club night, 10 h for a festival, 4 h otherwise', async () => {
    w.ticketShow({ title: 'Deep Room', start: on(-10, 23), end: null, category: 'club' });
    w.ticketShow({ title: 'Quiet Strings', start: on(-5, 19), end: null, category: 'concert' });
    w.ticketShow({ title: 'Meadow Days', start: on(-15, 11), end: null, category: 'festival' });
    const a = w.person('Aya', 'Sample');
    const b = w.person('Ben', 'Sample');
    const c = w.person('Cal', 'Sample');
    w.follow(a, on(-10, 23) + 5 * HOUR);
    w.follow(b, on(-5, 19) + 5 * HOUR);
    w.follow(c, on(-15, 11) + 9 * HOUR + 30 * MIN);
    await run();
    expect(one(a)?.confidence).toBe(0.75);
    expect(one(b)?.confidence).toBe(0.675);
    expect(one(c)?.confidence).toBe(0.75);
  });

  it('window edges: 2 h before the start (× 0.8) and 36 h after the end (× 0.7) count, a millisecond further does not', async () => {
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-20, 20), end: on(-20, 23) });
    const early = w.person('Early', 'Sample');
    const tooEarly = w.person('Tooearly', 'Sample');
    const late = w.person('Late', 'Sample');
    const tooLate = w.person('Toolate', 'Sample');
    w.follow(early, on(-20, 18));
    w.follow(tooEarly, on(-20, 18) - 1);
    w.follow(late, on(-20, 23) + 36 * HOUR);
    w.follow(tooLate, on(-20, 23) + 36 * HOUR + 1);
    await run();
    expect(one(early)).toMatchObject({ target_key: `o:${show.occasionId}`, confidence: 0.6 });
    expect(one(late)).toMatchObject({ target_key: `o:${show.occasionId}`, confidence: 0.525 });
    expect(one(tooEarly)).toBeUndefined();
    expect(one(tooLate)).toBeUndefined();
  });

  it('two different shows that only share a generic title word ("Live") are not one happening', async () => {
    w.ticketShow({ title: 'Neon Harbor Live', start: on(-10, 20), end: on(-9, 0), venue: 'Alpha Hall' });
    const glass = w.ticketShow({ title: 'Glass Tide Live', start: on(-10, 21), end: on(-9, 0), venue: 'Beta Room' });
    const a = w.person('Aya', 'Sample');
    w.shot(a, on(-10, 22));
    await run();
    // Both contain t at 0.85: the shorter wins, and the runner-up elsewhere makes it ambiguous (× 0.6).
    expect(one(a)).toMatchObject({ target_key: `o:${glass.occasionId}`, confidence: 0.51 });
  });

  it('only past events: a signal at an event that has not started yet links nothing', async () => {
    w.ticketShow({ title: 'Glass Tide', start: NOW + 2 * HOUR });
    const a = w.person('Aya', 'Sample');
    w.follow(a, NOW - 30 * MIN);
    await run();
    expect(one(a)).toBeUndefined();
  });

  it('overlapping candidates: the one containing t beats one that ended long before', async () => {
    w.social({ title: 'Brunch club', start: on(-10, 12), end: on(-10, 14), venue: 'Alpha Hall' });
    const evening = w.social({ title: 'Gallery opening', start: on(-11, 20), end: on(-10, 23), venue: 'Beta Room' });
    const later = w.social({ title: 'Night swim', start: on(-9, 19), end: on(-9, 23), venue: 'Gamma Pool' });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-9, 20)); // inside Night swim; Gallery ended 21 h before
    await run();
    expect(one(a)).toMatchObject({ target_key: `o:${later}`, confidence: 0.638 });
    expect(evening).toBeTruthy();
  });

  it('a close runner-up at another venue costs × 0.6; at the same venue it does not', async () => {
    w.ticketShow({ title: 'Early Set', start: on(-10, 18), end: on(-10, 21), venue: 'Alpha Hall' });
    const late = w.ticketShow({ title: 'Late Set', start: on(-10, 22), end: on(-10, 23, 59), venue: 'Beta Room' });
    const a = w.person('Aya', 'Sample');
    const b = w.person('Ben', 'Sample');
    w.shot(a, on(-10, 22, 30)); // inside Late Set (1.0), 1.5 h after Early Set (0.9)
    w.follow(b, on(-10, 22, 30));
    await run();
    expect(one(a)).toMatchObject({ target_key: `o:${late.occasionId}`, confidence: 0.51 });
    expect(one(b)).toBeUndefined(); // 0.75 × 0.6 < 0.5

    const w2 = metWorld();
    w2.ticketShow({ title: 'Early Set', start: on(-10, 18), end: on(-10, 21), venue: 'Alpha Hall' });
    const late2 = w2.ticketShow({ title: 'Late Set', start: on(-10, 22), end: on(-10, 23, 59), venue: 'Alpha Hall' });
    const c = w2.person('Cal', 'Sample');
    w2.shot(c, on(-10, 22, 30));
    await runMetAt(w2.db, { now: NOW });
    expect(w2.db.prepare(`SELECT target_key, confidence FROM person_met_at WHERE person_id = ?`).get(c)).toEqual({ target_key: `o:${late2.occasionId}`, confidence: 0.85 });
  });

  it('overlapping copies of one happening (shared venue / title token) merge: no ambiguity, best member wins', async () => {
    w.social({ title: 'Skyline party', start: on(-10, 21), end: on(-9, 1), venue: 'Skyline Terrace' });
    const ev = w.partiful({ title: 'Skyline rooftop', start: on(-10, 21, 30), end: on(-9, 2), location: 'Skyline Terrace, 1 Sample St' });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 23));
    await run();
    // Partiful going (1.0) beats the social occasion (0.85); merged, so the runner-up never penalizes.
    expect(one(a)).toMatchObject({ target_key: `e:${ev}`, confidence: 0.75 });
  });

  it('a tie goes to the shortest event that contains the signal', async () => {
    w.ticketShow({ title: 'Long fair', start: on(-10, 12), end: on(-9, 2), venue: 'Fairground' });
    const short = w.ticketShow({ title: 'Poetry reading', start: on(-10, 19), end: on(-10, 21), venue: 'Book Nook' });
    const a = w.person('Aya', 'Sample');
    w.shot(a, on(-10, 20));
    await run();
    // Equal scores at two venues: the shorter one, and the tie is ambiguous (0.85 × 0.6).
    expect(one(a)).toMatchObject({ target_key: `o:${short.occasionId}`, confidence: 0.51 });
  });

  it('drops a person who IS the happening: a ticket performer, the venue handle, a name in the title', async () => {
    const show = w.ticketShow({ title: 'Neon Harbor Live', start: on(-10, 20), performers: ['Neon Harbor', 'Marina'], venue: 'Lumen Hall' });
    const bday = w.social({ title: 'Rosa Quill birthday', start: on(-5, 20), end: on(-5, 23) });
    const band = w.person('Someone', 'Sample');
    w.handle(band, 'neonharbor.official');
    w.follow(band, on(-10, 21));
    const venue = w.person('Venue', 'Account');
    w.follow(venue, on(-10, 21), { username: 'lumen.hall' });
    const rosa = w.person('Rosa', 'Quill');
    w.follow(rosa, on(-5, 21));
    const guest = w.person('Nia', 'Sample');
    w.follow(guest, on(-5, 21));
    // A real person whose handle merely contains a performer's first name is not the artist.
    const namesake = w.person('Marina', 'Sample');
    w.follow(namesake, on(-10, 22), { username: 'marina.sample' });
    // The band's account follows from another show too: a ticket performer is never "met".
    w.social({ title: 'Other night', start: on(-3, 20), end: on(-3, 23) });
    const r = await run();
    expect(one(band)).toBeUndefined();
    expect(one(venue)).toBeUndefined();
    expect(one(rosa)).toBeUndefined();
    expect(one(guest)?.target_key).toBe(`o:${bday}`);
    expect(one(namesake)?.target_key).toBe(`o:${show.occasionId}`);
    expect(r.counts).toMatchObject({ skipped_performer: 1 });
    expect(r.counts.skipped_named).toBeGreaterThanOrEqual(2);
  });

  it('a performer on an old ticket does not claim everyone whose handle is that name plus a year (or an x, or "im")', async () => {
    w.ticketShow({ title: 'Deep Night', start: on(-700, 22), performers: ['Dixon', 'Maya', 'Jordan'], category: 'club' });
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20), performers: ['Glass Tide'] });
    const lee = w.stranger('Lee', 'Dixon');
    w.handle(lee, 'dixon1994');
    w.follow(lee, on(-10, 21));
    const maya = w.stranger('Maya', 'Sample');
    w.handle(maya, 'maya.92');
    w.follow(maya, on(-10, 21, 10));
    const jo = w.stranger('Jordan', 'Sample');
    w.handle(jo, 'imjordan');
    w.follow(jo, on(-10, 21, 20));
    // The artist's own account still never gets a link.
    const dj = w.stranger('Someone', 'Sample');
    w.handle(dj, 'dixon.music');
    w.follow(dj, on(-10, 21, 30));
    const r = await run();
    for (const p of [lee, maya, jo]) expect(one(p)?.target_key).toBe(`o:${show.occasionId}`);
    expect(one(dj)).toBeUndefined();
    expect(r.counts).toMatchObject({ skipped_performer: 1, inserted: 3 });
  });
});

describe('known before', () => {
  let show: { occasionId: string; ticketId: string };
  const linkedAfterFollow = async (p: string) => {
    w.follow(p, on(-10, 21));
    await run();
    return one(p);
  };
  beforeEach(() => {
    show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
  });

  it('1:1 messages before the cutoff make them known; messages after it do not', async () => {
    const known = w.person('Known', 'Sample');
    chat(w.db, 'direct', [w.phone(known)]).say(on(-40), w.phone(known), 'hi');
    const fresh = w.person('Fresh', 'Sample');
    chat(w.db, 'direct', [w.phone(fresh)]).say(on(-9), w.phone(fresh), 'great meeting you');
    w.follow(fresh, on(-10, 21));
    expect(await linkedAfterFollow(known)).toBeUndefined();
    expect(one(fresh)?.target_key).toBe(`o:${show.occasionId}`);
  });

  it('interactions count, but group sessions only in groups of ≤ 50', async () => {
    const big = w.person('Big', 'Group');
    const small = w.person('Small', 'Group');
    const call = w.person('Call', 'Sample');
    const bigChat = chat(w.db, 'group', Array.from({ length: 60 }, (_, i) => seedIdentity(w.db, w.person(`M${i}`, 'Sample'), 'email', `m${i}@example.com`)));
    const smallChat = chat(w.db, 'group', Array.from({ length: 30 }, (_, i) => seedIdentity(w.db, w.person(`S${i}`, 'Sample'), 'email', `s${i}@example.com`)));
    const ins = w.db.prepare(
      `INSERT INTO interactions (id, person_id, kind, conversation_id, started_at, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'derived', ?, ?)`,
    );
    ins.run(uuidv7(), big, 'group_session', bigChat.id, on(-30), NOW, NOW);
    ins.run(uuidv7(), small, 'group_session', smallChat.id, on(-30), NOW, NOW);
    ins.run(uuidv7(), call, 'call', null, on(-30), NOW, NOW);
    for (const p of [big, small, call]) w.follow(p, on(-10, 21));
    await run();
    expect(one(big)).toBeDefined();
    expect(one(small)).toBeUndefined();
    expect(one(call)).toBeUndefined();
  });

  it('counted attendance at an earlier event of ≤ 50 people; a crowd of > 50 does not count', async () => {
    const met = w.person('Met', 'Before');
    const crowd = w.person('Crowd', 'Sample');
    const dinner = w.social({ title: 'Small dinner', start: on(-30, 19), end: on(-30, 22) });
    w.attendee(dinner, met, { status: 'going', confidence: 0.9 });
    const fest = w.social({ title: 'Big fest', start: on(-25, 12), end: on(-25, 23) });
    w.attendee(fest, crowd, { status: 'going', confidence: 0.9 });
    for (let i = 0; i < 51; i++) w.attendee(fest, w.person(`Fest${i}`, 'Sample'), { status: 'going', confidence: 0.9 });
    for (const p of [met, crowd]) w.follow(p, on(-10, 21));
    await run();
    expect(one(met)).toBeUndefined();
    expect(one(crowd)).toBeDefined();
  });

  it('a legacy record is always known', async () => {
    const legacy = w.person('Legacy', 'Sample', { extra: { origin: 'legacy' } });
    expect(await linkedAfterFollow(legacy)).toBeUndefined();
  });

  it('an earlier signal (a follow weeks before) makes a later contact card at the show not a meeting', async () => {
    const p = w.person('Early', 'Follow');
    w.follow(p, on(-30, 12));
    w.card(p, { createdAt: on(-10, 21) });
    // Any card before the cutoff, trusted or not (here: part of a bulk import).
    const q = w.person('Bulk', 'Card');
    w.card(q, { createdAt: null, firstSeenAt: on(-60) });
    w.follow(q, on(-10, 21));
    await run();
    expect(one(p)).toBeUndefined();
    expect(one(q)).toBeUndefined();
  });

  it('a small group chat (≤ 12) predating the cutoff; a big one does not count', async () => {
    const pal = w.person('Pal', 'Sample');
    chat(w.db, 'group', [w.phone(pal), w.phone(w.person('X', 'Sample'))]);
    const lurker = w.person('Lurker', 'Sample');
    chat(w.db, 'group', [w.phone(lurker), ...Array.from({ length: 20 }, (_, i) => w.phone(w.person(`G${i}`, 'Sample')))]);
    for (const p of [pal, lurker]) w.follow(p, on(-10, 21));
    await run();
    expect(one(pal)).toBeUndefined();
    expect(one(lurker)).toBeDefined();
  });

  it('an open possible-duplicate partner with history before the cutoff (the guestCheck "maybe")', async () => {
    const twin = w.stranger('Twin', 'Sample');
    const other = w.person('Twin', 'Sample');
    chat(w.db, 'direct', [w.phone(other)]).say(on(-50), w.phone(other), 'hey');
    const [a, b] = twin < other ? [twin, other] : [other, twin];
    w.db.prepare(`INSERT INTO match_candidates (a_id, b_id, score_bits, p, status, created_at, updated_at) VALUES (?, ?, 3, 0.7, 'possible_duplicate', ?, ?)`).run(a, b, NOW, NOW);
    expect(await linkedAfterFollow(twin)).toBeUndefined();
  });

  it('a ticket transfer counterparty from before the show', async () => {
    const buddy = w.person('Buddy', 'Sample');
    w.db.prepare(
      `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, triage, parse_status, created_at, updated_at) VALUES ('m1', 't1', ?, 'candidate', 'parsed', ?, ?)`,
    ).run(on(-20), NOW, NOW);
    w.db.prepare(
      `INSERT INTO ticket_parties (gmail_id, direction, name, person_id, ticket_event_id, created_at, updated_at) VALUES ('m1', 'sent_to', 'Buddy Sample', ?, ?, ?, ?)`,
    ).run(buddy, show.ticketId, NOW, NOW);
    expect(await linkedAfterFollow(buddy)).toBeUndefined();
  });
});

describe('writes', () => {
  it('re-running over unchanged data writes nothing (no batch, no run)', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const a = w.stranger('Aya', 'Sample');
    w.follow(a, on(-10, 21));
    const first = await run();
    expect(first.counts.inserted).toBe(1);
    const n = batches();
    const runs = w.db.prepare('SELECT count(*) FROM runs').pluck().get();
    const again = await run(NOW + DAY);
    expect(again.runId).toBeNull();
    expect(again.counts).toMatchObject({ inserted: 0, updated: 0, withdrawn: 0, batches: 0, derived: 1 });
    expect(batches()).toBe(n);
    expect(w.db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(runs);
  });

  it('a rejected link is never re-created, also through the occasion that later covers the Partiful event', async () => {
    const ev = w.partiful({ title: 'Garden dinner', start: on(-10, 19) });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 20));
    await run();
    const link = one(a)!;
    expect(link.target_key).toBe(`e:${ev}`);
    expect(rejectMetAtLinks(w.db, [link.id, link.id, 'missing'], { runId: newRun(w.db, 'user'), actor: 'user', now: NOW })).toBe(1);
    expect(rejectMetAtLinks(w.db, [link.id], { runId: newRun(w.db, 'user'), actor: 'user', now: NOW })).toBe(0);
    await run(NOW + DAY);
    expect(rows(a).map((r) => r.status)).toEqual(['rejected']);
    // The occasions build now covers the Partiful event: same happening, still rejected.
    w.social({ title: 'Garden dinner', start: on(-10, 19), end: on(-10, 22), eventId: ev });
    const r = await run(NOW + 2 * DAY);
    expect(rows(a).map((x) => x.status)).toEqual(['rejected']);
    expect(r.counts.skipped_rejected).toBe(1);
  });

  it('a new signal on the same happening updates the row in place', async () => {
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 21));
    const first = await run();
    const before = one(a)!;
    expect(before).toMatchObject({ confidence: 0.75, signal: 'instagram_follow', run_id: first.runId });
    w.shot(a, on(-10, 22));
    const second = await run(NOW + DAY);
    expect(second.counts).toMatchObject({ updated: 1, inserted: 0, withdrawn: 0 });
    expect(rows(a)).toHaveLength(1);
    expect(one(a)).toMatchObject({ id: before.id, target_key: `o:${show.occasionId}`, confidence: 0.95, signal: 'contact_screenshot', run_id: second.runId });
  });

  it('being on the guest list of the same event is not "known before" it', async () => {
    const ev = w.partiful({ title: 'Garden dinner', start: on(-10, 19) });
    const a = w.stranger('Aya', 'Sample');
    w.guest(ev, a, 'going');
    w.follow(a, on(-10, 20));
    await run();
    expect(one(a)?.target_key).toBe(`e:${ev}`);
  });

  it('a target change withdraws the old row and inserts the new one', async () => {
    const early = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20), venue: 'Alpha Hall' });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-9, 13)); // 13 h after the end: 0.8
    await run();
    expect(one(a)).toMatchObject({ target_key: `o:${early.occasionId}`, confidence: 0.6 });
    const brunch = w.ticketShow({ title: 'Brunch Beats', start: on(-9, 11), end: on(-9, 15), venue: 'Beta Room' });
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ inserted: 1, withdrawn: 1 });
    expect(rows(a).map((x) => [x.target_key, x.status])).toEqual([
      [`o:${early.occasionId}`, 'withdrawn'],
      [`o:${brunch.occasionId}`, 'active'],
    ]);
  });

  it('a merged occasion keeps its link: retargeted in place to the survivor', async () => {
    const x = w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 21));
    await run();
    const before = one(a)!;
    const y = w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    w.db.prepare('UPDATE occasions SET merged_into_id = ? WHERE id = ?').run(y, x);
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ retargeted: 1, withdrawn: 0, inserted: 0 });
    expect(rows(a)).toHaveLength(1);
    expect(one(a)).toMatchObject({ id: before.id, occasion_id: y, target_key: `o:${y}` });
  });

  it('retargeting prefers the survivor of the link’s own occasion over another member of the happening', async () => {
    const x = w.social({ title: 'Skyline party', start: on(-10, 21), end: on(-9, 1), venue: 'Skyline Terrace' });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 23));
    await run();
    const before = one(a)!;
    expect(before.target_key).toBe(`o:${x}`);
    // Later: the occasion is merged, and an overlapping Partiful event at the same venue joins the happening.
    const y = w.social({ title: 'Skyline party', start: on(-10, 21), end: on(-9, 1), venue: 'Skyline Terrace' });
    w.db.prepare('UPDATE occasions SET merged_into_id = ? WHERE id = ?').run(y, x);
    w.partiful({ title: 'Skyline rooftop', start: on(-10, 21, 30), end: on(-9, 2), location: 'Skyline Terrace, 1 Sample St' });
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ retargeted: 1, inserted: 0, withdrawn: 0 });
    expect(rows(a)).toHaveLength(1);
    // Scored by the best member (Partiful going, 1.0), kept on its own occasion's survivor.
    expect(one(a)).toMatchObject({ id: before.id, target_key: `o:${y}`, confidence: 0.75 });
  });

  it('withdrawn when a merge makes the person known; re-activated in place when derived again', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const gil = w.stranger('Gil', 'Sample');
    w.follow(gil, on(-10, 21));
    await run();
    expect(one(gil)).toBeDefined();
    const hal = w.person('Hal', 'Sample');
    chat(w.db, 'direct', [w.phone(hal)]).say(on(-60), w.phone(hal), 'hi');
    w.merge(gil, hal);
    const r = await run(NOW + DAY);
    expect(r.counts.withdrawn).toBe(1);
    expect(rows(gil).map((x) => x.status)).toEqual(['withdrawn']);
    expect(activeMetAtLinks(w.db)).toEqual([]);
    // The merge is undone: the same row comes back (active ↔ withdrawn in place).
    w.db.prepare(`UPDATE people SET merged_into_id = NULL, status = 'provisional' WHERE id = ?`).run(gil);
    rebuildPersonCanon(w.db);
    const back = await run(NOW + 2 * DAY);
    expect(back.counts.reactivated).toBe(1);
    expect(rows(gil).map((x) => x.status)).toEqual(['active']);
  });

  it('hidden people and the owner (or records merged into him) never get links; hiding withdraws one', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const hidden = w.person('Hidden', 'Sample', { extra: { is_hidden: 1 } });
    w.follow(hidden, on(-10, 21));
    const alias = w.person('Owner', 'Alias');
    w.follow(alias, on(-10, 21));
    w.merge(alias, w.me);
    const later = w.person('Later', 'Hidden');
    w.follow(later, on(-10, 21));
    await run();
    expect(one(hidden)).toBeUndefined();
    expect(one(alias)).toBeUndefined();
    expect(one(later)).toBeDefined();
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(later);
    await run(NOW + DAY);
    expect(rows(later).map((x) => x.status)).toEqual(['withdrawn']);
  });

  it('roster-only people are brought forward at ≥ 0.6 only, and go back when the link is withdrawn', async () => {
    w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    const strong = w.stranger('Strong', 'Sample');
    const weak = w.stranger('Weak', 'Sample');
    const talker = w.stranger('Talker', 'Sample');
    w.follow(strong, on(-10, 21)); // 0.6375
    w.igDm(weak, { firstAt: on(-10, 21) }); // 0.65 × 0.85 = 0.5525
    w.follow(talker, on(-10, 21));
    const r = await run();
    expect(r.counts.brought_forward).toBe(2);
    expect(w.status(strong)).toBe('provisional');
    expect(one(weak)?.confidence).toBe(0.553);
    expect(w.status(weak)).toBe('roster_only');
    // The follows disappear (a corrected export); the talker has since had a real conversation.
    w.db.prepare('DELETE FROM instagram_follows').run();
    w.interaction(talker, 'dm_session', on(-1));
    const r2 = await run(NOW + DAY);
    expect(r2.counts).toMatchObject({ withdrawn: 2, demoted: 1 });
    expect(w.status(strong)).toBe('roster_only');
    expect(w.status(talker)).toBe('provisional');
  });

  it('a promoted person the owner has since done something about stays; "Wrong" alone sends one back', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const edited = w.stranger('Edited', 'Sample');
    const wronged = w.stranger('Wronged', 'Sample');
    w.follow(edited, on(-10, 21));
    w.follow(wronged, on(-10, 21, 30));
    expect((await run()).counts.brought_forward).toBe(2);
    // The owner renames one of them on the person page, then says "Wrong" about both links.
    withBatch(
      w.db,
      { runId: newRun(w.db, 'user'), kind: 'user_edit', title: 'Edited a person', subjectPersonId: edited, actor: 'user' },
      (t) => t.update('people', { id: edited }, { nickname: 'Ed' }),
      { now: NOW + MIN },
    );
    rejectMetAtLinks(w.db, [one(edited)!.id, one(wronged)!.id], { runId: newRun(w.db, 'user'), actor: 'user', now: NOW + 2 * MIN });
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ demoted: 1, withdrawn: 0, inserted: 0 });
    expect(w.status(edited)).toBe('provisional');
    expect(w.status(wronged)).toBe('roster_only');
  });

  it('a promoted person stays while something besides met-at would show them: a screenshot, a card, a shown record merged in', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const shot = w.stranger('Shot', 'Sample');
    const carded = w.stranger('Card', 'Sample');
    const absorber = w.stranger('Absorb', 'Sample');
    const twin = w.stranger('Twin', 'Sample');
    for (const p of [shot, carded, absorber, twin]) w.follow(p, on(-10, 21));
    expect((await run()).counts.brought_forward).toBe(4);
    // After the promotion the owner saves Shot's contact in a screenshot (resolve has nothing to bring forward and
    // writes no batch), then says "Wrong" about the link.
    w.shot(shot, on(-10, 22));
    rejectMetAtLinks(w.db, [one(shot)!.id], { runId: newRun(w.db, 'user'), actor: 'user', now: NOW + MIN });
    // The matcher folds a shown record holding a year-old Contacts card into Card (now known before the show)…
    const contact = w.person('Card', 'Sample');
    w.card(contact, { createdAt: on(-400, 12), firstSeenAt: on(-3) });
    mergePeople(w.db, { survivorId: carded, mergedId: contact, method: 'probabilistic', actor: 'agent', runId: newRun(w.db), now: NOW + MIN });
    // …and a shown record without one into Absorb (known: a chat long before).
    const known = w.person('Absorb', 'Sample');
    chat(w.db, 'direct', [w.phone(known)]).say(on(-60), w.phone(known), 'hi');
    mergePeople(w.db, { survivorId: absorber, mergedId: known, method: 'probabilistic', actor: 'agent', runId: newRun(w.db), now: NOW + MIN });
    // A roster-only duplicate is no reason to show Twin: Twin's follow disappears and Twin goes back.
    const dup = w.stranger('Twin', 'Sample');
    mergePeople(w.db, { survivorId: twin, mergedId: dup, method: 'probabilistic', actor: 'agent', runId: newRun(w.db), now: NOW + MIN });
    w.db.prepare('DELETE FROM instagram_follows WHERE identity_id IN (SELECT id FROM identities WHERE person_id = ?)').run(twin);
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ withdrawn: 3, demoted: 1 });
    for (const p of [shot, carded, absorber]) expect(w.status(p)).toBe('provisional');
    expect(w.status(twin)).toBe('roster_only');
  });

  it('undoing a withdrawal holds the link: the next run does not withdraw it again', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const a = w.stranger('Aya', 'Sample');
    w.follow(a, on(-10, 21));
    await run();
    // An open possible-duplicate partner with history long before makes Aya known: withdrawn, and back on the roster.
    const b = w.person('Aya', 'Sample');
    w.interaction(b, 'dm_session', on(-90));
    const [x, y] = a < b ? [a, b] : [b, a];
    w.db.prepare(`INSERT INTO match_candidates (a_id, b_id, score_bits, p, status, created_at, updated_at) VALUES (?, ?, 3, 0.7, 'possible_duplicate', ?, ?)`).run(x, y, NOW, NOW);
    const r2 = await run(NOW + DAY);
    expect(r2.counts).toMatchObject({ withdrawn: 1, demoted: 1 });
    undoRun(w.db, r2.runId!, { now: NOW + DAY + MIN });
    expect(rows(a).map((r) => r.status)).toEqual(['active']);
    expect(w.status(a)).toBe('provisional');
    const r3 = await run(NOW + 2 * DAY);
    expect(r3.runId).toBeNull();
    expect(r3.counts).toMatchObject({ withdrawn: 0, demoted: 0, batches: 0 });
    expect(rows(a).map((r) => r.status)).toEqual(['active']);
    expect(w.status(a)).toBe('provisional');
  });

  it('undoing a run that strengthened a link and brought its person forward holds both: no redo the next night', async () => {
    w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    const p = w.stranger('Weak', 'Sample');
    w.igDm(p, { firstAt: on(-10, 21) });
    await run();
    expect(one(p)?.confidence).toBe(0.553);
    expect(w.status(p)).toBe('roster_only');
    w.follow(p, on(-10, 21, 30));
    const r2 = await run(NOW + DAY);
    expect(r2.counts).toMatchObject({ updated: 1, brought_forward: 1 });
    undoRun(w.db, r2.runId!, { now: NOW + DAY + MIN });
    expect(one(p)?.confidence).toBe(0.553);
    expect(w.status(p)).toBe('roster_only');
    const r3 = await run(NOW + 2 * DAY);
    expect(r3.runId).toBeNull();
    expect(r3.counts).toMatchObject({ updated: 0, brought_forward: 0, batches: 0 });
    expect(one(p)?.confidence).toBe(0.553);
    expect(w.status(p)).toBe('roster_only');
  });

  it('an undo that sent someone back to the roster holds: an unchanged link does not bring them forward again', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const p = w.stranger('Pia', 'Sample');
    w.follow(p, on(-10, 21));
    // Something else showed Pia first (a screenshot's resolve), so the run only links her.
    const { batchId } = withBatch(
      w.db,
      { runId: newRun(w.db), kind: 'person_update', title: 'Showing a person', subjectPersonId: p, actor: 'agent' },
      (t) => t.update('people', { id: p }, { status: 'provisional' }),
      { now: NOW },
    );
    expect((await run()).counts).toMatchObject({ inserted: 1, brought_forward: 0 });
    // The owner undoes that: Pia goes back to the roster, and stays there.
    undoBatch(w.db, batchId, { now: NOW + MIN });
    expect(w.status(p)).toBe('roster_only');
    const r = await run(NOW + DAY);
    expect(r.runId).toBeNull();
    expect(r.counts).toMatchObject({ brought_forward: 0, batches: 0 });
    expect(w.status(p)).toBe('roster_only');
    expect(one(p)).toBeDefined();
  });

  it('undoing the run rejects its links (never re-created) and restores the people it brought forward', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const a = w.stranger('Aya', 'Sample');
    const b = w.person('Ben', 'Sample');
    w.follow(a, on(-10, 21));
    w.shot(b, on(-10, 22));
    const r = await run();
    expect(w.status(a)).toBe('provisional');
    const res = undoRun(w.db, r.runId!, { now: NOW + MIN });
    expect(res).toBeTruthy();
    expect(rows().map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(w.status(a)).toBe('roster_only');
    const again = await run(NOW + DAY);
    expect(again.counts).toMatchObject({ inserted: 0, brought_forward: 0, skipped_rejected: 2 });
    expect(rows().map((x) => x.status)).toEqual(['rejected', 'rejected']);
  });

  it('undoing a run that re-activated a link is sticky too: withdrawn for good, the person back on the roster', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const gil = w.stranger('Gil', 'Sample');
    w.follow(gil, on(-10, 21));
    await run();
    const hal = w.person('Hal', 'Sample');
    chat(w.db, 'direct', [w.phone(hal)]).say(on(-60), w.phone(hal), 'hi');
    w.merge(gil, hal);
    await run(NOW + DAY); // withdrawn: Hal knew them
    w.db.prepare(`UPDATE people SET merged_into_id = NULL, status = 'roster_only' WHERE id = ?`).run(gil);
    rebuildPersonCanon(w.db);
    const back = await run(NOW + 2 * DAY);
    expect(back.counts).toMatchObject({ reactivated: 1, brought_forward: 1 });
    undoRun(w.db, back.runId!, { now: NOW + 2 * DAY + MIN });
    expect(rows(gil).map((x) => x.status)).toEqual(['withdrawn']);
    expect(w.status(gil)).toBe('roster_only');
    const again = await run(NOW + 3 * DAY);
    expect(again.counts).toMatchObject({ reactivated: 0, inserted: 0, brought_forward: 0, skipped_rejected: 1 });
    expect(again.runId).toBeNull();
    expect(rows(gil).map((x) => x.status)).toEqual(['withdrawn']);
  });

  it('a rejection holds after its occasion is merged into another one', async () => {
    const x = w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    const a = w.person('Aya', 'Sample');
    w.follow(a, on(-10, 21));
    await run();
    rejectMetAtLinks(w.db, [one(a)!.id], { runId: newRun(w.db, 'user'), actor: 'user', now: NOW });
    const y = w.social({ title: 'Rooftop social', start: on(-10, 20), end: on(-10, 23) });
    w.db.prepare('UPDATE occasions SET merged_into_id = ? WHERE id = ?').run(y, x);
    w.card(a, { createdAt: on(-10, 22) }); // new evidence for the same happening
    const r = await run(NOW + DAY);
    expect(r.counts).toMatchObject({ inserted: 0, skipped_rejected: 2 });
    expect(rows(a).map((row) => [row.target_key, row.status])).toEqual([[`o:${x}`, 'rejected']]);
  });

  it('a person the owner linked himself gets no inferred link', async () => {
    const show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    const other = w.social({ title: 'Other night', start: on(-20, 20), end: on(-20, 23) });
    const a = w.person('Aya', 'Sample');
    w.db.prepare(
      `INSERT INTO person_met_at (id, person_id, occasion_id, target_key, signal, signal_at, confidence, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, 1, 'active', 'user', ?, ?)`,
    ).run(uuidv7(), a, other, `o:${other}`, on(-20, 21), NOW, NOW);
    w.follow(a, on(-10, 21));
    await run();
    expect(rows(a).map((x) => [x.source, x.target_key])).toEqual([['user', `o:${other}`]]);
    expect(show).toBeTruthy();
  });

  it('stops early on the signal: partial, consistent', async () => {
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    w.follow(w.person('Aya', 'Sample'), on(-10, 21));
    const ac = new AbortController();
    ac.abort();
    const r = await runMetAt(w.db, { now: NOW, signal: ac.signal });
    expect(r).toMatchObject({ complete: false, runId: null });
    expect(rows()).toEqual([]);
  });
});

describe('job', () => {
  it("'met-at' runs daily at 06:40, exclusive, and reports non-zero counts", async () => {
    const jobs = metAtJobs({});
    expect(jobs.map((j) => ({ name: j.name, schedule: j.schedule, exclusive: j.exclusive }))).toEqual([
      { name: 'met-at', schedule: { kind: 'daily', at: '06:40' }, exclusive: true },
    ]);
    w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
    w.follow(w.person('Aya', 'Sample'), on(-10, 21));
    const ctx: JobContext = { db: w.db, jobRunId: 7, trigger: 'manual', now: () => NOW, log: nullLogger, signal: new AbortController().signal };
    const out = await jobs[0]!.run(ctx);
    expect(out).toMatchObject({ status: 'ok', stats: { inserted: 1, derived: 1 } });
    expect(Object.values((out as { stats: Record<string, number> }).stats)).not.toContain(0);
    expect(w.db.prepare('SELECT job_run_id FROM runs').pluck().all()).toEqual([7]);
  });
});
