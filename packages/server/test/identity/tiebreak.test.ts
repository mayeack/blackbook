/**
 * LLM identity tie-break with fakes only (synthetic people, 555-01xx phones; nothing reaches the network): who is
 * asked, what leaves (account kinds, never handles or numbers), when it merges (same ≥ 0.85, guards, G6 cap), and
 * the no-key / excluded / cached paths.
 */
import { describe, expect, it } from 'vitest';
import { createEgress } from '../../src/llm/egress';
import { accountKind, runTiebreaks, TIEBREAK_VERSION } from '../../src/identity/tiebreak';
import { MAX_MERGES_PER_NIGHT } from '../../src/identity/matcher';
import { writeSettings } from '../../src/settings/registry';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { memDb, newRun, seedIdentity, seedPerson, T0 } from '../helpers';

function world() {
  const db = memDb();
  const ava = seedPerson(db, { display_name: 'Ava Quillfeather', first_name: 'Ava', last_name: 'Quillfeather' });
  const dup = seedPerson(db, { display_name: 'Ava', first_name: 'Ava', last_name: null });
  seedIdentity(db, ava, 'phone', '+12125550101');
  seedIdentity(db, dup, 'instagram_username', 'avaquillfeather');
  const [a, b] = ava < dup ? [ava, dup] : [dup, ava];
  db.prepare(
    `INSERT INTO match_candidates (a_id, b_id, score_bits, p, families, guards_failed, status, features, created_at, updated_at)
     VALUES (?, ?, 3.2, 0.91, '["name","handle","graph"]', '[]', 'possible_duplicate', ?, ?, ?)`,
  ).run(a, b, JSON.stringify({ bits: { first: 3, handle: 4, groups: 2 }, counts: { shared_groups: 2, shared_events: 0 } }), T0, T0);
  return { db, ava, dup, a, b };
}

const reply = (verdict: 'same' | 'different' | 'unsure', conf = 0.93) => ({ json: { verdict, conf, key_evidence: ['handle contains the name'], why: 'Same person.' } });

