import { describe, expect, it } from 'vitest';
import type { AskEvent } from '@yb/shared';
import { askNetwork, getConversation, NEEDS_KEY_MESSAGE } from '../../src/ask';
import { shortDate } from '../../src/ask/citations';
import { asksForPeople } from '../../src/ask/degraded';
import { ASK_PROMPT_VERSION, ASK_SYSTEM_PROMPT } from '../../src/ask/prompt';
import { eventRef, factRef, messageRef } from '../../src/ask/refs';
import { docNumber } from '../../src/ask/fts';
import { createEgress } from '../../src/llm/egress';
import type { Egress } from '../../src/llm/types';
import { createLogger, type LogRecord } from '../../src/ops/logger';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient, type FakeReply } from '../fakes/llm';
import { T0 } from '../helpers';
import { buildAskWorld, DAY, NOW } from './world';

const TZ = 'America/Los_Angeles';
/** "last contact Oct 14": Sam's last contact is T0, Jess's T0 + 1 day (world.ts). */
const LAST_SAM = `last contact ${shortDate(T0, NOW, TZ)}`;
const LAST_JESS = `last contact ${shortDate(T0 + DAY, NOW, TZ)}`;

function services(llm: FakeLlmClient, egress: Egress = new FakeEgress()): AgentServices {
  return { llm, egress, outbound: new FakeOutboundSender(), push: new FakePushSender() };
}

function setup(...replies: FakeReply[]) {
  const w = buildAskWorld();
  const egress = new FakeEgress();
  const sam = egress.tokenFor(w.sam);
  const jess = egress.tokenFor(w.jess);
  const llm = new FakeLlmClient();
  if (replies.length) llm.on('ask', ...replies);
  const svc = services(llm, egress);
  const records: LogRecord[] = [];
  const log = createLogger([(r) => records.push(r)], 'debug');
  return { w, egress, sam, jess, llm, svc, log, records };
}

const SEARCH_AUSTIN = { name: 'search_people', input: { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: null } };

