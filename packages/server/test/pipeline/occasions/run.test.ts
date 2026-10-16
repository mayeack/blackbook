import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { mergePeople } from '../../../src/identity/merge';
import { startRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import { occasionJobs } from '../../../src/pipeline/occasions/jobs';
import { buildAdjudicationPacket, occasionsAwaitingAdjudication } from '../../../src/pipeline/occasions/packet';
import { runOccasions, runOccasionsAsync } from '../../../src/pipeline/occasions/run';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { nullLogger } from '../../../src/ops/logger';
import { attendeesOf, buildWorld, CAL, calEvent, DAY, evening, NOW, occasionOf, TZ, updateCalEvent, type World } from './world';

let w: World;
const run = (now = NOW) => runOccasions(w.db, { now, timeZone: TZ });
const occ = (key: string) => {
  const id = occasionOf(w.db, w.ev[key]!);
  expect(id, key).toBeTruthy();
  return w.db.prepare('SELECT * FROM occasions WHERE id = ?').get(id) as Record<string, unknown> & { id: string };
};
const att = (key: string) => attendeesOf(w.db, occ(key).id);
const statusOf = (key: string, personId: string) => att(key).find((a) => a.person_id === personId);
const interactions = () =>
  w.db.prepare(`SELECT person_id, occasion_id, units, channel FROM interactions WHERE kind = 'occasion' AND origin = 'derived' ORDER BY person_id, occasion_id`).all() as {
    person_id: string;
    occasion_id: string;
    units: number;
    channel: string;
  }[];
const batchOf = (rowId: string) =>
  w.db.prepare(`SELECT batch_id FROM change_log WHERE entity = 'event_attendees' AND entity_key = ? AND op = 'insert'`).pluck().get(rowId) as string;

beforeEach(() => {
  w = buildWorld();
});

describe('occasion merge', () => {
  it('a Gmail reservation and the own dinner event become one occasion at the reservation venue', () => {
    run();
    const o = occ('dinner');
    expect(occasionOf(w.db, w.ev.reservation!)).toBe(o.id);
    expect(o).toMatchObject({ title: 'Dinner w/ Romy & Tavi', venue_key: 'lupine room', kind: 'social', status: 'active' });
    const roles = w.db.prepare('SELECT source_ref, role FROM occasion_sources WHERE occasion_id = ? ORDER BY role').all(o.id);
    expect(roles).toEqual([
      { source_ref: w.ev.dinner, role: 'primary' },
      { source_ref: w.ev.reservation, role: 'reservation' },
    ]);
  });

  it('a partiful.com/e/<id> link and the feed UID join the occasion to the Partiful event', () => {
    run();
    const o = occ('party');
    expect(occasionOf(w.db, w.ev.partyFeed!)).toBe(o.id);
    expect(o.event_id).toBe(w.partifulEvent);
    expect(w.db.prepare(`SELECT role FROM occasion_sources WHERE occasion_id = ? AND source = 'partiful' AND source_ref = ?`).pluck().get(o.id, w.partifulEvent)).toBe('duplicate');
    expect(w.db.prepare(`SELECT role FROM occasion_sources WHERE source_ref = ?`).pluck().get(w.ev.partyFeed)).toBe('feed_copy');
  });

  it('excluded calendars make no occasion; shared-calendar events need corroboration', () => {
    run();
    expect(occasionOf(w.db, w.ev.holiday!)).toBeUndefined();
    expect(occ('potluck')).toMatchObject({ status: 'candidate', corroborated: 0, calendar_treatment: 'candidate' });
    // the trivia night is corroborated by my own message in a group chat
    expect(occ('trivia')).toMatchObject({ status: 'active', corroborated: 1 });
    expect(att('potluck')).toEqual([]);
  });

  it("the calendar adapter's treatment (and the owner's setting) wins over the heuristics", () => {
    const listed = w.db.prepare(
      `INSERT INTO gcal_calendars (calendar_id, kind, default_treatment, default_partiful_linked, first_seen_at, last_listed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    listed.run(CAL.community, 'shared', 'candidate', 0, NOW, NOW, NOW);
    listed.run(CAL.personal, 'primary', 'attending', 0, NOW, NOW, NOW);
    run();
    expect(occ('potluck')).toMatchObject({ status: 'candidate', calendar_treatment: 'candidate' });
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      `gcal.calendar:${CAL.community}`,
      JSON.stringify({ treatment: 'attending' }),
      NOW,
      NOW,
    );
    run();
    expect(occ('potluck')).toMatchObject({ status: 'active', calendar_treatment: 'attending' });
    // the owner excludes his personal calendar: its occasions are retired and their agent rows withdrawn
    const partyId = occ('party').id;
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      `gcal.calendar:${CAL.personal}`,
      JSON.stringify({ treatment: 'excluded' }),
      NOW,
      NOW,
    );
    run();
    expect(occ('dinner').status).toBe('excluded');
    expect([...att('dinner'), ...att('drinks')].map((r) => r.status)).toEqual(['withdrawn', 'withdrawn', 'withdrawn']);
    // the housewarming lives on (same id) through its Partiful feed copy
    expect(occasionOf(w.db, w.ev.party!)).toBeUndefined();
    expect(occ('partyFeed')).toMatchObject({ id: partyId, status: 'active' });
    expect(statusOf('partyFeed', w.sol.id)?.status).toBe('attended');
  });

  it("reads the calendar adapter's columns: self_response, event_type, all-day dates, null attendee fields", () => {
    const own = calEvent(w.db, {
      summary: 'Dinner w/ Romy',
      start: evening(-25),
      attendees: [
        { email: null, name: 'Romy Castell', status: 'accepted', self: false, organizer: false, optional: false, guests: 0 },
        { email: 'owner@example.com', name: null, status: 'accepted', self: true, organizer: true, optional: false, guests: 0 },
      ],
    });
    const res = calEvent(w.db, { summary: 'Booking confirmed', location: 'Sable Bistro', start: evening(-25, 19, 30), creator: null });
    w.db.prepare(`UPDATE calendar_events SET event_type = 'fromGmail' WHERE id = ?`).run(res);
    const declined = calEvent(w.db, { summary: 'Drinks w/ Quill', start: evening(-26) });
    w.db.prepare(`UPDATE calendar_events SET self_response = 'declined' WHERE id = ?`).run(declined);
    run();
    expect(occasionOf(w.db, res)).toBe(occasionOf(w.db, own));
    const rows = attendeesOf(w.db, occasionOf(w.db, own)!);
    expect(rows.map((r) => [r.person_id, r.source])).toEqual([[w.romy.id, 'calendar_text']]);
    expect(JSON.parse(rows[0]!.evidence).map((e: { t: string }) => e.t)).toEqual(['explicit_name', 'title_name']);
    expect(w.db.prepare('SELECT status FROM occasions WHERE id = ?').pluck().get(occasionOf(w.db, declined))).toBe('excluded');
  });

  it('ids are stable: a later reservation joins the existing occasion; occasions that turn out to be one are pointer-merged', () => {
    const own = calEvent(w.db, { summary: 'Dinner w/ Romy', location: 'Sable Bistro', start: evening(-30) });
    const res = calEvent(w.db, { summary: 'Reservation at Sable Bistro', location: 'Sable Bistro, 5 Example Ln', start: evening(-30, 21, 30), eventType: 'fromGmail', creator: null });
    run();
    const a = occasionOf(w.db, own)!;
    const b = occasionOf(w.db, res)!;
    expect(a).not.toBe(b);
    // the reservation moves to 19:15 → same evening, same venue
    updateCalEvent(w.db, res, { starts_at: evening(-30, 19, 15), ends_at: evening(-30, 21, 15) });
    const s = run();
    expect(s.occasionsMerged).toBe(1);
    expect(occasionOf(w.db, own)).toBe(a);
    expect(occasionOf(w.db, res)).toBe(a);
    expect(w.db.prepare('SELECT merged_into_id FROM occasions WHERE id = ?').pluck().get(b)).toBe(a);
    // a split hands the moved event a new occasion; the original keeps its id
    updateCalEvent(w.db, res, { starts_at: evening(-29, 12), ends_at: evening(-29, 14) });
    run();
    expect(occasionOf(w.db, own)).toBe(a);
    expect(occasionOf(w.db, res)).not.toBe(a);
  });
});

describe('classification', () => {
  it('logistics, appointments and work never get attendees; medical is sensitive', () => {
    run();
    expect(occ('maid')).toMatchObject({ kind: 'logistics', is_social: 0 });
    expect(occ('hoa')).toMatchObject({ kind: 'logistics', is_social: 0 });
    expect(occ('dentist')).toMatchObject({ kind: 'appointment', sensitive: 1, is_social: 0 });
    expect(occ('hotel')).toMatchObject({ kind: 'lodging', is_social: 0 });
    for (const k of ['maid', 'hoa', 'dentist', 'hotel']) expect(att(k)).toEqual([]);
  });
});

describe('attendee inference', () => {
  it('"Drinks w/ X" resolves to the right X using message evidence (two people named X)', () => {
    run();
    const rows = att('drinks');
    expect(rows.map((r) => r.person_id)).toEqual([w.quillA.id]);
    const r = rows[0]!;
    expect(r).toMatchObject({ status: 'attended', source: 'calendar_text', role: 'companion' });
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    const ev = JSON.parse(r.evidence) as { t: string; m?: number[] }[];
    expect(ev.map((e) => e.t)).toEqual(['after_dm', 'logistics_dm', 'mention_dm', 'title_name']);
    // evidence is ids only
    expect(r.evidence).not.toMatch(/moss|omw|catching/i);
  });

  it('names in the title of a merged dinner, plus a logistics text', () => {
    run();
    const rows = att('dinner');
    expect(rows.map((r) => [r.person_id, r.status]).sort()).toEqual([
      [w.romy.id, 'attended'],
      [w.tavi.id, 'attended'],
    ].sort());
    expect(statusOf('dinner', w.tavi.id)!.confidence).toBeGreaterThan(statusOf('dinner', w.romy.id)!.confidence);
  });

  it('Partiful GOING/host count, MAYBE is possible, hidden guests never appear', () => {
    run();
    expect(statusOf('party', w.sol.id)).toMatchObject({ status: 'attended', source: 'partiful', role: 'host' });
    expect(statusOf('party', w.pim.id)).toMatchObject({ status: 'possible', source: 'partiful', role: 'guest' });
    expect(statusOf('party', w.hallie.id)).toBeUndefined();
  });

  it('an explicit invitee resolves by email; an unknown one stays a name candidate', () => {
    run();
    expect(att('games')).toEqual([expect.objectContaining({ person_id: w.ines.id, status: 'attended', source: 'calendar_explicit', confidence: 0.95, role: 'guest' })]);
    const cands = w.db.prepare('SELECT cand_key, kind FROM occasion_candidates WHERE occasion_id = ? ORDER BY cand_key').all(occ('games').id);
    expect(cands).toEqual([
      { cand_key: 'n:unknown guest', kind: 'name' },
      { cand_key: `p:${w.ines.id}`, kind: 'person' },
    ]);
  });

  it('a ticket holder counts; the ticket count caps unnamed companions under the bar', () => {
    run();
    expect(occ('concert').ticket_count).toBe(2);
    expect(statusOf('concert', w.tavi.id)).toMatchObject({ status: 'attended', role: 'ticket_holder', source: 'calendar_text' });
    // Romy texted about it (mention + "where are you" + next-day), but 2 tickets = me + Tavi
    expect(statusOf('concert', w.romy.id)).toMatchObject({ status: 'possible', source: 'inferred', confidence: 0.74 });
  });

  it('a group nickname makes the members of that small group chat possible', () => {
    run();
    expect(att('crewDinner').map((r) => [r.person_id, r.status]).sort()).toEqual(
      [w.romy.id, w.tavi.id, w.quillA.id].map((id) => [id, 'possible']).sort(),
    );
  });

  it('names a hidden person answers to are never resolved or kept', () => {
    run();
    expect(att('lunchHidden')).toEqual([]);
    expect(w.db.prepare('SELECT count(*) FROM occasion_candidates WHERE occasion_id = ?').pluck().get(occ('lunchHidden').id)).toBe(0);
    const all = JSON.stringify(w.db.prepare('SELECT * FROM occasion_candidates').all());
    expect(all).not.toContain(w.hallie.id);
    expect(all.toLowerCase()).not.toContain('hallie');
    expect(w.db.prepare('SELECT count(*) FROM event_attendees WHERE occasion_id IS NOT NULL AND person_id = ?').pluck().get(w.hallie.id)).toBe(0);
  });

  it('upcoming occasions are "going" and do not count as interactions yet', () => {
    run();
    expect(statusOf('brunch', w.romy.id)).toMatchObject({ status: 'going' });
    expect(interactions().some((i) => i.occasion_id === occ('brunch').id)).toBe(false);
    // the day after it happens, the re-run flips it to attended and it counts
    run(evening(4, 12));
    expect(statusOf('brunch', w.romy.id)).toMatchObject({ status: 'attended' });
    expect(interactions().some((i) => i.occasion_id === occ('brunch').id && i.person_id === w.romy.id)).toBe(true);
  });
});

describe('effects', () => {
  it('counted attendees of past social occasions → occasion interactions (1.5 units) and co_attend edges', () => {
    run();
    const got = interactions().map((i) => [i.person_id, i.occasion_id, i.units, i.channel]);
    const want = [
      [w.quillA.id, occ('drinks').id, 1.5, 'calendar'],
      [w.romy.id, occ('dinner').id, 1.5, 'calendar'],
      [w.tavi.id, occ('dinner').id, 1.5, 'calendar'],
      [w.tavi.id, occ('concert').id, 1.5, 'calendar'],
      [w.sol.id, occ('party').id, 1.5, 'partiful'],
      [w.ines.id, occ('games').id, 1.5, 'calendar'],
    ];
    expect(got.sort()).toEqual(want.sort());
    const edges = w.db.prepare(`SELECT a_id, b_id, type, ref, w_raw FROM edge_evidence`).all() as { a_id: string; b_id: string; type: string; ref: string; w_raw: number }[];
    expect(edges).toHaveLength(1);
    const [a, b] = [w.romy.id, w.tavi.id].sort();
    expect(edges[0]).toMatchObject({ a_id: a, b_id: b, type: 'co_attend', ref: `occ:${occ('dinner').id}` });
    // s_romy · s_tavi / log2(1 + 3 people)
    const s = (id: string) => statusOf('dinner', id)!.confidence;
    expect(edges[0]!.w_raw).toBeCloseTo((s(w.romy.id) * s(w.tavi.id)) / 2, 4);
  });

  it('a Partiful "event" interaction for the same person is not counted twice', () => {
    w.db.prepare(
      `INSERT INTO interactions (id, person_id, kind, channel, event_id, started_at, units, origin, created_at, updated_at)
       VALUES (?, ?, 'event', 'partiful', ?, ?, 1.5, 'derived', ?, ?)`,
    ).run(uuidv7(), w.sol.id, w.partifulEvent, evening(-3, 20), NOW, NOW);
    run();
    expect(interactions().some((i) => i.person_id === w.sol.id)).toBe(false);
  });

  it('merged people count once, under the survivor', () => {
    run();
    const runId = startRun(w.db, 'user', { now: NOW });
    mergePeople(w.db, { survivorId: w.romy.id, mergedId: w.tavi.id, method: 'user', runId, actor: 'user', now: NOW });
    run();
    expect(interactions().filter((i) => i.occasion_id === occ('dinner').id).map((i) => i.person_id)).toEqual([w.romy.id]);
    expect(w.db.prepare(`SELECT count(*) FROM edge_evidence`).pluck().get()).toBe(0);
  });
});

describe('re-runs and undo', () => {
  it('a second pass over unchanged data writes nothing and opens no run', () => {
    run();
    const before = {
      runs: w.db.prepare('SELECT count(*) FROM runs').pluck().get(),
      batches: w.db.prepare('SELECT count(*) FROM change_batches').pluck().get(),
      occasions: JSON.stringify(w.db.prepare('SELECT * FROM occasions ORDER BY id').all()),
      sources: JSON.stringify(w.db.prepare('SELECT * FROM occasion_sources ORDER BY 1, 2, 3').all()),
      cands: JSON.stringify(w.db.prepare('SELECT * FROM occasion_candidates ORDER BY 1, 2').all()),
      edges: JSON.stringify(w.db.prepare('SELECT * FROM edge_evidence ORDER BY id').all()),
      inter: JSON.stringify(w.db.prepare('SELECT * FROM interactions ORDER BY id').all()),
    };
    const s = run(NOW + 60_000);
    expect(s).toMatchObject({
      occasionsCreated: 0,
      occasionsUpdated: 0,
      attendeesInserted: 0,
      attendeesUpdated: 0,
      attendeesWithdrawn: 0,
      interactionsUpserted: 0,
      interactionsDeleted: 0,
      edgesUpserted: 0,
      edgesDeleted: 0,
    });
    expect({
      runs: w.db.prepare('SELECT count(*) FROM runs').pluck().get(),
      batches: w.db.prepare('SELECT count(*) FROM change_batches').pluck().get(),
      occasions: JSON.stringify(w.db.prepare('SELECT * FROM occasions ORDER BY id').all()),
      sources: JSON.stringify(w.db.prepare('SELECT * FROM occasion_sources ORDER BY 1, 2, 3').all()),
      cands: JSON.stringify(w.db.prepare('SELECT * FROM occasion_candidates ORDER BY 1, 2').all()),
      edges: JSON.stringify(w.db.prepare('SELECT * FROM edge_evidence ORDER BY id').all()),
      inter: JSON.stringify(w.db.prepare('SELECT * FROM interactions ORDER BY id').all()),
    }).toEqual(before);
  });

  it('each occasion is its own undoable batch; an undone attendee stays blocked and its effects go', () => {
    run();
    const row = statusOf('drinks', w.quillA.id)!;
    const batch = w.db.prepare('SELECT kind, actor, title FROM change_batches WHERE id = ?').get(batchOf(row.id));
    expect(batch).toMatchObject({ kind: 'attendee', actor: 'agent', title: 'Found 1 person at a get-together on 2026-10-04' });
    undoBatch(w.db, batchOf(row.id), { now: NOW + 1 });
    expect(statusOf('drinks', w.quillA.id)).toMatchObject({ status: 'rejected' });
    const s = run(NOW + 2);
    expect(s.attendeesBlocked).toBeGreaterThanOrEqual(1);
    expect(statusOf('drinks', w.quillA.id)).toMatchObject({ status: 'rejected' });
    expect(interactions().some((i) => i.person_id === w.quillA.id)).toBe(false);
    // and stays that way
    run(NOW + 3);
    expect(statusOf('drinks', w.quillA.id)).toMatchObject({ status: 'rejected' });
  });

  it('an occasion that is cancelled or stops being social has its agent rows withdrawn (journaled) and its effects removed', () => {
    run();
    updateCalEvent(w.db, w.ev.dinner!, { status: 'cancelled' });
    updateCalEvent(w.db, w.ev.reservation!, { status: 'cancelled' });
    updateCalEvent(w.db, w.ev.drinks!, { summary: 'Dentist w/ Quill' });
    const s = run(NOW + 5);
    expect(occ('dinner').status).toBe('cancelled');
    expect(att('dinner').map((r) => r.status)).toEqual(['withdrawn', 'withdrawn']);
    expect(occ('drinks')).toMatchObject({ kind: 'appointment', sensitive: 1 });
    expect(att('drinks').map((r) => r.status)).toEqual(['withdrawn']);
    expect(s.attendeesWithdrawn).toBe(3);
    expect(interactions().some((i) => [occ('dinner').id, occ('drinks').id].includes(i.occasion_id))).toBe(false);
    expect(w.db.prepare(`SELECT count(*) FROM edge_evidence`).pluck().get()).toBe(0);
    // the withdrawal is undoable like any agent change
    const wd = w.db.prepare(`SELECT id FROM change_batches WHERE kind = 'attendee' AND title LIKE 'Updated who was%' ORDER BY seq`).pluck().all() as string[];
    expect(wd.length).toBeGreaterThan(0);
  });

  it("a calendar whose synced events were deleted (excluded, removed or disconnected) retires its occasions as 'excluded'", () => {
    run();
    expect(att('dinner').length).toBeGreaterThan(0);
    w.db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(CAL.personal);
    run(NOW + 5);
    expect(occ('dinner').status).toBe('excluded');
    expect(att('dinner').every((r) => r.status === 'withdrawn')).toBe(true);
    expect(interactions().some((i) => i.occasion_id === occ('dinner').id)).toBe(false);
  });

  it('an undone update is not redone by the next pass', () => {
    run();
    // Tavi's dinner row: drop the logistics text so the next pass lowers the confidence
    w.db.prepare(`DELETE FROM messages WHERE text LIKE 'here, grabbed%'`).run();
    run(NOW + 10);
    const lowered = statusOf('dinner', w.tavi.id)!;
    expect(lowered.confidence).toBeLessThan(0.85);
    const upd = w.db
      .prepare(`SELECT batch_id FROM change_log WHERE entity = 'event_attendees' AND entity_key = ? AND op = 'update' ORDER BY seq DESC LIMIT 1`)
      .pluck()
      .get(lowered.id) as string;
    undoBatch(w.db, upd, { now: NOW + 11 });
    const restored = statusOf('dinner', w.tavi.id)!.confidence;
    expect(restored).toBeGreaterThan(0.85);
    run(NOW + 12);
    expect(statusOf('dinner', w.tavi.id)!.confidence).toBe(restored);
  });
});

describe('LLM seam and job', () => {
  it('builds the adjudication packet from the candidates (ids and first names only)', () => {
    run();
    const p = buildAdjudicationPacket(w.db, occ('drinks').id)!;
    expect(p.occasion).toMatchObject({ ref: `o:${occ('drinks').id}`, title: 'Drinks w/ Quill', kind: 'social' });
    expect(p.candidates).toEqual([
      expect.objectContaining({ ref: `p:${w.quillA.id}`, kind: 'person', label: 'Quill', evidence: expect.arrayContaining([expect.objectContaining({ type: 'logistics_dm', evidence_ids: [expect.stringMatching(/^m:\d+$/)] })]) }),
    ]);
    expect(JSON.stringify(p)).not.toMatch(/omw|catching up|555/);
    expect(buildAdjudicationPacket(w.db, occ('maid').id)).toBeNull();
    expect(buildAdjudicationPacket(w.db, occ('dentist').id)).toBeNull();
    const waiting = occasionsAwaitingAdjudication(w.db);
    expect(waiting).toContain(occ('drinks').id);
    expect(waiting).not.toContain(occ('potluck').id);
  });

  it("registers 'occasions' daily at 03:00 and returns counts", async () => {
    const [job] = occasionJobs({ timeZone: TZ });
    expect(job).toMatchObject({ name: 'occasions', schedule: { kind: 'daily', at: '03:00' }, exclusive: true });
    const ctx: JobContext = { db: w.db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: nullLogger, signal: new AbortController().signal };
    const out = await job!.run(ctx);
    expect(out && out.stats).toMatchObject({ attendeesInserted: expect.any(Number), interactionsUpserted: 6 });
    expect(w.db.prepare(`SELECT kind, job_run_id FROM runs WHERE id IN (SELECT run_id FROM change_batches WHERE kind = 'attendee')`).all()).toEqual([
      { kind: 'nightly', job_run_id: 1 },
    ]);
  });

  it('the job gives the event loop a turn between occasions and returns the same result as a synchronous pass', async () => {
    let turns = 0;
    let done = false;
    const spin = () => {
      if (done) return;
      turns++;
      setImmediate(spin);
    };
    setImmediate(spin);
    const r = await runOccasionsAsync(w.db, { now: NOW, timeZone: TZ, sliceMs: 0 });
    done = true;
    expect(r.complete).toBe(true);
    // every occasion is its own slice: other callbacks (the iMessage tail, HTTP) run in between
    expect(turns).toBeGreaterThanOrEqual(r.stats.occasions);
    expect(r.stats.attendeesInserted).toBeGreaterThan(0);
    // idempotent like the synchronous pass
    expect(run()).toMatchObject({ attendeesInserted: 0, attendeesUpdated: 0, attendeesWithdrawn: 0, occasionsCreated: 0 });
  });

  it('an abort stops the pass between occasions: the job reports partial, and the next pass finishes the work', async () => {
    const [job] = occasionJobs({ timeZone: TZ });
    const ac = new AbortController();
    ac.abort();
    const out = await job!.run({ db: w.db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: nullLogger, signal: ac.signal });
    expect(out && out.status).toBe('partial');
    expect(w.db.prepare('SELECT count(*) FROM occasions').pluck().get()).toBe(0);

    const mid = new AbortController();
    let turns = 0;
    const spin = () => {
      if (++turns === 4) mid.abort();
      else setImmediate(spin);
    };
    setImmediate(spin);
    const r = await runOccasionsAsync(w.db, { now: NOW, timeZone: TZ, signal: mid.signal, sliceMs: 0 });
    expect(r.complete).toBe(false);
    const attendees = w.db.prepare('SELECT count(*) FROM event_attendees').pluck();
    const partial = attendees.get() as number;
    expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE kind = 'occasion'`).pluck().get()).toBe(0); // effects wait
    expect(w.db.prepare(`SELECT DISTINCT status FROM runs WHERE id IN (SELECT run_id FROM change_batches WHERE kind = 'attendee')`).pluck().all()).not.toContain('running');
    const s = run();
    expect(attendees.get() as number).toBeGreaterThan(partial);
    expect(s.interactionsUpserted).toBe(6);
  });

  it('only processes the configured horizon', () => {
    calEvent(w.db, { summary: 'Dinner w/ Romy', start: NOW - 500 * DAY });
    const s = run();
    expect(s.calendarEvents).toBe(w.db.prepare(`SELECT count(*) FROM calendar_events WHERE calendar_id <> ? AND starts_at >= ?`).pluck().get(CAL.holidays, NOW - 400 * DAY));
  });
});
