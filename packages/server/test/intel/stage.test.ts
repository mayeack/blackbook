import { describe, expect, it } from 'vitest';
import { generators, wildcardSources } from '../../src/intel/generators';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import { seedCommitment } from '../helpers';
import { at, intelWorld, NOW, occasion } from './world';

describe('the suggestions stage takes the intel candidates', () => {
  it('stores and ranks a pre-event brief (forced in) and a follow-up with their links', async () => {
    const w = intelWorld();
    const ana = w.person('Ana', 'Arbor', { tie: 70, historical: 80, state: 'strong' });
    const bo = w.person('Bo', 'Birch', { tie: 50, historical: 60, state: 'steady' });
    const gus = w.person('Gus', 'Gale', { extra: { status: 'provisional' } });
    w.interaction(ana, 'dm_session', NOW - 3 * 86_400_000);
    const dinner = occasion(w.db, { title: 'Dinner', start: at(0, 19) });
    w.attendee(dinner, ana);
    w.attendee(dinner, bo);
    const party = occasion(w.db, { title: 'Party', start: at(-1, 20), end: at(-1, 23) });
    w.attendee(party, ana, { status: 'attended' });
    w.attendee(party, gus, { status: 'attended' });
    // A follow-up needs a documented intent: the owner said he'd send Gus the photos.
    seedCommitment(w.db, gus, { kind: 'send', what: 'send the photos', created_at: at(-1, 22) });

    const r = await runSuggestionsStage(w.db, { now: at(0, 7, 16), seed: 7, generators, wildcardSources });
    expect(r.status).toBe('ok');
    const rows = w.db.prepare(`SELECT kind, status, occasion_id, person_ids, time_critical FROM suggestions ORDER BY kind`).all() as {
      kind: string;
      status: string;
      occasion_id: string;
      person_ids: string;
      time_critical: number;
    }[];
    expect(rows.map((x) => [x.kind, x.occasion_id])).toEqual([
      ['event_followup', party],
      ['pre_event_brief', dinner],
    ]);
    const brief = rows.find((x) => x.kind === 'pre_event_brief')!;
    expect(brief).toMatchObject({ status: 'selected', time_critical: 1 });
    expect(JSON.parse(brief.person_ids)).toEqual([ana, bo]);
    expect(JSON.parse(rows[0]!.person_ids)).toEqual([gus]);
  });
});
