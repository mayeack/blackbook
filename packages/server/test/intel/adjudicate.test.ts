import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { volatileMarkers } from '../../src/llm/caching';
import { collectBatches } from '../../src/llm/batches';
import { createEgress, findRawIdentifiers, personIdsIn } from '../../src/llm/egress';
import { DEFAULT_MODEL, ROUTES } from '../../src/llm/models';
import { parseCustomId, type Egress } from '../../src/llm/types';
import { ADJUDICATION_PURPOSE, adjudicationQueue, registerAdjudicationConsumer, submitAdjudications } from '../../src/intel/adjudicate';
import { ADJUDICATION_SYSTEM } from '../../src/intel/adjudicationPrompt';
import { EFFECTS_DIRTY, getFlag } from '../../src/intel/common';
import { deriveEffectsIfDirty } from '../../src/intel/run';
import { undoBatch } from '../../src/journal/undo';
import { runOccasions } from '../../src/pipeline/occasions/run';
import { createLlmClient } from '../../src/llm/client';
import type { LlmClient } from '../../src/llm/types';
import { FakeLlmClient } from '../fakes/llm';
import { FakeAnthropic, reply, type BatchItemReply, type FakeMessage } from '../llm/fakeAnthropic';
import { attendeesOf, buildWorld, calEvent, DAY, evening, HOUR, NOW, occasionOf, TZ, type World } from '../pipeline/occasions/world';

let w: World;
let egress: Egress;
let unregister: () => void;
const LATER = NOW + 2 * HOUR;

const occ = (key: string) => occasionOf(w.db, w.ev[key]!)!;
const row = (key: string, personId: string) => attendeesOf(w.db, occ(key)).find((a) => a.person_id === personId);
/** A verdict as the model would answer it (tokens from the same egress the packet used). */
const answer = (attendees: { who: string; role?: string; confidence: number; ev?: number[] }[], extra: Partial<{ is_social: boolean; kind: string }> = {}): FakeMessage =>
  reply({
    json: {
      is_social: extra.is_social ?? true,
      kind: extra.kind ?? 'social',
      attendees: attendees.map((a) => ({ ref: egress.tokenFor(a.who), role: a.role ?? 'companion', confidence: a.confidence, evidence_ids: (a.ev ?? []).map((m) => `m:${m}`) })),
    },
  });
const submit = (llm: LlmClient, only?: string[], now = NOW) => submitAdjudications(w.db, { llm, egress }, { now, timeZone: TZ, only });
const collect = (llm: LlmClient) => collectBatches({ db: w.db, llm, now: () => LATER });
const batchCalls = (llm: FakeLlmClient) => llm.calls.filter((c) => c.method === 'batch');

/** The real client over the fake Anthropic API: answers per occasion key (custom_id → occasion). */
function realLlm(answers: Record<string, () => BatchItemReply>): { llm: LlmClient; api: FakeAnthropic } {
  const byOcc = new Map(Object.keys(answers).map((k) => [occ(k).replace(/-/g, ''), k]));
  const api = new FakeAnthropic().onBatchItem((r) => {
    const subject = r.custom_id.split('-')[1]!.replace(/r\d+$/, '');
    const key = byOcc.get(subject);
    return key ? answers[key]!() : { message: reply({ json: { is_social: true, kind: 'social', attendees: [] } }) };
  });
  return { api, llm: createLlmClient({ db: w.db, apiKey: 'synthetic-test-key', egress, fetch: api.fetch, now: () => LATER, maxRetries: 0 }) };
}
const msg = (m: FakeMessage): BatchItemReply => ({ message: m });

beforeEach(() => {
  w = buildWorld();
  runOccasions(w.db, { now: NOW, timeZone: TZ });
  egress = createEgress(w.db);
  unregister = registerAdjudicationConsumer({ now: () => LATER });
});
afterEach(() => unregister());

