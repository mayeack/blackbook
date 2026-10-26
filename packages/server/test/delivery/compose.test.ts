import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { allClearText, composeDigest, digestTexts, joinTexts, mainLine, minimalText, pushBodyFor, textParts } from '../../src/delivery/compose';
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
  it('writes the whole brief in one text, like a person would: marker first, numbered, short names, one link', async () => {
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
    expect(c.texts).toEqual([
      [
        `${BOT_MARKER} Good morning! 4 things for today.`,
        '',
        '1. Check in with Ava Q.',
        "It's been 6 weeks. You usually talk about once a week.",
        '',
        '2. Reply to Ben O.',
        'Ben has been waiting 2 days for an answer.',
        '',
        '3. Introduce Cleo M. and Dora V.?',
        'They might get along.',
        '',
        '4. Something personal',
        'The details are in the app.',
        '',
        "Heads up: WhatsApp hasn't synced in 4 days. Open WhatsApp on your phone to wake it up.",
        '',
        `That's it! Reply "done 2", "skip 2" or "snooze 2" anytime.`,
        'yeackbot.com/today',
      ].join('\n'),
    ]);
    // One text for the whole brief: an inline reply to it names no item on its own.
    expect(c.parts).toEqual([null]);
    for (const t of c.texts) {
      expect(t.codePointAt(0)).toBe(0x1f168);
      expect(checkOutboundText(t)).toEqual([]);
      expect(t).not.toContain(' · ');
    }
    expect(c.items.every((i) => i.line.length <= 70)).toBe(true);
    expect(c.text).toBe(joinTexts(c.texts));
    expect(c.text.match(/yeackbot\.com/g)).toHaveLength(1);
    expect(c.text).not.toMatch(/Quillfeather|Ostrander|Marsh|Vantwerp/);
    // The overnight counts stay on the web.
    expect(c.lastNight).toBe('Last night: 2 merges · 4 links · 11 facts');
    expect(c.text).not.toContain('Last night');
    expect(c.pushBody).toBe('Your brief is ready · 4 things');
    // stored on the digest row and the suggestions
    const d = w.db.prepare('SELECT status, composer, imessage_text, composed_at FROM digests WHERE local_date = ?').get(DAY_DATE) as Record<string, unknown>;
    expect(d).toMatchObject({ status: 'ready', composer: 'template', imessage_text: c.text, composed_at: NOW });
    expect(w.db.prepare('SELECT title FROM suggestions WHERE id = ?').pluck().get(c.items[0]!.suggestionId)).toBe('Check in with Ava Q.');
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
    expect(checkOutboundText(minimalText(3))).toEqual([]);
    expect(checkOutboundText(allClearText())).toEqual([]);
    expect(mainLine(5, 'x'.repeat(120), false).length).toBeLessThanOrEqual(70);
    expect(digestTexts({ items: [], health: null, commandsEnabled: false })).toEqual([]);
    const one = digestTexts({ items: [{ ordinal: 1, line: '1. Reply to Sam R.', copy: 'template', body: null, openers: [], sensitive: false }], health: null, commandsEnabled: true, digestTime: '18:00' });
    expect(one).toEqual([`${BOT_MARKER} Evening! Just one thing today.\n\n1. Reply to Sam R.\n\nThat's it! Reply "done", "skip" or "snooze" anytime.\nyeackbot.com/today`]);
    expect(textParts([{ suggestionId: 's1', ordinal: 1 }], one)).toEqual([{ suggestionId: 's1', ordinal: 1 }]);
    expect(textParts([{ suggestionId: 's1', ordinal: 1 }, { suggestionId: 's2', ordinal: 2 }], ['x'])).toEqual([null]);
    // A day with nothing but a health line is just that line.
    expect(digestTexts({ items: [], health: 'Heads up: x.', commandsEnabled: true })).toEqual([`${BOT_MARKER} Heads up: x.`]);
  });

  it('an item whose copy breaks an outbound rule falls back on its own; the rest of the brief still goes', async () => {
    typicalDay(w);
    const egress = new FakeEgress();
    for (const id of [w.ava, w.ben, w.cleo, w.dora]) egress.tokenFor(id);
    // An opener that would put a phone number in the text: the grounding validator lets openers through, the
    // outbound rules don't, so item 1 falls back to its template copy.
    const llm = new FakeLlmClient().on(`digest:${DAY_DATE}`, {
      json: { items: [{ n: 1, headline: 'Check in with P1', body: null, openers: ['call me at 2025550199'], cites: ['c1'] }] },
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(c.texts[0]).toContain('1. Check in with Ava Q.');
    expect(c.texts[0]).not.toContain('555');
    for (const t of c.texts) expect(checkOutboundText(t)).toEqual([]);
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
        { n: 1, headline: 'Ask P1 how Lisbon is going', body: 'P1 is in Lisbon now.', openers: ['Hey Ava! How is Lisbon treating you?'], cites: ['c1'] },
        { n: 2, headline: 'Reply to Marcus about Saturday', body: null, openers: [], cites: [] },
        { n: 3, headline: 'Introduce P3 and P4?', body: null, openers: [], cites: [] },
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
    expect(c.items[0]).toMatchObject({ headline: 'Ask Ava Q. how Lisbon is going', body: 'Ava Q. is in Lisbon now.', openers: ['Hey Ava! How is Lisbon treating you?'] });
    expect(c.items[1]!.headline).toBe('Reply to Ben O.');
    expect(c.items[2]!.headline).toBe('Introduce Cleo M. and Dora V.?');
    expect(c.texts[0]).toContain(
      `${BOT_MARKER} Good morning! 4 things for today.\n\n1. Ask Ava Q. how Lisbon is going\nAva Q. is in Lisbon now.\nMaybe: “Hey Ava! How is Lisbon treating you?”\n\n2. Reply to Ben O.\n`,
    );
    expect(c.text).not.toContain('Marcus');
    for (const t of c.texts) expect(checkOutboundText(t)).toEqual([]);
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
          { n: 1, headline: `Check in with ${ta}`, body: null, openers: [], cites: [] },
          { n: 3, headline: `Introduce ${tc} and ${td}?`, body: null, openers: [], cites: [] },
        ],
      },
    });
    const c = (await composeDigest(w.db, { llm, egress }, { localDate: DAY_DATE, now: NOW }))!;
    expect(llm.calls[0]!.userText).toContain(`person: ${ta}`);
    expect(llm.calls[0]!.userText).not.toMatch(/Quillfeather|Ostrander/);
    expect(c.items.map((i) => i.copy)).toEqual(['llm', 'template', 'llm', 'template']);
    expect(c.items[0]!.headline).toBe('Check in with Ava Q.');
    expect(c.items[2]!.headline).toBe('Introduce Cleo M. and Dora V.?');
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
    expect(c.items[0]!.headline).toBe('A year ago today with Ava Q. and Ben O.');
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
      items: [{ n: 1, headline: 'Check in with P1', body: 'P1 is waiting on the trail map.', openers: [], cites: [] }],
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
