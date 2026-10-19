/**
 * The Ask requests the API accepts. On 2026-10-18 an iMessage Ask was answered HTTP 400 on its FIRST request: the
 * six strict Ask tools then had 24 required-nullable (anyOf) filters, over the API's 16 union-typed parameters
 * across all strict schemas (fixed by making filters optional). These run the real client against the fake API with
 * the real Ask system prompt and tools, on both channel routes, through a tool-result turn.
 */
import { describe, expect, it } from 'vitest';
import { ASK_ROUTE, ASK_SYSTEM_PROMPT } from '../../src/ask/prompt';
import { ASK_TOOL_DEFS } from '../../src/ask/tools';
import { createLlmClient, requestIssues, STRICT_MAX_UNION_PARAMS, strictParamCounts } from '../../src/llm/client';
import { createEgress } from '../../src/llm/egress';
import type { LlmTool } from '../../src/llm/types';
import { writeSettings } from '../../src/settings/registry';
import { memDb, T0 } from '../helpers';
import { FakeAnthropic, reply } from '../llm/fakeAnthropic';

function setup(api: FakeAnthropic) {
  const db = memDb();
  writeSettings(db, { tz: 'UTC' }, { actor: 'user', now: T0 });
  return createLlmClient({ db, apiKey: 'synthetic-test-key', egress: createEgress(db), fetch: api.fetch, now: () => T0, maxRetries: 0 });
}

const ask = (llm: ReturnType<typeof setup>, channel: 'web' | 'imessage', tools: readonly LlmTool[] = ASK_TOOL_DEFS) =>
  llm.runTools({
    kind: 'ask',
    route: ASK_ROUTE[channel],
    subjectRef: 'turn-1',
    promptVersion: 'v1',
    system: ASK_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 'Who do I know in Springfield?' }],
    tools: [...tools],
    maxToolCalls: 8,
    executeTool: async () => ({ content: '{"people":[]}' }),
  });

/** The pre-fix tool set: every optional filter required and nullable (`anyOf [T, null]`). */
const nullableFilters = (tools: readonly LlmTool[]): LlmTool[] =>
  tools.map((t) => {
    const s = t.inputSchema as { properties: Record<string, { description?: string }>; required: string[] };
    const properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, p]) => [k, s.required.includes(k) ? p : { anyOf: [{ ...p, description: undefined }, { type: 'null' }], description: p.description }]),
    );
    return { ...t, inputSchema: { ...t.inputSchema, properties, required: Object.keys(properties) } };
  });

describe('Ask requests (the 2026-10-18 400)', () => {
  it.each(['imessage', 'web'] as const)('%s: the first request and the one after tool results stay inside the strict-schema limits', async (channel) => {
    const api = new FakeAnthropic().onMessage(
      () => reply({ toolUses: [{ name: 'search_people', input: { city: 'Springfield', limit: null }, id: 'toolu_1' }, { name: 'list_events', input: {}, id: 'toolu_2' }] }),
      () => reply({ text: 'Nobody there yet.' }),
    );
    const out = await ask(setup(api), channel);
    expect(out).toMatchObject({ status: 'ok', toolCalls: 2 });
    const [first, second] = api.messageRequests.map((r) => r.body!);
    expect(first).toMatchObject({ max_tokens: channel === 'imessage' ? 2500 : 4000, thinking: { type: 'adaptive' }, tool_choice: { type: 'auto' } });
    // The second request replays the assistant turn (thinking + both tool_use blocks) and both results in ONE user turn.
    const msgs = second!.messages as { role: string; content: { type: string }[] }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    for (const body of [first!, second!]) {
      expect(requestIssues(body)).toEqual([]);
      expect(strictParamCounts((body.tools as { input_schema: unknown }[]).map((t) => t.input_schema)).union).toBeLessThanOrEqual(STRICT_MAX_UNION_PARAMS);
    }
  });

  it('the tool set that was answered 400 (24 nullable filters) is refused locally and never sent', async () => {
    const old = nullableFilters(ASK_TOOL_DEFS);
    expect(strictParamCounts(old.map((t) => t.inputSchema))).toEqual({ union: 24, optional: 0 });
    for (const channel of ['imessage', 'web'] as const) {
      const api = new FakeAnthropic().onMessage(() => reply({ text: 'unreachable' }));
      const out = await ask(setup(api), channel, old);
      expect(out).toMatchObject({ status: 'unavailable', reason: 'api_error', detail: expect.stringContaining('24 union-typed tool parameters (max 16)') });
      expect(api.requests).toHaveLength(0);
    }
  });
});
