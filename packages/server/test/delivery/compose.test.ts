import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { allClearText, composeDigest, digestText, mainLine, minimalText, pushBodyFor } from '../../src/delivery/compose';
import { COMPOSER_SYSTEM } from '../../src/delivery/llmComposer';
import { readDigestSelection } from '../../src/delivery/selection';
import { checkOutboundText, BOT_MARKER } from '../../src/delivery/types';
import { createEgress } from '../../src/llm/egress';
import { newRun, seedIdentity, seedMessage } from '../helpers';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { buildWorld, DAY, DAY_DATE, seedDigest, seedSuggestion, setSettings, typicalDay, zoned, type World } from './world';

const NOW = zoned(DAY_DATE, '07:30');
let w: World;

function agentBatches(kind: string, n: number, at: number): void {
  const runId = newRun(w.db);
  for (let i = 0; i < n; i++) {
    w.db.prepare(`INSERT INTO change_batches (id, run_id, kind, title, actor, created_at) VALUES (?, ?, ?, 'x', 'agent', ?)`).run(uuidv7(), runId, kind, at);
  }
}

function fact(personId: string, type: string, value: string, extra: { sensitive?: boolean } = {}): string {
  const id = uuidv7();
  w.db
    .prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.9, 'confirmed', ?, 'test', ?, ?)`,
    )
    .run(id, personId, type, value, value.toLowerCase(), extra.sensitive ? 1 : 0, NOW - DAY, NOW - DAY, NOW - DAY);
  return id;
}

beforeEach(() => {
  w = buildWorld();
});

describe('template composer', () => {
  it('writes the brief in the digest format: marker first, numbered, short names, ≤70-char lines, one link', async () => {
    typicalDay(w);
    agentBatches('merge', 2, NOW - 5 * 3_600_000);
    agentBatches('attach_identity', 4, NOW - 5 * 3_600_000);
    agentBatches('fact', 11, NOW - 4 * 3_600_000);
    agentBatches('fact', 3, NOW - 3 * DAY); // older than the window
    w.db.prepare(`INSERT INTO source_health (source, status, newest_data_at, checked_at) VALUES ('whatsapp', 'stale', ?, ?)`).run(NOW - 4 * DAY - 3_600_000, NOW);
    const llm = new FakeLlmClient({ configured: false });
    const c = (await composeDigest(w.db, { llm, egress: new FakeEgress() }, { localDate: DAY_DATE, now: NOW }))!;
    expect(c.composer).toBe('template');
    expect(llm.calls).toHaveLength(0);
    expect(c.text.codePointAt(0)).toBe(0x1f168);
    const lines = c.text.split('\n');
    expect(lines[0]).toBe(`${BOT_MARKER} Wed Oct 14 · 4 for today`);
    expect(lines).toContain('1 Ava Q. · quiet 41d (usually ~9d)');
    expect(lines).toContain('2 Ben O. · waiting on your reply, 2d');
    expect(lines).toContain('3 Intro Cleo M. ↔ Dora V.?');
    expect(lines).toContain('4 Something personal — open the app');
    expect(lines).toContain('Last night: 2 merges · 4 links · 11 facts');
    expect(lines).toContain('⚠ WhatsApp quiet 4d · open WhatsApp on your phone');
    expect(lines.filter((l) => /^\d /.test(l)).every((l) => l.length <= 70)).toBe(true);
    expect(c.text.match(/yeackbot\.com/g)).toHaveLength(1);
    expect(c.text).toContain('yeackbot.com/today');
    expect(c.text).not.toMatch(/Quillfeather|Ostrander|Marsh|Vantwerp/);
    expect(checkOutboundText(c.text)).toEqual([]);
    expect(c.pushBody).toBe('Your brief is ready · 4 things');
    // stored on the digest row and the suggestions
    const d = w.db.prepare('SELECT status, composer, imessage_text, composed_at FROM digests WHERE local_date = ?').get(DAY_DATE) as Record<string, unknown>;
    expect(d).toMatchObject({ status: 'ready', composer: 'template', imessage_text: c.text, composed_at: NOW });
    expect(w.db.prepare('SELECT title FROM suggestions WHERE id = ?').pluck().get(c.items[0]!.suggestionId)).toBe('Ava Q. · quiet 41d (usually ~9d)');
  });

  it('push bodies: generic by default, first names only when turned on (never for sensitive items)', () => {
    const p = (first: string, sensitive = false) => ({ people: [{ id: first, firstName: first, lastName: 'Zed', nickname: null, displayName: first, state: null, isPriority: false }], sensitive });
    expect(pushBodyFor([p('Ava'), p('Ben')], false)).toBe('Your brief is ready · 2 things');
    expect(pushBodyFor([p('Ava')], false)).toBe('Your brief is ready · 1 thing');
    expect(pushBodyFor([p('Ava'), p('Ben'), p('Cleo'), p('Dora', true)], true)).toBe('Your brief is ready · Ava & Ben +2');
    expect(pushBodyFor([p('Dora', true)], true)).toBe('Your brief is ready · 1 thing');
  });

  it('a hidden person’s item is dropped; no digest row → nothing to compose; a sent digest is never recomposed', async () => {
    const { ids } = typicalDay(w);
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.dora);
    const sel = readDigestSelection(w.db, { localDate: DAY_DATE, now: NOW })!;
    expect(sel.items.map((i) => i.suggestionId)).toEqual([ids[0], ids[1], ids[3]]);
    expect(sel.droppedHidden).toBe(1);
    const services = { llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() };
    const c = (await composeDigest(w.db, services, { localDate: DAY_DATE, now: NOW }))!;
    expect(c.text).not.toMatch(/Dora|Cleo/);
    expect(c.items.map((i) => i.ordinal)).toEqual([1, 2, 4]);
    expect(await composeDigest(w.db, services, { localDate: '2026-10-15', now: NOW })).toBeNull();
    w.db.prepare(`UPDATE digests SET status = 'sent', sent_at = ? WHERE local_date = ?`).run(NOW, DAY_DATE);
    w.db.prepare('UPDATE people SET is_hidden = 0 WHERE id = ?').run(w.dora);
    const again = (await composeDigest(w.db, services, { localDate: DAY_DATE, now: NOW + 1000 }))!;
    expect(again.text).toBe(c.text);
  });

  it('the fallback texts always pass the outbound rules', () => {
    expect(checkOutboundText(minimalText(DAY_DATE, 3))).toEqual([]);
    expect(checkOutboundText(allClearText(DAY_DATE))).toEqual([]);
    expect(mainLine(5, 'x'.repeat(120), false).length).toBeLessThanOrEqual(70);
    const t = digestText({ localDate: DAY_DATE, items: [], lastNight: null, health: null, commandsEnabled: false });
    expect(t.startsWith(BOT_MARKER)).toBe(true);
  });
});

describe('LLM composer', () => {
  function scripted(egress: FakeEgress, reply: object): FakeLlmClient {
    // FakeEgress hands out tokens in first-use order; the packet uses the same order.
    for (const id of [w.ava, w.ben, w.cleo, w.dora]) egress.tokenFor(id);
    return new FakeLlmClient().on(`digest:${DAY_DATE}`, { json: reply });
  }

  it('one synchronous medium-effort call; grounded items get LLM copy, an invented name falls back to the template', async () => {
    typicalDay(w);
    fact(w.ava, 'location_current', 'Lisbon');
    fact(w.ava, 'other', 'recovering from surgery', { sensitive: true });
    const egress = new FakeEgress();
    const llm = scripted(egress, {
      items: [
        { n: 1, headline: 'P1 · quiet 41 days, usually every 9', body: 'P1 is in Lisbon now.', openers: ['Hey Ava! How is Lisbon treating you?'], cites: ['c1'] },
        { n: 2, headline: 'Reply to Marcus about Saturday', body: null, openers: [], cites: [] },
        { n: 3, headline: 'Intro P3 ↔ P4?', body: null, openers: [], cites: [] },
      ],
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0]!;
    // The digest_compose route: Haiku 5.5, effort low, thinking off, no fallbacks (none exist on Haiku).
    expect(call).toMatchObject({ method: 'parse', kind: 'digest', route: 'digest_compose', subjectRef: DAY_DATE, effort: 'low', thinking: 'disabled', fallbacks: false, system: COMPOSER_SYSTEM });
    // The packet: three eligible items (the sensitive one never leaves), no sensitive facts, no last names.
    expect(call.userText).toContain('### item 3');
    expect(call.userText).not.toContain('### item 4');
    expect(call.userText).toContain('Lisbon');
    expect(call.userText).not.toMatch(/surgery|Quillfeather|Ostrander/);
    expect(COMPOSER_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    expect(c.items.map((i) => i.copy)).toEqual(['llm', 'template', 'llm', 'template']);
    expect(c.composer).toBe('llm');
    expect(c.items[0]).toMatchObject({ headline: 'Ava Q. · quiet 41 days, usually every 9', body: 'Ava Q. is in Lisbon now.', openers: ['Hey Ava! How is Lisbon treating you?'] });
    expect(c.items[1]!.headline).toBe('Ben O. · waiting on your reply, 2d');
    expect(c.items[2]!.headline).toBe('Intro Cleo M. ↔ Dora V.?');
    expect(c.text).toContain('1 Ava Q. · quiet 41 days, usually every 9');
    expect(c.text).toContain('  ↳ "Hey Ava! How is Lisbon treating you?"');
    expect(c.text).not.toContain('Marcus');
    expect(checkOutboundText(c.text)).toEqual([]);
    const d = w.db.prepare('SELECT composer, llm_usage FROM digests WHERE local_date = ?').get(DAY_DATE) as { composer: string; llm_usage: string };
    expect(d.composer).toBe('llm');
    expect(JSON.parse(d.llm_usage)).toMatchObject({ status: 'ok', sent: 3, rejected: 1 });
    expect(JSON.parse(w.db.prepare('SELECT openers FROM suggestions WHERE id = ?').pluck().get(c.items[0]!.suggestionId) as string)).toEqual(['Hey Ava! How is Lisbon treating you?']);
  });

  it('refusal, invalid output, no key, budget or an egress that isn’t ready → the whole brief stays template', async () => {
    typicalDay(w);
    const run = async (llm: FakeLlmClient, egress = new FakeEgress()) => (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    const refused = await run(new FakeLlmClient().on('digest', { refusal: 'other' }));
    expect(refused.composer).toBe('template');
    expect(refused.llm).toMatchObject({ status: 'refused' });
    expect((await run(new FakeLlmClient().on('digest', { text: 'not json' }))).llm).toMatchObject({ status: 'invalid' });
    const noKey = new FakeLlmClient({ configured: false });
    expect((await run(noKey)).llm).toMatchObject({ status: 'unavailable', reason: 'no_key' });
    expect(noKey.calls).toHaveLength(0);
    const broke = new FakeLlmClient({ budget: { steady: 1, backfill: null } }).addSpend('steady', 2);
    expect((await run(broke)).llm).toMatchObject({ status: 'unavailable', reason: 'budget_daily' });
    const stub = new FakeLlmClient();
    const blocked = await run(stub, createEgress(null) as unknown as FakeEgress);
    expect(blocked.llm).toMatchObject({ status: 'unavailable', reason: 'egress_blocked' });
    expect(stub.calls).toHaveLength(0);
    setSettings(w.db, { 'llm.enabled': false });
    const off = new FakeLlmClient();
    expect((await run(off)).llm).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(off.calls).toHaveLength(0);
  });

  it('works through the real egress pseudonymizer (stable P-tokens, de-tokenized locally)', async () => {
    typicalDay(w);
    const egress = createEgress(w.db);
    const [ta, tc, td] = [egress.tokenFor(w.ava), egress.tokenFor(w.cleo), egress.tokenFor(w.dora)];
    const llm = new FakeLlmClient().on(`digest:${DAY_DATE}`, {
      json: {
        items: [
          { n: 1, headline: `Check in with ${ta} — quiet 41 days`, body: null, openers: [], cites: [] },
          { n: 3, headline: `Intro ${tc} ↔ ${td}?`, body: null, openers: [], cites: [] },
        ],
      },
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(llm.calls[0]!.userText).toContain(`person: ${ta}`);
    expect(llm.calls[0]!.userText).not.toMatch(/Quillfeather|Ostrander/);
    expect(c.items.map((i) => i.copy)).toEqual(['llm', 'template', 'llm', 'template']);
    expect(c.items[0]!.headline).toBe('Check in with Ava Q. — quiet 41 days');
    expect(c.items[2]!.headline).toBe('Intro Cleo M. ↔ Dora V.?');
  });

  it('quotes come from the item’s evidence messages, scrubbed; extra attendees beyond a hidden one stay', async () => {
    const ident = seedIdentity(w.db, w.ava, 'phone', '+12025550142');
    const m1 = seedMessage(w.db, ident, 'moving to Lisbon next month! call me 202-555-0187 or ava@example.com');
    const sid = seedSuggestion(w.db, { kind: 'memory', personId: w.ava, signals: {} });
    w.db.prepare('UPDATE suggestions SET person_ids = ?, evidence_ids = ? WHERE id = ?').run(JSON.stringify([w.ava, w.ben, w.dora]), JSON.stringify([`m:${m1}`]), sid);
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.dora);
    seedDigest(w.db, DAY_DATE, [sid]);
    const egress = new FakeEgress();
    const llm = scripted(egress, { items: [] });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(c.items[0]!.people.map((p) => p.id)).toEqual([w.ava, w.ben]);
    expect(c.items[0]!.headline).toBe('A year ago: a day together with Ava Q. & Ben O.');
    const packet = llm.calls[0]!.userText;
    expect(packet).toMatch(/\[c1\] message .*moving to Lisbon next month!/);
    expect(packet).not.toMatch(/555|example\.com|Dora/);
  });

  it('a sensitive promise never enters the packet or the text, even for a non-sensitive item about that person', async () => {
    typicalDay(w);
    const ins = (what: string, sensitive: number) =>
      w.db
        .prepare(
          `INSERT INTO commitments (id, person_id, owner, kind, what, due_end, due_precision, confidence, status, sensitive, created_at, updated_at)
           VALUES (?, ?, 'me', 'meet', ?, ?, 'date', 0.9, 'open', ?, ?, ?)`,
        )
        .run(uuidv7(), w.ava, what, NOW + DAY, sensitive, NOW - DAY, NOW - DAY);
    ins('go with her to the appointment Thursday', 1);
    ins('send the trail map', 0);
    const egress = new FakeEgress();
    const llm = scripted(egress, {
      items: [{ n: 1, headline: 'P1 · quiet 41 days', body: 'P1 is waiting on the trail map.', openers: [], cites: [] }],
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(llm.calls[0]!.userText).toContain('send the trail map');
    expect(llm.calls[0]!.userText).not.toMatch(/appointment/);
    expect(c.text).not.toMatch(/appointment/);
  });

  it('people in llm.excluded_person_ids never enter the packet', async () => {
    typicalDay(w);
    setSettings(w.db, { 'llm.excluded_person_ids': [w.ava] });
    const egress = new FakeEgress();
    const llm = scripted(egress, { items: [] });
    await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW });
    expect(llm.calls[0]!.userText).not.toContain('first name Ava');
    expect(llm.calls[0]!.userText).toContain('first name Ben');
  });
});
