import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { intelJobs } from '../../src/intel/jobs';
import { planPlaceTidy, tidyPlaces } from '../../src/intel/placeTidy';
import { undoBatch } from '../../src/journal/undo';
import { nullLogger } from '../../src/ops/logger';
import type { JobContext } from '../../src/scheduler/scheduler';
import { seedMessage } from '../helpers';
import { intelWorld, NOW, type IntelWorld } from './world';

const fact = (w: IntelWorld, id: string) =>
  w.db.prepare('SELECT value, value_norm, status, superseded_at, superseded_by, support FROM facts WHERE id = ?').get(id) as {
    value: string;
    value_norm: string;
    status: string;
    superseded_at: number | null;
    superseded_by: string | null;
    support: number;
  };
const evidenceOf = (w: IntelWorld, id: string) => w.db.prepare(`SELECT message_id FROM evidence WHERE subject_type = 'fact' AND subject_id = ?`).pluck().all(id);
const cite = (w: IntelWorld, personId: string, factId: string) =>
  w.db.prepare(`INSERT INTO evidence (subject_type, subject_id, message_id, quote) VALUES ('fact', ?, ?, 'q')`).run(factId, seedMessage(w.db, w.phone(personId)));
const collection = (w: IntelWorld, name: string, personId: string) => {
  const id = uuidv7();
  w.db.prepare(`INSERT INTO locations (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(id, name, NOW, NOW);
  w.db.prepare(`INSERT INTO person_locations (person_id, location_id, origin, created_at) VALUES (?, ?, 'legacy', ?)`).run(personId, id, NOW);
  return id;
};
const locationName = (w: IntelWorld, id: string) => w.db.prepare('SELECT name FROM locations WHERE id = ?').pluck().get(id);
const ctx = (w: IntelWorld, trigger: JobContext['trigger']): JobContext => ({ db: w.db, jobRunId: 1, trigger, now: () => NOW, log: nullLogger, signal: new AbortController().signal });

describe('places-tidy', () => {
  it("renames the agent's place facts, closes non-places, folds duplicates; one undoable batch", () => {
    const w = intelWorld();
    const sam = w.person('Sam', 'Rivera');
    const dana = w.person('Dana', 'Okafor');
    const la = w.fact(sam, 'location_current', 'LA');
    const roommate = w.fact(dana, 'location_current', 'lives with you as roommate');
    const next1 = w.fact(sam, 'location_next', 'Los Angeles');
    const next2 = w.fact(sam, 'location_next', 'DTLA');
    cite(w, sam, next1);
    cite(w, sam, next2);
    const done = w.fact(dana, 'hometown', 'Berlin, Germany');
    const trip = w.fact(dana, 'travel_plan', 'Lisbon trip');

    const s = tidyPlaces(w.db, { now: NOW });
    expect(s).toMatchObject({ renamed: 2, merged: 1, retired: 1, kept: 0 });
    expect(fact(w, la)).toMatchObject({ value: 'Los Angeles, CA', value_norm: 'los angeles ca', status: 'confirmed' });
    expect(fact(w, roommate)).toMatchObject({ status: 'invalidated', superseded_at: NOW });
    // the two location_next facts now say one place: the first stays (renamed), the other folds into it
    expect(fact(w, next1)).toMatchObject({ value: 'Los Angeles, CA', status: 'confirmed', support: 2 });
    expect(fact(w, next2)).toMatchObject({ status: 'invalidated', superseded_by: next1 });
    expect(evidenceOf(w, next1)).toHaveLength(2);
    expect(fact(w, done).value).toBe('Berlin, Germany');
    expect(fact(w, trip).value).toBe('Lisbon trip'); // a trip keeps its own words
    const batch = w.db.prepare('SELECT title, actor, undoable FROM change_batches WHERE id = ?').get(s.batchId) as { title: string; actor: string; undoable: number };
    expect(batch).toEqual({ title: "Wrote places as place names: 2 renamed, 1 duplicates folded, 1 that weren't places closed", actor: 'agent', undoable: 1 });

    // nothing left to do: no second batch
    expect(tidyPlaces(w.db, { now: NOW + 1 }).batchId).toBeNull();

    undoBatch(w.db, s.batchId!, { now: NOW + 2 });
    expect(fact(w, la)).toMatchObject({ value: 'LA', value_norm: 'la' });
    expect(fact(w, roommate)).toMatchObject({ status: 'confirmed', superseded_at: null });
    expect(fact(w, next2)).toMatchObject({ status: 'confirmed', superseded_by: null });
  });

  it('never touches what the owner entered; an agent duplicate of it is closed without changing the owner’s fact', () => {
    const w = intelWorld();
    const sam = w.person('Sam', 'Rivera');
    const mine = w.fact(sam, 'location_current', 'NYC', { source: 'legacy' });
    const country = w.fact(sam, 'home_location', 'lives in Australia', { source: 'user_log' });
    const dup = w.fact(sam, 'location_current', 'Brooklyn');
    cite(w, sam, dup);
    const before = fact(w, mine);

    const s = tidyPlaces(w.db, { now: NOW });
    expect(s).toMatchObject({ renamed: 0, merged: 1, retired: 0 });
    expect(fact(w, mine)).toEqual(before);
    expect(evidenceOf(w, mine)).toHaveLength(0);
    expect(fact(w, dup)).toMatchObject({ status: 'invalidated', superseded_by: mine });
    expect(fact(w, country).value).toBe('lives in Australia');
  });

  it('the owner run (manual only) renames the owner’s facts and Places collections, keeps what names no place', async () => {
    const w = intelWorld();
    const sam = w.person('Sam', 'Rivera');
    const mine = w.fact(sam, 'location_current', 'NYC', { source: 'legacy' });
    const country = w.fact(sam, 'location_current', 'Australia', { source: 'legacy' });
    const agent = w.fact(sam, 'hometown', 'SF');
    const la = collection(w, 'LA', sam);
    const aus = collection(w, 'Australia', sam);
    const taken = collection(w, 'SF', sam);
    collection(w, 'San Francisco, CA', sam);

    const job = intelJobs({}).find((j) => j.name === 'places-tidy-owner')!;
    expect(await job.run(ctx(w, 'schedule'))).toEqual({ status: 'skipped' });
    expect(planPlaceTidy(w.db, { owner: true }).facts.map((f) => [f.from, f.action])).toEqual([
      ['Australia', 'keep'],
      ['NYC', 'rename'],
    ]);

    const out = await job.run(ctx(w, 'manual'));
    expect(out).toMatchObject({ stats: { renamed: 1, kept: 1, collectionsRenamed: 1, collectionsKept: 2 } });
    expect(fact(w, mine).value).toBe('New York, NY');
    expect(fact(w, country)).toMatchObject({ value: 'Australia', status: 'confirmed' });
    expect(fact(w, agent).value).toBe('SF'); // the agent's facts are the daily job's
    expect([locationName(w, la), locationName(w, aus), locationName(w, taken)]).toEqual(['Los Angeles, CA', 'Australia', 'SF']);
  });
});
