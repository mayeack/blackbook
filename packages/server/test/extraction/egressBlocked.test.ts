/**
 * The egress scanner fails closed per request, never per job (the 2026-10-16 incident: one backfill window with
 * back-to-back @handles threw out of pseudonymize(), stopped the backfill build half-way, and every extract-collect
 * failed on it from then on). Fakes and synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { collect, startBackfill, submitSteady, type ExtractionDeps } from '../../src/extraction/run';
import { createWindow, uncoveredMessages } from '../../src/extraction/windows';
import { createEgress } from '../../src/llm/egress';
import type { Egress } from '../../src/llm/types';
import { FakeEgress } from '../fakes/llm';
import { ADJACENT_HANDLES, DAY, HOUR, MIN, NOW, StrictEgress, buildXWorld, deps, extraction, fakes, windowsOf, type XWorld } from './world';

const count = (w: XWorld, sql: string, ...p: unknown[]) => w.db.prepare(sql).pluck().get(...p) as number;
const RAW_HANDLE = /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{2,30}\b/;

/** The record a blocked request leaves: a skipped item, its window dead-lettered, one open alert. */
function blockedItems(w: XWorld): { kind: string; window_id: string | null; person_id: string | null; attempt: number; custom_id: string; batch_id: string | null }[] {
  return w.db
    .prepare(`SELECT kind, window_id, person_id, attempt, custom_id, batch_id FROM extraction_items WHERE status = 'skipped' AND outcome = 'egress_blocked' ORDER BY created_at`)
    .all() as never;
}
const openAlerts = (w: XWorld) => w.db.prepare(`SELECT source FROM alerts WHERE resolved_at IS NULL`).pluck().all() as string[];

/** Old DM history (July) and old group history (August, with back-to-back handles); the group is the newer one. */
function history(w: XWorld) {
  const jul = Date.UTC(2026, 6, 6, 20);
  const aug = Date.UTC(2026, 7, 10, 20);
  w.msg(w.dm, w.ids.sam, jul, 'I just moved to Austin, the heat is unreal but I love it');
  w.msg(w.dm, null, jul + 5 * MIN, 'welcome to Texas! lets grab tacos when I am in town');
  w.msg(w.group, w.ids.jordan, aug, `new crag this weekend, follow ${ADJACENT_HANDLES} for the beta`);
  w.msg(w.group, w.ids.priya, aug + 5 * MIN, 'I am in, can someone bring the spare rope please');
}

function realDeps(w: XWorld, f: ReturnType<typeof fakes>, egress: Egress, now = NOW): ExtractionDeps {
  return { ...deps(w, f, now), egress };
}