describe('submit', () => {
  it('one low-effort batch of pseudonymized packets, no fallbacks, a byte-stable system prompt, custom ids with the round', async () => {
    const llm = new FakeLlmClient();
    const r = await submit(llm);
    expect(r.status).toBe('ok');
    expect(r.stats).toMatchObject({ queued: 8, rendered: 8, submitted: 8 });
    const calls = batchCalls(llm);
    expect(calls).toHaveLength(8);
    for (const c of calls) {
      expect(c).toMatchObject({ kind: 'calendar', route: 'adjudicate', model: DEFAULT_MODEL, effort: 'low', thinking: 'disabled', fallbacks: false, maxTokens: ROUTES.adjudicate.maxTokens });
      expect(c.system).toBe(ADJUDICATION_SYSTEM);
      expect(parseCustomId(c.customId!)).toMatchObject({ kind: 'calendar', attempt: 0 });
      expect(c.customId).toMatch(/r1-0$/);
      expect(findRawIdentifiers(c.userText)).toEqual([]);
      expect(c.userText).toMatch(/^tz=UTC\n### occasion\n/);
      for (const raw of ['owner@example.com', 'ines.farrow@example.com', '+1555', 'Ashby', 'Brandt', 'Castell', 'Dunmore', 'Hallie', 'Example St']) expect(c.userText).not.toContain(raw);
    }
    expect(volatileMarkers(ADJUDICATION_SYSTEM)).toEqual([]);
    const drinks = calls.find((c) => c.subjectRef === `occ:${occ('drinks')}#1`)!;
    expect(drinks.userText).toContain(`${egress.tokenFor(w.quillA.id)} Quill · score`);
    expect(drinks.userText).toMatch(/\[m:\d+\|2026-10-04 18:55\|P[0-9a-z]+→ME\] omw, 5 min away/);
    // bookkeeping: one ledger row per occasion, adjudicated_at stamped, nothing re-queued tonight
    expect(w.db.prepare(`SELECT count(*) FROM occasion_adjudications WHERE status = 'submitted'`).pluck().get()).toBe(8);
    expect(w.db.prepare('SELECT adjudicated_at FROM occasions WHERE id = ?').pluck().get(occ('drinks'))).toBe(NOW);
    expect(adjudicationQueue(w.db, NOW + HOUR)).toEqual([]);
  });

  it('without an API key or budget nothing is sent and nothing is recorded', async () => {
    expect(await submit(new FakeLlmClient({ configured: false }))).toMatchObject({ status: 'skipped', reason: 'no_key' });
    const broke = new FakeLlmClient({ budget: { steady: 0, backfill: 0 } });
    expect((await submit(broke)).status).toBe('skipped');
    expect(batchCalls(broke)).toHaveLength(0);
    expect(w.db.prepare('SELECT count(*) FROM occasion_adjudications').pluck().get()).toBe(0);
    expect(w.db.prepare('SELECT count(*) FROM occasions WHERE adjudicated_at IS NOT NULL').pluck().get()).toBe(0);
  });

  it('excluded people never appear in a packet', async () => {
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('llm.excluded_person_ids', ?, ?, ?)`).run(JSON.stringify([w.tavi.id]), NOW, NOW);
    const llm = new FakeLlmClient();
    await submit(llm, [occ('dinner'), occ('concert')]);
    const calls = batchCalls(llm);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(personIdsIn(egress, c.userText)).not.toContain(w.tavi.id);
      expect(c.userText).not.toContain('grabbed a table');
    }
  });

  it("the packet lists the owner's other plans around the occasion and whether it is a recurring listing", async () => {
    w.ev.karaoke = calEvent(w.db, { summary: 'Karaoke', start: evening(-7, 21), end: evening(-7, 23) });
    runOccasions(w.db, { now: NOW, timeZone: TZ });
    const llm = new FakeLlmClient();
    await submit(llm, [occ('concert')]);
    const text = batchCalls(llm)[0]!.userText;
    expect(text).toContain('listing: no');
    expect(text).toContain('### other plans\n- Karaoke · 2026-10-07 21:00 → 2026-10-07 23:00');
  });

  it('the day-after re-run: an occasion adjudicated before its next-day messages could exist is queued again', () => {
    const trivia = occ('trivia');
    const ends = w.db.prepare('SELECT ends_at FROM occasions WHERE id = ?').pluck().get(trivia) as number;
    w.db.prepare('UPDATE occasions SET adjudicated_at = ? WHERE id = ?').run(ends + HOUR, trivia);
    expect(adjudicationQueue(w.db, NOW).find((q) => q.occasionId === trivia)?.reason).toBe('day_after');
    // once adjudicated after its day-after (and after its last inference) it is done
    w.db.prepare('UPDATE occasions SET adjudicated_at = ? WHERE id = ?').run(NOW, trivia);
    expect(adjudicationQueue(w.db, NOW).find((q) => q.occasionId === trivia)).toBeUndefined();
    expect(DAY).toBe(24 * HOUR);
  });
});

describe('apply (the real client over a fake API)', () => {
  it('≥ 0.75 counts, 0.5–0.75 is possible, omitted is withdrawn — as undoable source-llm rows the deterministic step leaves alone', async () => {
    const { llm, api } = realLlm({
      dinner: () => msg(answer([{ who: w.tavi.id, confidence: 0.95 }, { who: w.romy.id, confidence: 0.6 }])),
      crewDinner: () => msg(answer([{ who: w.romy.id, confidence: 0.9 }])),
    });
    await submit(llm, [occ('dinner'), occ('crewDinner')]);
    // what went out: a Haiku batch without fallbacks, effort low, thinking off, structured output, system cached 1 h
    const sent = api.requests.find((r) => r.method === 'POST' && r.path === '/v1/messages/batches')!;
    const first = (sent.body!.requests as { params: Record<string, unknown> }[])[0]!.params;
    expect(first).toMatchObject({
      model: DEFAULT_MODEL,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    expect(first).not.toHaveProperty('fallbacks');
    expect(JSON.stringify(sent.body)).not.toContain('Dunmore');

    const stats = await collect(llm);
    expect(stats).toMatchObject({ applied: 2, failed: 0 });
    expect(row('dinner', w.tavi.id)).toMatchObject({ status: 'attended', source: 'llm', confidence: 0.95, role: 'companion' });
    expect(row('dinner', w.romy.id)).toMatchObject({ status: 'possible', source: 'llm', confidence: 0.6 });
    expect(row('crewDinner', w.romy.id)).toMatchObject({ status: 'attended', source: 'llm' });
    expect(row('crewDinner', w.quillA.id)).toMatchObject({ status: 'withdrawn', source: 'llm' });
    expect(JSON.parse(row('dinner', w.tavi.id)!.evidence)[0]).toMatchObject({ t: 'llm', w: 0.95 });
    expect(w.db.prepare(`SELECT status FROM occasion_adjudications WHERE occasion_id = ?`).pluck().get(occ('dinner'))).toBe('applied');

    // the deterministic pass doesn't touch them, and the effects follow the verdict
    runOccasions(w.db, { now: LATER, timeZone: TZ });
    expect(row('dinner', w.tavi.id)).toMatchObject({ source: 'llm', confidence: 0.95 });
    expect(row('crewDinner', w.quillA.id)).toMatchObject({ status: 'withdrawn' });
    w.db.prepare(`INSERT OR REPLACE INTO intel_state (key, value, updated_at) VALUES (?, '1', ?)`).run(EFFECTS_DIRTY, LATER);
    deriveEffectsIfDirty(w.db, LATER);
    expect(getFlag(w.db, EFFECTS_DIRTY)).toBeNull();
    const touched = w.db.prepare(`SELECT person_id FROM interactions WHERE kind = 'occasion' AND occasion_id = ? ORDER BY person_id`).pluck().all(occ('crewDinner'));
    expect(touched).toEqual([w.romy.id]);

    // one journal batch per occasion: undo restores the deterministic row
    const batch = w.db
      .prepare(`SELECT cb.id FROM change_batches cb JOIN change_log cl ON cl.batch_id = cb.id WHERE cl.entity = 'event_attendees' AND cl.entity_key = ? ORDER BY cb.seq DESC LIMIT 1`)
      .pluck()
      .get(row('dinner', w.tavi.id)!.id) as string;
    undoBatch(w.db, batch, { actor: 'user', now: LATER });
    expect(row('dinner', w.tavi.id)).toMatchObject({ source: 'calendar_text', confidence: 0.88 });
  });

  it('a message-only candidate below "possible" moves up one tier at most, whatever the verdict says', async () => {
    w.ev.sorrel = calEvent(w.db, { summary: 'Dinner at Sorrel', start: evening(-30, 19), end: evening(-30, 21) });
    w.quillB.dm.say(evening(-29, 10), w.quillB.phone, 'so good catching up');
    runOccasions(w.db, { now: NOW, timeZone: TZ });
    const { llm } = realLlm({ sorrel: () => msg(answer([{ who: w.quillB.id, confidence: 0.95 }])) });
    await submit(llm, [occ('sorrel')]);
    await collect(llm);
    expect(row('sorrel', w.quillB.id)).toMatchObject({ status: 'possible', source: 'llm', confidence: 0.74 });
  });

  it('flags the effects for re-derivation when attendees changed', async () => {
    const { llm } = realLlm({ crewDinner: () => msg(answer([{ who: w.romy.id, confidence: 0.9 }])) });
    await submit(llm, [occ('crewDinner')]);
    await collect(llm);
    expect(getFlag(w.db, EFFECTS_DIRTY)).toBe(LATER);
  });

  it('never overrides the user, a sticky rejection, or downgrades a Partiful guest list', async () => {
    w.db.prepare(`UPDATE event_attendees SET source = 'user' WHERE id = ?`).run(row('dinner', w.tavi.id)!.id);
    w.db.prepare(`UPDATE event_attendees SET status = 'rejected' WHERE id = ?`).run(row('dinner', w.romy.id)!.id);
    const { llm } = realLlm({
      dinner: () => msg(answer([{ who: w.tavi.id, confidence: 0.55 }, { who: w.romy.id, confidence: 0.99 }])),
      party: () => msg(answer([{ who: w.pim.id, role: 'guest', confidence: 0.9 }])),
    });
    await submit(llm, [occ('dinner'), occ('party')]);
    await collect(llm);
    expect(row('dinner', w.tavi.id)).toMatchObject({ source: 'user', status: 'attended' });
    expect(row('dinner', w.romy.id)).toMatchObject({ status: 'rejected' });
    // Sol (Partiful host) left out by the model: kept; Pim (maybe) upgraded, but stays a Partiful row (its RSVP still rules)
    expect(row('party', w.sol.id)).toMatchObject({ source: 'partiful', status: 'attended' });
    const pimBefore = row('party', w.pim.id)!;
    expect(pimBefore).toMatchObject({ source: 'partiful', status: 'attended' });
    expect(pimBefore.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('a Partiful row is never re-sourced, re-roled or lowered by a same-level verdict', async () => {
    const before = row('party', w.sol.id)!;
    const { llm } = realLlm({ party: () => msg(answer([{ who: w.sol.id, role: 'guest', confidence: 0.8 }])) });
    await submit(llm, [occ('party')]);
    await collect(llm);
    expect(row('party', w.sol.id)).toMatchObject({ source: before.source, role: before.role, status: before.status, confidence: before.confidence });
  });

  it('refs the model wasn’t given are ignored', async () => {
    const { llm } = realLlm({ drinks: () => msg(answer([{ who: w.quillB.id, confidence: 0.99 }, { who: w.quillA.id, confidence: 0.92 }])) });
    await submit(llm, [occ('drinks')]);
    await collect(llm);
    expect(row('drinks', w.quillB.id)).toBeUndefined();
    expect(row('drinks', w.quillA.id)).toMatchObject({ source: 'llm', status: 'attended', confidence: 0.92 });
  });

  it('"not a get-together" reclassifies the occasion (and the rules don’t flip it back)', async () => {
    const { llm } = realLlm({ games: () => msg(answer([], { is_social: false, kind: 'work' })) });
    await submit(llm, [occ('games')]);
    await collect(llm);
    expect(w.db.prepare('SELECT kind, is_social, classified_by FROM occasions WHERE id = ?').get(occ('games'))).toEqual({ kind: 'work', is_social: 0, classified_by: 'llm' });
    runOccasions(w.db, { now: LATER, timeZone: TZ });
    expect(w.db.prepare('SELECT kind, is_social FROM occasions WHERE id = ?').get(occ('games'))).toEqual({ kind: 'work', is_social: 0 });
    expect(row('games', w.ines.id)).toMatchObject({ status: 'withdrawn' });
  });

  it('a refusal is final on Haiku (no server-side fallback): the request fails without a re-run or touching attendees', async () => {
    const { llm, api } = realLlm({ drinks: () => msg(reply({ stop: 'refusal', category: 'other' })) });
    api.onMessage(() => reply({ json: { attendees: [] } })); // a re-run would get this; there must be none
    await submit(llm, [occ('drinks')]);
    const stats = await collect(llm);
    expect(stats).toMatchObject({ rerun_sync: 0, refused: 1, failed: 1 });
    expect(api.messageRequests).toHaveLength(0);
    expect(w.db.prepare(`SELECT status FROM occasion_adjudications WHERE occasion_id = ?`).pluck().get(occ('drinks'))).toBe('failed');
    expect(row('drinks', w.quillA.id)).toMatchObject({ source: 'calendar_text' });
    expect(ADJUDICATION_PURPOSE).toBe('calendar_adjudication');
  });
});
