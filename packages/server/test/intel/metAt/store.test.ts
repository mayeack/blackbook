import { beforeEach, describe, expect, it } from 'vitest';
import { runMetAt } from '../../../src/intel/metAt/run';
import { activeMetAtLinks, metAtLinksForPerson, rejectMetAtLinks, screenshotPeople, targetKeys } from '../../../src/intel/metAt/store';
import { undoBatch } from '../../../src/journal/undo';
import { newRun } from '../../helpers';
import { DAY, metWorld, NOW, on, type MetWorld } from './world';

let w: MetWorld;
let show: { occasionId: string; ticketId: string };
let ana: string, bo: string, cy: string;

beforeEach(async () => {
  w = metWorld();
  show = w.ticketShow({ title: 'Glass Tide', start: on(-10, 20) });
  ana = w.person('Ana', 'Sample');
  bo = w.person('Bo', 'Sample');
  cy = w.stranger('Cy', 'Sample');
  w.shot(ana, on(-10, 21)); // 0.85
  w.follow(bo, on(-9, 3)); // 0.675
  w.igDm(cy, { firstAt: on(-10, 22) }); // 0.65, brought forward
  await runMetAt(w.db, { now: NOW });
});

describe('met-at store', () => {
  it('activeMetAtLinks: visible canonical people, surviving targets, confidence floor, screenshot flag', () => {
    const all = activeMetAtLinks(w.db);
    expect(all.map((l) => [l.personId, l.target, l.signal, l.screenshot])).toEqual([
      [ana, { type: 'occasion', id: show.occasionId }, 'contact_screenshot', true],
      [cy, { type: 'occasion', id: show.occasionId }, 'instagram_dm', false],
      [bo, { type: 'occasion', id: show.occasionId }, 'instagram_follow', false],
    ]);
    expect(all[0]).toMatchObject({ signalAt: on(-10, 21), confidence: 0.85 });
    expect(activeMetAtLinks(w.db, { minConfidence: 0.66 }).map((l) => l.personId)).toEqual([ana, bo]);
    expect(activeMetAtLinks(w.db, { personIds: [bo] }).map((l) => l.personId)).toEqual([bo]);
    expect(activeMetAtLinks(w.db, { personIds: ['nobody'] })).toEqual([]);
  });

  it('follows merges: a merged-away person reads as the survivor, a merged occasion as its survivor', () => {
    w.merge(bo, ana);
    const merged = w.social({ title: 'Glass Tide', start: on(-10, 20), end: on(-10, 23) });
    w.db.prepare('UPDATE occasions SET merged_into_id = ? WHERE id = ?').run(merged, show.occasionId);
    // Both rows now read as (ana, merged occasion): one per (person, target), the stronger one.
    const links = metAtLinksForPerson(w.db, bo);
    expect(links.map((l) => [l.personId, l.target.id, l.signal, l.confidence])).toEqual([[ana, merged, 'contact_screenshot', 0.85]]);
  });

  it('never shows hidden, roster-only or owner records', () => {
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(ana);
    w.db.prepare(`UPDATE people SET status = 'roster_only' WHERE id = ?`).run(cy);
    expect(activeMetAtLinks(w.db).map((l) => l.personId)).toEqual([bo]);
    expect(metAtLinksForPerson(w.db, ana)).toEqual([]);
    w.merge(bo, w.me);
    expect(activeMetAtLinks(w.db)).toEqual([]);
  });

  it('hides links to an occasion that is no longer an active, social, non-sensitive one, or a cancelled Partiful event', async () => {
    const setOcc = (sql: string) => w.db.prepare(`UPDATE occasions SET ${sql} WHERE id = ?`).run(show.occasionId);
    expect(activeMetAtLinks(w.db)).toHaveLength(3);
    setOcc('sensitive = 1');
    expect(activeMetAtLinks(w.db)).toEqual([]);
    setOcc(`sensitive = 0, status = 'excluded'`);
    expect(activeMetAtLinks(w.db)).toEqual([]);
    setOcc(`status = 'active', is_social = 0`);
    expect(metAtLinksForPerson(w.db, ana)).toEqual([]);
    setOcc('is_social = 1');
    expect(activeMetAtLinks(w.db)).toHaveLength(3);

    const ev = w.partiful({ title: 'Garden dinner', start: on(-5, 19) });
    const dee = w.person('Dee', 'Sample');
    w.follow(dee, on(-5, 20));
    await runMetAt(w.db, { now: NOW + DAY });
    expect(metAtLinksForPerson(w.db, dee).map((l) => l.target)).toEqual([{ type: 'event', id: ev }]);
    w.db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).run(ev);
    expect(metAtLinksForPerson(w.db, dee)).toEqual([]);
  });

  it('screenshotPeople: visible canonical people with a linked screenshot, never a ≥ 5k-follower profile', () => {
    const star = w.person('Star', 'Sample');
    w.shot(star, on(-3), { followers: 9_000 });
    const pending = w.person('Pending', 'Sample');
    w.shot(pending, on(-3), { status: 'ambiguous' });
    const roster = w.stranger('Roster', 'Sample');
    w.shot(roster, on(-3));
    expect([...screenshotPeople(w.db)]).toEqual([ana]);
    w.merge(ana, bo);
    expect([...screenshotPeople(w.db)]).toEqual([bo]);
  });

  it('rejectMetAtLinks: one journaled batch in the caller run; undoing it restores the link', () => {
    const [a] = activeMetAtLinks(w.db, { personIds: [ana] });
    const runId = newRun(w.db, 'user');
    expect(rejectMetAtLinks(w.db, [a!.id], { runId, actor: 'user', now: NOW + DAY })).toBe(1);
    expect(activeMetAtLinks(w.db, { personIds: [ana] })).toEqual([]);
    const batch = w.db.prepare('SELECT id, kind, actor, subject_person_id FROM change_batches WHERE run_id = ?').get(runId) as { id: string; kind: string; actor: string; subject_person_id: string };
    expect(batch).toMatchObject({ kind: 'met_at', actor: 'user', subject_person_id: ana });
    undoBatch(w.db, batch.id, { now: NOW + 2 * DAY });
    expect(activeMetAtLinks(w.db, { personIds: [ana] }).map((l) => l.id)).toEqual([a!.id]);
    expect(rejectMetAtLinks(w.db, [], { runId, actor: 'user' })).toBe(0);
  });

  it('targetKeys: e:<id> and o:<occasion with that event_id> name the same happening, across the merge chain', () => {
    const ev = w.partiful({ title: 'Garden dinner', start: on(-5, 19) });
    const occ = w.social({ title: 'Garden dinner', start: on(-5, 19), end: on(-5, 22), eventId: ev });
    const survivor = w.social({ title: 'Garden dinner', start: on(-5, 19), end: on(-5, 22) });
    w.db.prepare('UPDATE occasions SET merged_into_id = ? WHERE id = ?').run(survivor, occ);
    expect([...targetKeys(w.db, { occasion_id: null, event_id: ev })].sort()).toEqual([`e:${ev}`, `o:${survivor}`].sort());
    expect([...targetKeys(w.db, { occasion_id: occ, event_id: null })].sort()).toEqual([`e:${ev}`, `o:${survivor}`].sort());
    expect([...targetKeys(w.db, { occasion_id: survivor, event_id: null })].sort()).toEqual([`e:${ev}`, `o:${survivor}`].sort());
  });
});