describe('egress blocks are per request', () => {
  it('root cause: back-to-back @handles now pseudonymize (real egress), so the backfill builds and goes out whole', async () => {
    const w = buildXWorld();
    history(w);
    const f = fakes();
    const rep = await startBackfill(realDeps(w, f, createEgress(w.db)));
    expect(rep.status).toBe('running');
    const batch = f.llm.calls.filter((c) => c.method === 'batch');
    expect(batch).toHaveLength(2);
    const group = batch.find((c) => c.userText.includes('new crag'))!;
    expect(group.userText).toContain('follow <handle><handle> for the beta');
    for (const c of batch) expect(c.userText).not.toMatch(RAW_HANDLE);
    expect(blockedItems(w)).toEqual([]);
  });

  it('a window whose packet egress refuses at render is skipped; the rest of the backfill goes out and collect never throws', async () => {
    const w = buildXWorld();
    history(w);
    const f = fakes({}, new StrictEgress());
    const rep = await startBackfill(deps(w, f));
    expect(rep.status).toBe('running');
    expect(rep.counts.egress_blocked).toBe(1);
    // The group's window was never sent; the DM's was.
    const [groupWin] = windowsOf(w.db, w.group);
    expect(groupWin).toMatchObject({ mode: 'historical', status: 'dead_letter' });
    expect(windowsOf(w.db, w.dm).map((x) => x.status)).toEqual(['submitted']);
    const batch = f.llm.calls.filter((c) => c.method === 'batch');
    expect(batch).toHaveLength(1);
    expect(batch[0]!.userText).toContain('moved to Austin');
    expect(blockedItems(w)).toEqual([{ kind: 'historical', window_id: groupWin!.id, person_id: null, attempt: 0, custom_id: expect.stringMatching(/^h[0-9a-f]+-[0-9a-f]+-0$/), batch_id: null }]);
    expect(openAlerts(w)).toContain('extraction:egress_blocked');
    // Its messages stay covered by the blocked window (never rebuilt and blocked again).
    expect(count(w, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', groupWin!.id)).toBe(2);
    expect(count(w, `SELECT count(*) FROM extraction_backfill WHERE json_extract(stats, '$.built_at') IS NOT NULL`)).toBe(1);

    const c1 = await collect(deps(w, f, NOW + 10 * MIN));
    expect(c1.status).toBe('ok');
    expect(c1.counts).toMatchObject({ applied: 1, backfill_done: 1 });
    expect((await collect(deps(w, f, NOW + 20 * MIN))).status).toBe('skipped');
  });

  it('the stuck 2026-10-16 state (build stopped at an unrendered window) resumes on the next collect', async () => {
    for (const egress of ['real', 'strict'] as const) {
      const w = buildXWorld();
      history(w);
      // What the old code left behind: a running backfill without built_at, steady state for the conversation it
      // got to, one pending window over that conversation's history with no packet, and the DM never built.
      const through = NOW - 2 * DAY;
      w.db
        .prepare(`INSERT INTO extraction_backfill (id, status, through_at, started_at, updated_at) VALUES ('bf-legacy', 'running', ?, ?, ?)`)
        .run(through, NOW - DAY, NOW - DAY);
      w.db.prepare('INSERT INTO extraction_conv_state (conversation_id, steady_since_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run(w.group, through, NOW - DAY, NOW - DAY);
      const msgs = uncoveredMessages(w.db, w.group, { before: through });
      const stuck = createWindow(w.db, { conversationId: w.group, mode: 'historical', messages: msgs, wave: 1, status: 'pending', tokens: 60, now: NOW - DAY });
      expect(windowsOf(w.db, w.dm)).toEqual([]);

      const f = fakes();
      const eg = egress === 'real' ? createEgress(w.db) : new StrictEgress();
      const c1 = await collect(realDeps(w, f, eg));
      expect(c1.status).toBe('ok');
      // The DM's history was built after all, and went out with whatever could be sent.
      expect(windowsOf(w.db, w.dm).map((x) => x.status)).toEqual(['submitted']);
      const batch = f.llm.calls.filter((c) => c.method === 'batch');
      if (egress === 'real') {
        expect(windowsOf(w.db, w.group).find((x) => x.id === stuck)!.status).toBe('submitted');
        expect(batch).toHaveLength(2);
        expect(batch.find((c) => c.userText.includes('new crag'))!.userText).toContain('<handle><handle>');
      } else {
        expect(windowsOf(w.db, w.group).find((x) => x.id === stuck)!.status).toBe('dead_letter');
        expect(blockedItems(w).map((i) => i.window_id)).toEqual([stuck]);
        expect(batch).toHaveLength(1);
      }
      expect(count(w, `SELECT count(*) FROM extraction_backfill WHERE json_extract(stats, '$.built_at') IS NOT NULL`)).toBe(1);
      // The next collect applies the results and finishes; nothing is rebuilt.
      const c2 = await collect(realDeps(w, f, eg, NOW + 10 * MIN));
      expect(c2.status).toBe('ok');
      expect(c2.counts.backfill_done).toBe(1);
      expect(count(w, `SELECT count(*) FROM windows WHERE mode = 'historical'`)).toBe(2);
    }
  });

  it('a user turn still holding a raw handle is left out of the batch; the other windows go out', async () => {
    const w = buildXWorld();
    w.msg(w.dm, w.ids.sam, NOW - 6 * HOUR, 'big news, I took the job at Lumen Labs and I am moving to Denver');
    w.msg(w.group, w.ids.jordan, NOW - 5 * HOUR, `trip photos are up, tag ${ADJACENT_HANDLES} if you post any`);
    // The plain fake's one-pass scrub leaves "<handle>@summit_crew" in the user turn (it never throws).
    const f = fakes({}, new FakeEgress());
    const rep = await submitSteady(deps(w, f));
    expect(rep.status).toBe('ok');
    expect(rep.counts).toMatchObject({ windows: 2, submitted: 1, batches: 1, egress_blocked: 1 });
    const batch = f.llm.calls.filter((c) => c.method === 'batch');
    // The dm window's two requests (knowledge + obligations); without the per-request check the client refuses
    // the whole batch.
    expect(batch).toHaveLength(2);
    expect(new Set(batch.map((c) => c.subjectRef)).size).toBe(1);
    for (const c of batch) expect(c.userText).toContain('Lumen Labs');
    const [groupWin] = windowsOf(w.db, w.group);
    expect(groupWin!.status).toBe('dead_letter');
    expect(blockedItems(w)).toEqual([{ kind: 'extract', window_id: groupWin!.id, person_id: null, attempt: 0, custom_id: expect.stringMatching(/-0$/), batch_id: null }]);
    // Covered: tomorrow's submit doesn't rebuild it.
    const again = await submitSteady(deps(w, f, NOW + DAY));
    expect(again.counts.windows ?? 0).toBe(0);
  });

  it('a split follow-up whose re-render meets an @handle is skipped; the rest of that batch is applied', async () => {
    const w = buildXWorld();
    const t0 = NOW - 9 * HOUR;
    // Two sessions in the DM (a gap to split at) and one group window.
    w.msg(w.dm, w.ids.sam, t0, 'big news, I took the job at Lumen Labs and I am moving to Denver');
    w.msg(w.dm, null, t0 + 2 * MIN, 'whoa congrats!! we need to celebrate before you go');
    w.msg(w.dm, w.ids.sam, t0 + 5 * HOUR, 'dinner thursday works, I will book the place by the park');
    w.msg(w.dm, null, t0 + 5 * HOUR + 2 * MIN, 'perfect, see you there at seven');
    w.msg(w.group, w.ids.jordan, t0 + HOUR, 'who is in for the gym on saturday morning this week');
    const f = fakes({}, new StrictEgress());
    await submitSteady(deps(w, f));
    const [dmWin] = windowsOf(w.db, w.dm);
    const [groupWin] = windowsOf(w.db, w.group);
    f.llm.on(`extract:${dmWin!.id}`, { maxTokens: true });
    f.llm.on(`extract:${groupWin!.id}`, { batchError: 'other' }, { json: extraction() });
    // Collect 1: the DM goes back at ×2 tokens, the group is retried now (03:30) — both in one batch.
    const c1 = await collect(deps(w, f, NOW + 10 * MIN));
    expect(c1.counts).toMatchObject({ requeued_max_tokens: 1, requeued_errored: 1, resubmitted: 2 });
    // Meanwhile the DM's rolling summary picked up back-to-back handles: the split halves re-render with it.
    w.db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(`Planning a dinner; Sam shared ${ADJACENT_HANDLES} for the venue.`, w.dm);
    const c2 = await collect(deps(w, f, NOW + 20 * MIN));
    expect(c2.status).toBe('ok');
    expect(c2.counts).toMatchObject({ applied: 1, split: 1, egress_blocked: 2 });
    expect(windowsOf(w.db, w.group).map((x) => x.status)).toEqual(['applied']);
    const dm = windowsOf(w.db, w.dm);
    expect(dm.map((x) => x.status).sort()).toEqual(['dead_letter', 'dead_letter', 'split']);
    expect(blockedItems(w)).toHaveLength(2);
    for (const c of f.llm.calls) expect(c.userText).not.toMatch(RAW_HANDLE);
    expect((await collect(deps(w, f, NOW + 30 * MIN))).status).toBe('skipped');

    // With the real egress the same follow-up renders: both halves go out with <handle><handle>.
    const r = buildXWorld();
    r.msg(r.dm, r.ids.sam, t0, 'big news, I took the job at Lumen Labs and I am moving to Denver');
    r.msg(r.dm, null, t0 + 2 * MIN, 'whoa congrats!! we need to celebrate before you go');
    r.msg(r.dm, r.ids.sam, t0 + 5 * HOUR, 'dinner thursday works, I will book the place by the park');
    r.msg(r.dm, null, t0 + 5 * HOUR + 2 * MIN, 'perfect, see you there at seven');
    const g = fakes();
    const real = createEgress(r.db);
    await submitSteady(realDeps(r, g, real));
    const [rw] = windowsOf(r.db, r.dm);
    g.llm.on(`extract:${rw!.id}`, { maxTokens: true });
    await collect(realDeps(r, g, real, NOW + 10 * MIN));
    r.db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(`Planning a dinner; Sam shared ${ADJACENT_HANDLES} for the venue.`, r.dm);
    const rc = await collect(realDeps(r, g, real, NOW + 20 * MIN));
    expect(rc.counts).toMatchObject({ split: 1, resubmitted: 2 });
    expect(rc.counts.egress_blocked).toBeUndefined();
    const halves = g.llm.calls.filter((c) => c.method === 'batch').slice(-2);
    for (const c of halves) expect(c.userText).toContain('Sam shared <handle><handle> for the venue.');
  });

  it('a consolidation request egress refuses skips that person only; the backfill still finishes', async () => {
    const w = buildXWorld();
    const ins = w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, 'interest', ?, ?, 0.9, 'confirmed', ?, 'test', ?, ?)`,
    );
    const hobbies = ['pottery', 'jazz piano', 'hiking', 'board games', 'surfing', 'film photography', 'chess', 'baking'];
    hobbies.forEach((h, i) => {
      const samValue = i === 0 ? `pottery (posts as ${ADJACENT_HANDLES})` : h;
      ins.run(`f-sam-${i}`, w.sam, samValue, h, NOW - DAY, NOW - DAY, NOW - DAY);
      ins.run(`f-jordan-${i}`, w.jordan, h, h, NOW - DAY, NOW - DAY, NOW - DAY);
    });
    w.db
      .prepare(`INSERT INTO extraction_backfill (id, status, through_at, stats, started_at, updated_at) VALUES ('bf-1', 'running', ?, ?, ?, ?)`)
      .run(NOW - 2 * DAY, JSON.stringify({ built_at: NOW - DAY }), NOW - DAY, NOW - DAY);
    const f = fakes({}, new StrictEgress());
    const c1 = await collect(deps(w, f));
    expect(c1.status).toBe('ok');
    expect(c1.counts.backfill_consolidating).toBe(1);
    const sent = f.llm.calls.filter((c) => c.method === 'batch');
    expect(sent.map((c) => c.subjectRef)).toEqual([w.jordan]);
    expect(blockedItems(w)).toEqual([{ kind: 'consolidate', window_id: null, person_id: w.sam, attempt: 0, custom_id: expect.stringMatching(/-0$/), batch_id: null }]);
    const c2 = await collect(deps(w, f, NOW + 10 * MIN));
    expect(c2.counts).toMatchObject({ consolidated: 1, backfill_done: 1 });
  });
});
