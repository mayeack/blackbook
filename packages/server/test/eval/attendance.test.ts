import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import { formatAttendanceReport, runAttendanceEval } from '../../src/eval/attendance';
import { seedPerson } from '../helpers';
import { buildWorld, evening, NOW, TZ } from '../pipeline/occasions/world';

describe('attendance eval', () => {
  it('re-runs a past Partiful event with its guest list held out and grades the clues against that list', () => {
    const w = buildWorld();
    // the housewarming (owner GOING) was read completely; Tavi is on the list, Quill Brandt isn't
    w.db.prepare(`INSERT INTO partiful_event_sync (event_id, guests_status, updated_at) VALUES ('PtyEvt0001', 'ok', ?)`).run(NOW);
    w.db
      .prepare(`INSERT INTO event_attendees (id, event_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, 'going', 'guest', 'partiful', 1, ?, ?)`)
      .run(uuidv7(), w.partifulEvent, w.tavi.id, NOW, NOW);
    w.tavi.dm.say(evening(-4, 12), w.tavi.phone, 'birch loft housewarming tomorrow, you in?');
    w.tavi.dm.say(evening(-2, 11), w.tavi.phone, 'so great seeing you!');
    w.quillB.dm.say(evening(-4, 13), w.quillB.phone, 'birch loft housewarming tomorrow?');
    w.quillB.dm.say(evening(-2, 12), w.quillB.phone, 'so great seeing you!');

    const r = runAttendanceEval(w.db, { now: NOW, timeZone: TZ });
    expect(r.events).toBe(1);
    expect(r.truth).toEqual({ confirmed: 2, declined: 0 }); // Sol (host) and Tavi; the hidden guest never counts
    expect(r.deduction.possible).toMatchObject({ n: 2, confirmed: 1, absent: 1, precision: 0.5 });
    expect(r.deduction.recallPossible).toBe(0.5);
    expect(r.deduction.bySignal.map((s) => s.type).sort()).toEqual(['after_dm', 'mention_dm']);

    const text = formatAttendanceReport(r, NOW, TZ).join('\n');
    expect(text).toContain('1 past Partiful events you went to');
    for (const leak of ['Tavi', 'Quill', 'birch', 'great seeing']) expect(text).not.toContain(leak);
  });

  it('a guest Partiful knows only by first name counts as the contact whose first name agrees', () => {
    const w = buildWorld();
    w.db.prepare(`INSERT INTO partiful_event_sync (event_id, guests_status, updated_at) VALUES ('PtyEvt0001', 'ok', ?)`).run(NOW);
    const romyOnly = seedPerson(w.db, { display_name: 'Romy', first_name: 'Romy', last_name: null });
    w.db
      .prepare(`INSERT INTO event_attendees (id, event_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, 'going', 'guest', 'partiful', 1, ?, ?)`)
      .run(uuidv7(), w.partifulEvent, romyOnly, NOW, NOW);
    rebuildPersonCanon(w.db);
    w.romy.dm.say(evening(-4, 12), w.romy.phone, 'birch loft housewarming tomorrow, you in?');
    w.romy.dm.say(evening(-2, 11), w.romy.phone, 'so great seeing you!');
    const r = runAttendanceEval(w.db, { now: NOW, timeZone: TZ });
    expect(r.deduction.possible).toMatchObject({ confirmed: 1, absent: 0 });
  });
});