describe('identity tie-break', () => {
  it('describes accounts by kind only', () => {
    const p = { first_name: 'Ava', last_name: 'Quillfeather' };
    expect(accountKind('phone', '+15125550142', p)).toBe('US phone, area 512');
    expect(accountKind('phone', '+442079460123', p)).toBe('phone, country code +44');
    expect(accountKind('email', 'ava@example.com', p)).toBe('work or custom-domain email address');
    expect(accountKind('email', 'ava@gmail.example', p)).toBe('personal email address');
    expect(accountKind('instagram_username', 'ava.quillfeather', p)).toBe('Instagram account whose handle contains their first and last name');
    expect(accountKind('instagram_username', 'zz_top', p)).toBe('Instagram account');
    expect(accountKind('instagram_username', 'avaquillfeather', { first_name: 'Ava', last_name: null }, { label: 'A', first_name: 'Ava', last_name: 'Quillfeather' })).toBe(
      "Instagram account whose handle contains their first name and Record A's last name",
    );
  });

  it('asks once per pair (tiebreak route: Haiku, effort low, no fallbacks), never sends handles or numbers, and merges on a confident "same"', async () => {
    const { db, ava, dup } = world();
    const llm = new FakeLlmClient().on('tiebreak', reply('same'));
    const out = await runTiebreaks(db, { llm, egress: createEgress(db) }, { now: T0 });
    expect(out.stats).toMatchObject({ asked: 1, same: 1, merged: 1 });
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0]!;
    expect(call).toMatchObject({ method: 'parse', kind: 'tiebreak', route: 'tiebreak', effort: 'low', thinking: 'disabled', fallbacks: false });
    expect(call.userText).toMatch(/Instagram account whose handle contains their first name and Record [AB]'s last name/);
    expect(call.userText).toContain('US phone, area 212');
    expect(call.userText).not.toMatch(/avaquillfeather|555|0101|Quillfeather|@/);
    const m = db.prepare('SELECT survivor_id, merged_id, method, score FROM merges').get() as Record<string, unknown>;
    expect(m.method).toBe('llm_tiebreak');
    expect([m.survivor_id, m.merged_id].sort()).toEqual([ava, dup].sort());
    expect(db.prepare('SELECT status, llm_verdict, prompt_version FROM match_candidates').get()).toEqual({ status: 'merged', llm_verdict: 'same', prompt_version: TIEBREAK_VERSION });
    expect(db.prepare(`SELECT actor, kind, confidence FROM change_batches WHERE kind = 'merge'`).get()).toMatchObject({ actor: 'agent', confidence: 0.91 });
  });

  it('"unsure"/"different" only record the verdict; the same evidence is not asked again', async () => {
    const { db } = world();
    const llm = new FakeLlmClient().on('tiebreak', reply('unsure', 0.6));
    expect((await runTiebreaks(db, { llm, egress: new FakeEgress() }, { now: T0 })).stats).toMatchObject({ asked: 1, unsure: 1, merged: 0 });
    expect((await runTiebreaks(db, { llm, egress: new FakeEgress() }, { now: T0 + 1000 })).stats).toMatchObject({ asked: 0, cached: 1 });
    expect(llm.calls).toHaveLength(1);
    expect(db.prepare('SELECT count(*) FROM merges').pluck().get()).toBe(0);
    // a confident "same" below the conf bar doesn't merge either
    db.prepare('UPDATE match_candidates SET llm_verdict = NULL').run();
    const low = new FakeLlmClient().on('tiebreak', reply('same', 0.7));
    expect((await runTiebreaks(db, { llm: low, egress: new FakeEgress() }, { now: T0 })).stats).toMatchObject({ same: 1, merged: 0 });
  });

  it('no key, excluded people, failed guards: nothing is asked', async () => {
    const w1 = world();
    const off = new FakeLlmClient({ configured: false });
    expect(await runTiebreaks(w1.db, { llm: off, egress: new FakeEgress() }, { now: T0 })).toMatchObject({ status: 'skipped' });
    expect(off.calls).toHaveLength(0);

    const w2 = world();
    writeSettings(w2.db, { 'llm.excluded_person_ids': [w2.dup] }, { actor: 'user', allowInternal: true });
    const llm2 = new FakeLlmClient().on('tiebreak', reply('same'));
    expect((await runTiebreaks(w2.db, { llm: llm2, egress: new FakeEgress() }, { now: T0 })).stats).toMatchObject({ excluded: 1, asked: 0 });
    expect(llm2.calls).toHaveLength(0);

    const w3 = world();
    w3.db.prepare(`INSERT INTO do_not_merge (a_id, b_id, reason, source, created_at) VALUES (?, ?, 'test', 'user', ?)`).run(w3.a, w3.b, T0);
    const llm3 = new FakeLlmClient().on('tiebreak', reply('same'));
    expect((await runTiebreaks(w3.db, { llm: llm3, egress: new FakeEgress() }, { now: T0 })).stats).toMatchObject({ blocked: 1, asked: 0 });
    expect(llm3.calls).toHaveLength(0);
  });

  it('the G6 nightly cap (shared with the matcher) holds a confident pair instead of merging', async () => {
    const { db } = world();
    const runId = newRun(db);
    for (let i = 0; i < MAX_MERGES_PER_NIGHT; i++) {
      const s = seedPerson(db, { display_name: `Filler ${i}`, first_name: 'Filler', last_name: `N${i}` });
      const m = seedPerson(db, { display_name: `Filler ${i}b`, first_name: 'Filler', last_name: `N${i}` });
      db.prepare(`INSERT INTO change_batches (id, run_id, kind, title, actor, created_at) VALUES (?, ?, 'merge', 'x', 'agent', ?)`).run(`b-${i}`, runId, T0 - 1000);
      db.prepare(`INSERT INTO merges (id, survivor_id, merged_id, method, batch_id, created_at) VALUES (?, ?, ?, 'probabilistic', ?, ?)`).run(`m-${i}`, s, m, `b-${i}`, T0 - 1000);
    }
    const llm = new FakeLlmClient().on('tiebreak', reply('same'));
    expect((await runTiebreaks(db, { llm, egress: new FakeEgress() }, { now: T0 })).stats).toMatchObject({ same: 1, merged: 0, held: 1 });
    expect(db.prepare('SELECT status FROM match_candidates').pluck().get()).toBe('held');
  });
});
