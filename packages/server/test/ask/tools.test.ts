import { describe, expect, it } from 'vitest';
import { ensureAskIndexes } from '../../src/ask/fts';
import { factRef, messageRef } from '../../src/ask/refs';
import { createScope } from '../../src/ask/retrieval';
import { ASK_TOOL_DEFS, AskSession, executeTool, MAX_SESSION_RESULT_TOKENS, UNTRUSTED_NOTE } from '../../src/ask/tools';
import { estimatePromptTokens } from '../../src/llm/models';
import { findRawIdentifiers } from '../../src/llm/egress';
import { EgressBlocked, type Egress } from '../../src/llm/types';
import { FakeEgress } from '../fakes/llm';
import { buildAskWorld, NOW } from './world';

async function session() {
  const w = buildAskWorld();
  await ensureAskIndexes(w.db, NOW);
  const egress = new FakeEgress();
  const s = new AskSession(createScope(w.db, { now: NOW, forModel: true }), egress);
  let n = 0;
  const call = (name: string, input: unknown) => executeTool(s, { id: `t${n++}`, name, input });
  return { w, egress, s, call };
}

describe('Ask tool definitions', () => {
  it('are strict-ready: every property required, additionalProperties false, no numeric bounds', () => {
    expect(ASK_TOOL_DEFS.map((t) => t.name)).toEqual(['search_people', 'search_messages', 'search_facts', 'get_person', 'graph_neighbors', 'list_events']);
    for (const t of ASK_TOOL_DEFS) {
      const schema = t.inputSchema as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
    }
  });
});

describe('executeTool', () => {
  it('renders people as tokens with last initials, pseudonymizes free text, wraps results as untrusted', async () => {
    const { w, egress, s, call } = await session();
    const sam = egress.tokenFor(w.sam);
    const people = await call('search_people', { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: null });
    expect(people.isError).toBeFalsy();
    expect(people.content.startsWith(`[search_people] ${UNTRUSTED_NOTE}`)).toBe(true);
    expect(people.content).toContain(`"ref":"${sam}","name":"Sam R."`);
    expect(people.content).not.toContain('Rivera');
    expect(people.content).not.toContain('Xander'); // excluded from Claude
    expect(people.content).not.toContain('therapy'); // sensitive
    expect(people.citableIds).toEqual(expect.arrayContaining([sam, factRef(w.facts.samAustin)]));

    const msgs = await call('search_messages', { query: 'bouldering', person_ref: sam, conv_id: null, after: null, before: null, limit: 20 });
    expect(findRawIdentifiers(msgs.content)).toEqual([]);
    expect(msgs.content).not.toContain('555-555-0107'); // the number in Sam's message was masked before egress
    expect(msgs.content).toContain('my new number is ••• 07');
    expect(msgs.content).toContain(`"sender":"ME"`);
    expect(msgs.content).toContain(`DM with ${sam}`);
    expect(msgs.citableIds).toContain(messageRef(w.msgs.samTea));
    // A conv alias from that result can scope the next search.
    const alias = /"conv":"(C\d+)"/.exec(msgs.content)![1];
    const scoped = await call('search_messages', { query: null, person_ref: null, conv_id: alias, after: null, before: null, limit: 5 });
    expect(scoped.isError).toBeFalsy();

    w.db
      .prepare(
        `INSERT INTO commitments (id, person_id, owner, kind, what, confidence, status, sensitive, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-00000000c0de', ?, 'me', 'meet', 'go with her to the appointment Thursday', 0.9, 'open', 1, ?, ?)`,
      )
      .run(w.sam, NOW, NOW);
    const person = await call('get_person', { ref: sam });
    expect(person.content).toContain('"accounts":[');
    expect(person.content).not.toContain('appointment');
    expect(person.content).not.toMatch(/555|example\.com|sam\.climbs/);
    expect(person.content).not.toContain('starting therapy');

    const events = await call('list_events', { after: null, before: null, person_ref: sam, query: null });
    expect(events.content).toContain('Friendsgiving potluck');
    expect(events.content).not.toContain('Dentist');
    expect(events.citableIds?.some((id) => id.startsWith('E'))).toBe(true);

    const graph = await call('graph_neighbors', { ref: sam, min_strength: null, types: null, limit: null });
    expect(graph.content).toContain('Climbing crew');
    expect(graph.content).not.toContain('Halvard');

    const facts = await call('search_facts', { query: 'acme', cat: null, limit: null });
    expect(facts.content).toContain('Acme Robotics');
    expect(s.toolCalls).toBe(7);
    expect(s.outcomes.size).toBe(7);
  });

  it('answers bad calls with errors (never data): unknown tool, bad input, unknown ref, call limit', async () => {
    const { call } = await session();
    expect((await call('delete_everything', {})).isError).toBe(true);
    expect((await call('get_person', { ref: 42 })).isError).toBe(true);
    const unknown = await call('get_person', { ref: 'P999' });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toContain('unknown ref');
    for (let i = 0; i < 6; i++) await call('search_facts', { query: 'austin', cat: null, limit: 1 });
    const over = await call('search_facts', { query: 'austin', cat: null, limit: 1 });
    expect(over.isError).toBe(true);
    expect(over.content).toContain('limit');
  });

  it('the session result budget counts estimated tokens: a result is cut to what is left, then the budget answers an error', async () => {
    const { s, call } = await session();
    const input = { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: null };
    s.resultTokens = MAX_SESSION_RESULT_TOKENS - 40;
    const cut = await call('search_people', input);
    expect(cut.isError).toBeFalsy();
    const body = cut.content.slice(`[search_people] ${UNTRUSTED_NOTE}\n`.length);
    expect(body).toContain('truncated');
    expect(estimatePromptTokens(body)).toBeLessThanOrEqual(40);
    s.resultTokens = MAX_SESSION_RESULT_TOKENS;
    const over = await call('search_people', input);
    expect(over).toMatchObject({ isError: true, content: expect.stringContaining('context budget reached') });
  });

  it('fails closed when the egress refuses a result', async () => {
    const w = buildAskWorld();
    const fake = new FakeEgress();
    const blocking: Egress = {
      ...fake,
      tokenFor: (id) => fake.tokenFor(id),
      resolveToken: (t) => fake.resolveToken(t),
      pseudonymize: () => {
        throw new EgressBlocked([{ kind: 'phone', count: 1 }]);
      },
      scan: () => {},
      detokenize: (t) => t,
    };
    const s = new AskSession(createScope(w.db, { now: NOW, forModel: true }), blocking);
    const r = await executeTool(s, { id: 'x', name: 'search_facts', input: { query: 'austin', cat: null, limit: 5 } });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toContain('withheld');
    expect(r.content).not.toContain('Austin');
  });
});