describe('askNetwork (web)', () => {
  it('runs the tool loop, strips uncited ids, de-tokenizes, resolves citations, streams events, stores the turn', async () => {
    const t = setup();
    const fAustin = factRef(t.w.facts.samAustin);
    const fJess = factRef(t.w.facts.jessAustin);
    t.llm.on('ask', {
      toolCalls: [SEARCH_AUSTIN, { name: 'get_person', input: { ref: t.sam } }],
      then: { text: `${t.sam} lives in Austin [${fAustin}][F9z9] and so does ${t.jess} [${fJess}]. ${t.sam} said hi [m:zz9]. Climbing buddies [${t.sam}].` },
    });
    const events: AskEvent[] = [];
    const out = await askNetwork({ db: t.w.db, question: 'Who do I know in Austin?', channel: 'web', onEvent: (e) => events.push(e), services: () => t.svc, log: t.log, now: NOW });

    expect(out.degraded).toBe(false);
    expect(out.error).toBeNull();
    expect(out.answer).toBe(`Sam Rivera lives in Austin [${fAustin}] and so does Jess Kim [${fJess}]. Sam Rivera said hi. Climbing buddies [${t.sam}].`);
    expect(out.citations.map((c) => c.ref)).toEqual([fAustin, fJess, t.sam]);
    expect(out.citations[0]).toMatchObject({ kind: 'fact', label: expect.stringMatching(/^Sam — lives in Austin, TX \(since /), href: `/p/${t.w.sam}` });
    expect(out.citations[2]).toMatchObject({ kind: 'person', label: 'Sam Rivera', href: `/p/${t.w.sam}` });
    expect(out.people.map((p) => p.id)).toEqual([t.w.sam, t.w.jess]);
    expect(out.list).toBeNull(); // prose, not one line per person
    expect(out.usage).toMatchObject({ toolCalls: 2, inputTokens: 1000, outputTokens: 200 });

    // The call: kind ask on the ask_web route (Haiku, effort low, adaptive thinking, no fallbacks), the byte-stable
    // system prompt, a pseudonymized user turn.
    const call = t.llm.calls[0]!;
    expect(call).toMatchObject({ method: 'runTools', kind: 'ask', route: 'ask_web', effort: 'low', thinking: 'adaptive', fallbacks: false, system: ASK_SYSTEM_PROMPT, subjectRef: out.turnId });
    expect(call.userText).toContain('### question\nWho do I know in Austin?');
    expect(call.userText).toContain('Channel: web app');
    expect(ASK_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // Events: start first, tool statuses with counts, streamed deltas, citations — never message text in statuses.
    expect(events[0]).toEqual({ type: 'start', conversationId: out.conversationId, turnId: out.turnId });
    const statuses = events.filter((e) => e.type === 'tool_status');
    expect(statuses).toEqual([
      { type: 'tool_status', tool: 'search_people', status: 'running', summary: 'Searching people in Austin', count: null },
      { type: 'tool_status', tool: 'search_people', status: 'done', summary: 'Found 2 people', count: 2 },
      { type: 'tool_status', tool: 'get_person', status: 'running', summary: 'Looking at Sam R.', count: null },
      { type: 'tool_status', tool: 'get_person', status: 'done', summary: 'Read the profile', count: 1 },
    ]);
    const streamed = events.filter((e): e is Extract<AskEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
    expect(streamed).toBe(out.answer);
    expect(events.filter((e) => e.type === 'citation').map((e) => (e as Extract<AskEvent, { type: 'citation' }>).citation.ref)).toEqual([fAustin, fJess, t.sam]);

    // Stored for the conversation history; the violation is logged as a count only.
    const conv = getConversation(t.w.db, out.conversationId!)!;
    expect(conv.title).toBe('Who do I know in Austin?');
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0]).toMatchObject({ status: 'done', answer: out.answer, channel: 'web' });
    const row = t.w.db.prepare('SELECT violations, tool_calls, prompt_version, model_answer FROM ask_turns WHERE id = ?').get(out.turnId) as Record<string, unknown>;
    expect(row).toMatchObject({ violations: 2, tool_calls: 2, prompt_version: ASK_PROMPT_VERSION.web });
    expect(row.model_answer).toContain(`${t.sam} lives in Austin`);
    expect(t.records.find((r) => r.event === 'ask.citation_violation')?.counts).toEqual({ stripped: 2 });
    expect(JSON.stringify(t.records)).not.toMatch(/Austin|Rivera|Who do I know/);
  });

  it('a follow-up replays the earlier turn (tokens, not names) and may re-cite its ids', async () => {
    const t = setup();
    const fAustin = factRef(t.w.facts.samAustin);
    t.llm.on('ask', { toolCalls: [SEARCH_AUSTIN], then: { text: `${t.sam} lives in Austin [${fAustin}].` } }, { text: `Yes — ${t.sam} is still in Austin [${fAustin}].` });
    const first = await askNetwork({ db: t.w.db, question: 'Does Jess Kim know anyone in Austin?', channel: 'web', services: () => t.svc, now: NOW });
    const second = await askNetwork({ db: t.w.db, question: 'Is Sam still there?', channel: 'web', conversationId: first.conversationId, services: () => t.svc, now: NOW + 1000 });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.answer).toBe(`Yes — Sam Rivera is still in Austin [${fAustin}].`);
    const userText = t.llm.calls[1]!.userText;
    expect(userText).toContain('### earlier_in_this_conversation');
    expect(userText).toContain(`A: ${t.sam} lives in Austin [${fAustin}].`);
    expect(userText).toContain(`${t.sam} Sam R. (strength 72), Austin`); // the question names Sam
    expect(userText).not.toContain('Rivera');
    expect(userText).toContain('Q: Does Jess K. know anyone in Austin?'); // the earlier question's names are cut too
    expect(userText).not.toContain('Kim');
    expect(getConversation(t.w.db, first.conversationId!)!.turns).toHaveLength(2);
  });

  it('events and messages cite with base36 ids and resolve to deep links', async () => {
    const t = setup();
    const e = eventRef(docNumber(t.w.db, 'occasion', t.w.occasions.friendsgiving));
    const m = messageRef(t.w.msgs.climbRopes);
    t.llm.on('ask', {
      toolCalls: [
        { name: 'list_events', input: { after: null, before: null, person_ref: t.sam, query: 'potluck' } },
        { name: 'search_messages', input: { query: 'ropes', person_ref: null, conv_id: null, after: null, before: null, limit: 5 } },
      ],
      then: { text: `You both went to the potluck [${e}]; ${t.jess} asked about ropes [${m}].` },
    });
    const out = await askNetwork({ db: t.w.db, question: 'What did we do together?', channel: 'web', services: () => t.svc, now: NOW });
    expect(out.citations).toEqual([
      expect.objectContaining({ ref: e, kind: 'event', label: expect.stringMatching(/^Friendsgiving potluck · /), href: `/e/${t.w.occasions.friendsgiving}` }),
      expect.objectContaining({ ref: m, kind: 'message', label: expect.stringMatching(/^Jess · iMessage in Climbing crew /), href: `/p/${t.w.jess}?m=${t.w.msgs.climbRopes}` }),
    ]);
  });

  it('without an API key answers retrieval-only, says the key is needed, and sends nothing', async () => {
    const t = setup();
    const llm = new FakeLlmClient({ configured: false });
    const out = await askNetwork({ db: t.w.db, question: 'Who do I know in Austin?', channel: 'web', services: () => services(llm), now: NOW });
    expect(out.degraded).toBe(true);
    expect(out.degradedReason).toBe('no_key');
    expect(out.answer.startsWith(NEEDS_KEY_MESSAGE)).toBe(true);
    expect(out.answer).toContain('Sam Rivera — Austin');
    expect(out.answer).toContain('Jess Kim — Austin, TX'); // "East Austin" is a part of Austin
    expect(out.answer).not.toContain('Halvard');
    expect(out.citations.length).toBeGreaterThan(0);
    expect(out.citations.every((c) => ['fact', 'message', 'event'].includes(c.kind))).toBe(true);
    expect(out.people.map((p) => p.id)).toContain(t.w.sam);
    expect(llm.calls).toEqual([]);
    expect(getConversation(t.w.db, out.conversationId!)!.turns[0]!.status).toBe('degraded');
  });

  it('a "who do I know in …" plain search lists only people, never events or messages that mention the place', async () => {
    const ask = async (question: string, channel: 'web' | 'imessage') => {
      const t = setup();
      const llm = new FakeLlmClient().on('ask', { unavailable: 'api_error' });
      return askNetwork({ db: t.w.db, question, channel, services: () => services(llm), now: NOW });
    };
    const who = await ask('who do I know in Austin', 'web');
    expect(who).toMatchObject({ degraded: true, degradedReason: 'api_error' });
    expect(who.answer).toContain('Here’s who a plain search found:');
    expect(who.answer).toContain('Sam Rivera — Austin');
    expect(who.answer).toContain('Jess Kim — Austin, TX');
    expect(who.answer).not.toContain('Friendsgiving'); // an event at a venue in Austin
    expect(who.answer).not.toContain('ropes'); // a message mentioning Austin
    expect(who.citations.every((c) => c.kind === 'fact')).toBe(true);
    // The same one-line-per-person shape as a model answer, with rows for the web's table.
    expect(who.answer).toMatch(new RegExp(`^- Sam Rivera — Austin, TX · bouldering \\[F\\w+\\] · Climbing crew circle · ${LAST_SAM}$`, 'm'));
    expect(who.list?.intro).toBe('Claude isn’t reachable right now. Here’s who a plain search found:');
    expect(who.list?.rows.find((r) => r.person.id === who.people[0]?.id)).toBeTruthy();
    const samRow = who.list!.rows.find((r) => r.person.displayName === 'Sam Rivera')!;
    expect(samRow).toMatchObject({ city: 'Austin, TX', circles: ['Climbing crew'], lastContactAt: T0 });
    expect(samRow.detail).toMatch(/^Austin, TX · bouldering \[F\w+\]$/);
    // Over iMessage a fact that only repeats the city isn't cited ("Austin · Austin¹").
    const text = await ask('who do I know in Austin', 'imessage');
    expect(text.answer).toMatch(new RegExp(`^- Sam R\\. — Austin, TX · bouldering \\[F\\w+\\] · Climbing crew circle · ${LAST_SAM}$`, 'm'));
    expect(text.answer).not.toMatch(/Austin, TX · Austin/);
    expect(text.list?.rows.length).toBeGreaterThan(1);
    // Other questions still get events and messages.
    const what = await ask('Austin potluck', 'web');
    expect(what.answer).toContain('Here’s what a plain search found:');
    expect(what.answer).toContain('Friendsgiving potluck');
    expect(what.list).toBeNull(); // events in it: not a list of people
  });

  it('a list of people: one line per person with their details, rows for the table, stored with the turn', async () => {
    const t = setup();
    const fAustin = factRef(t.w.facts.samAustin);
    const fJess = factRef(t.w.facts.jessAustin);
    const fAcme = factRef(t.w.facts.jessAcme);
    t.llm.on('ask', {
      toolCalls: [SEARCH_AUSTIN],
      then: {
        text: `2 people in Austin:\n- ${t.sam} — lives in Austin [${fAustin}]\n- ${t.jess} [${t.jess}] – East Austin [${fJess}]; works at Acme Robotics [${fAcme}]\n\nNothing more recent turned up.`,
      },
    });
    const events: AskEvent[] = [];
    const out = await askNetwork({ db: t.w.db, question: 'who do I know in Austin', channel: 'web', onEvent: (e) => events.push(e), services: () => t.svc, now: NOW });

    expect(out.answer).toBe(
      [
        '2 people in Austin:',
        `- Sam Rivera — lives in Austin [${fAustin}] · Climbing crew circle · ${LAST_SAM}`,
        `- Jess Kim — East Austin [${fJess}]; works at Acme Robotics [${fAcme}] · Climbing crew circle · ${LAST_JESS}`,
        '',
        'Nothing more recent turned up.',
      ].join('\n'),
    );
    expect(out.list).toEqual({
      intro: '2 people in Austin:',
      rows: [
        { person: expect.objectContaining({ id: t.w.sam, displayName: 'Sam Rivera' }), detail: `lives in Austin [${fAustin}]`, city: 'Austin, TX', circles: ['Climbing crew'], lastContactAt: T0 },
        {
          person: expect.objectContaining({ id: t.w.jess, displayName: 'Jess Kim' }),
          detail: `East Austin [${fJess}]; works at Acme Robotics [${fAcme}]`,
          city: 'Austin, TX',
          circles: ['Climbing crew'],
          lastContactAt: T0 + DAY,
        },
      ],
      note: 'Nothing more recent turned up.',
    });
    expect(out.citations.map((c) => c.ref)).toEqual([fAustin, t.jess, fJess, fAcme]); // [P..] resolves but its row is the person
    // The model's own text (tokens intact) is what a follow-up replays.
    const row = t.w.db.prepare('SELECT model_answer, people_list FROM ask_turns WHERE id = ?').get(out.turnId) as { model_answer: string; people_list: string };
    expect(row.model_answer).toContain(`- ${t.sam} — lives in Austin [${fAustin}]`);
    expect(JSON.parse(row.people_list)).toEqual(JSON.parse(JSON.stringify(out.list)));
    expect(getConversation(t.w.db, out.conversationId!)!.turns[0]!.list).toEqual(out.list);
    expect(events.some((e) => e.type === 'delta')).toBe(true);

    // Someone hidden since drops out of the stored table (and their name out of the text).
    t.w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(t.w.jess);
    const later = getConversation(t.w.db, out.conversationId!)!.turns[0]!;
    expect(later.list?.rows.map((r) => r.person.id)).toEqual([t.w.sam]);
    expect(later.answer).not.toContain('Jess');
  });

  it('only one-line-per-person answers become lists: prose, mixed bullets and a lone line off a "who" question stay text', async () => {
    const t = setup();
    const fAustin = factRef(t.w.facts.samAustin);
    const fBoulder = factRef(t.w.facts.samBoulder);
    const e = eventRef(docNumber(t.w.db, 'occasion', t.w.occasions.friendsgiving));
    const ask = async (question: string, text: string) => {
      const llm = new FakeLlmClient().on('ask', { toolCalls: [SEARCH_AUSTIN, { name: 'list_events', input: { after: null, before: null, person_ref: null, query: 'potluck' } }], then: { text } });
      return askNetwork({ db: t.w.db, question, channel: 'web', services: () => services(llm, t.egress), now: NOW });
    };
    const lone = await ask('What is Sam into?', `- ${t.sam} — into bouldering [${fBoulder}]`);
    expect(lone.list).toBeNull();
    expect(lone.answer).toBe(`- Sam Rivera — into bouldering [${fBoulder}]`);
    const mixed = await ask('Who went to the potluck?', `- ${t.sam} — lives in Austin [${fAustin}]\n- the potluck itself [${e}]`);
    expect(mixed.list).toBeNull();
    const prose = await ask('Who went to the potluck?', `- ${t.sam} and ${t.jess} went together [${e}]`);
    expect(prose.list).toBeNull();
    // A single person still makes a one-row table for a "who" question.
    const one = await ask('Who do I know in Austin?', `- ${t.sam}: lives in Austin [${fAustin}]`);
    expect(one.list?.rows.map((r) => [r.person.id, r.detail])).toEqual([[t.w.sam, `lives in Austin [${fAustin}]`]]);
  });

  it('asksForPeople recognizes "who" questions', () => {
    for (const q of ['who do I know in London', 'Who’s into climbing?', 'whom should I invite', 'Anyone at Acme?', 'do I know anyone in Lisbon', 'which friends live in Austin', 'show me people in Paris']) {
      expect(asksForPeople(q), q).toBe(true);
    }
    for (const q of ['What did we do in Austin?', 'when is the potluck', 'Austin potluck', 'how is Sam']) expect(asksForPeople(q), q).toBe(false);
  });

  it('without a key, the suggested "who’s fading / what did I promise" questions are answered from stats and loops', async () => {
    const t = setup();
    const llm = new FakeLlmClient({ configured: false });
    t.w.db
      .prepare(
        `INSERT INTO person_stats (person_id, state, tie_strength, historical_strength, silence_d, expected_gap_d, computed_at) VALUES (?, 'fading', 30, 80, 41, 9, ?)
         ON CONFLICT(person_id) DO UPDATE SET state = 'fading', historical_strength = 80, silence_d = 41, expected_gap_d = 9, fading_suppressed = 0`,
      )
      .run(t.w.sam, NOW);
    t.w.db.prepare(`UPDATE person_stats SET state = 'steady' WHERE person_id <> ?`).run(t.w.sam);
    const quiet = await askNetwork({ db: t.w.db, question: 'Who haven’t I talked to in a while?', channel: 'web', services: () => services(llm), now: NOW });
    expect(quiet.degraded).toBe(true);
    expect(quiet.answer).toContain('Sam Rivera — quiet 41d · usually ~9d');
    expect(quiet.answer).not.toContain('last contact'); // "quiet 41d" already says it
    expect(quiet.list?.rows).toEqual([expect.objectContaining({ person: expect.objectContaining({ id: t.w.sam }), detail: 'quiet 41d · usually ~9d' })]);
    expect(quiet.people.map((p) => p.id)).toEqual([t.w.sam]);
    t.w.db
      .prepare(
        `INSERT INTO commitments (id, person_id, owner, kind, what, confidence, status, created_at, updated_at) VALUES ('00000000-0000-7000-8000-00000000c001', ?, 'me', 'send', 'send the trail map', 0.9, 'open', ?, ?)`,
      )
      .run(t.w.jess, NOW - DAY, NOW - DAY);
    const promises = await askNetwork({ db: t.w.db, question: 'What did I promise people I’d do?', channel: 'web', services: () => services(llm), now: NOW });
    expect(promises.answer).toContain('Jess Kim — you promised: send the trail map');
    expect(promises.list?.rows.filter((r) => r.person.id === t.w.jess)).toHaveLength(1);
    expect(promises.people.map((p) => p.id)).toContain(t.w.jess);
    expect(llm.calls).toEqual([]);
  });

  it('degrades with the right reason: budget, fail-closed egress, API errors; refusals and aborts', async () => {
    const t = setup();
    const ask = (svc: AgentServices, extra: Partial<Parameters<typeof askNetwork>[0]> = {}) =>
      askNetwork({ db: t.w.db, question: 'Who is into bouldering?', channel: 'web', services: () => svc, now: NOW, ...extra });

    const broke = await ask(services(new FakeLlmClient({ budget: { steady: 0, backfill: null } })));
    expect(broke).toMatchObject({ degraded: true, degradedReason: 'budget_daily' });
    expect(broke.answer).toMatch(/^Today’s Claude budget is used up/);
    expect(broke.answer).toContain('Sam Rivera');

    // An egress that can't pseudonymize fails closed: nothing is sent.
    const closed = new FakeLlmClient();
    const stubbed = await ask(services(closed, createEgress(null)));
    expect(stubbed).toMatchObject({ degraded: true, degradedReason: 'egress_blocked' });
    expect(closed.calls).toEqual([]);

    const down = await ask(services(new FakeLlmClient().on('ask', { unavailable: 'api_error' })));
    expect(down).toMatchObject({ degraded: true, degradedReason: 'api_error' });

    const refused = await ask(services(new FakeLlmClient().on('ask', { refusal: 'cyber' })));
    expect(refused).toMatchObject({ degraded: false, answer: 'I can’t help with that one.', citations: [] });

    const ac = new AbortController();
    ac.abort();
    const aborted = await ask(services(new FakeLlmClient().on('ask', { toolCalls: [SEARCH_AUSTIN], then: { text: 'x' } })), { signal: ac.signal });
    expect(aborted.error).toMatchObject({ code: 'aborted' });
  });

  it('hitting the tool limit with no text falls back to what the searches surfaced', async () => {
    const t = setup();
    const calls = Array.from({ length: 9 }, () => SEARCH_AUSTIN);
    t.llm.on('ask', { toolCalls: calls, then: { text: 'never reached' } });
    const out = await askNetwork({ db: t.w.db, question: 'Who do I know in Austin?', channel: 'web', services: () => t.svc, now: NOW });
    expect(out).toMatchObject({ degraded: true, degradedReason: 'tool_limit' });
    expect(out.answer).toMatch(/^Ask ran out of searches/);
    expect(out.answer).toContain('Sam Rivera');
  });

  it('works with the real SQLite egress: P-tokens from the pseudonyms table, names never sent, answer de-tokenized', async () => {
    const w = buildAskWorld();
    const egress = createEgress(w.db);
    const sam = egress.tokenFor(w.sam);
    const fAustin = factRef(w.facts.samAustin);
    const llm = new FakeLlmClient().on('ask', { toolCalls: [SEARCH_AUSTIN, { name: 'get_person', input: { ref: sam } }], then: { text: `${sam} lives in Austin [${fAustin}].` } });
    const out = await askNetwork({ db: w.db, question: 'Where does Sam Rivera live?', channel: 'web', services: () => services(llm, egress), now: NOW });
    expect(out.answer).toBe(`Sam Rivera lives in Austin [${fAustin}].`);
    expect(out.people.map((p) => p.id)).toEqual([w.sam]);
    const sent = llm.calls[0]!.userText;
    expect(sent).toContain('Where does Sam R. live?');
    expect(sent).not.toContain('Rivera');
    expect(w.db.prepare(`SELECT kind FROM pseudonyms WHERE token = ?`).pluck().get(sam)).toBe('person');
  });

  it('a raw identifier in the question never reaches the model unscrubbed', async () => {
    const t = setup({ text: 'Nobody I know uses that number.' });
    const out = await askNetwork({ db: t.w.db, question: 'Who has the number 555-555-0123 or owner@example.com?', channel: 'web', services: () => t.svc, now: NOW });
    expect(out.degraded).toBe(false);
    expect(t.llm.calls[0]!.userText).not.toMatch(/555-555-0123|owner@example\.com/);
  });
});
