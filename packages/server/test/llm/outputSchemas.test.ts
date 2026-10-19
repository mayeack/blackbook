/**
 * The API's structured-output grammar limit (llm/client.ts GRAMMAR_MAX_NODES). Every extraction request of
 * 2026-10-16/17/18 came back 400 "The compiled grammar is too large…" although the schema was within the documented
 * union/optional limits; nothing caught it before production. These tests keep every schema Claude is asked to fill
 * (src/llmSchemas.ts) under the measured budget, and fail on an LLM call site whose schema is not in that list.
 * The live counterpart is `yb llm-smoke --live` (npm run smoke:llm-schemas).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputFormat } from '../../src/llm/caching';
import { GRAMMAR_MAX_NODES, grammarIssues, grammarNodes, requestIssues, requestParams, SMOKE_USER, smokeSchemas } from '../../src/llm/client';
import { resolveRoute } from '../../src/llm/models';
import { Extraction, ExtractionKnowledge, ExtractionObligations } from '../../src/extraction/schema';
import { LLM_SCHEMAS } from '../../src/llmSchemas';

const SRC = path.resolve(import.meta.dirname, '../../src');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const strings = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }]));
const formatNodes = (schema: z.ZodType) => grammarNodes([outputFormat(schema).schema]);

describe('grammar nodes', () => {
  it('counts every object, property and array, $refs inlined (the unit the API limit was measured in)', () => {
    // Measured live on Haiku 5.5: a flat object passed with 70 string properties (71 nodes) and failed with 80.
    expect(grammarNodes([obj(strings(70))])).toBe(71);
    // Four arrays of ten-field objects passed (53 nodes); six failed (79).
    const arrays = (k: number) => obj(Object.fromEntries(Array.from({ length: k }, (_, i) => [`a${i}`, { type: 'array', items: obj(strings(10)) }])));
    expect(grammarNodes([arrays(4)])).toBe(53);
    expect(grammarNodes([arrays(6)])).toBe(79);
    // A shared definition counts at every use; nullable and enum fields are one node.
    const ev = obj({ msg: { type: 'string' }, quote: { type: 'string' } });
    const withRefs = { ...obj({ a: { $ref: '#/$defs/ev' }, b: { $ref: '#/$defs/ev' }, c: { type: ['string', 'null'] }, d: { type: 'string', enum: ['x', 'y'] } }), $defs: { ev } };
    expect(grammarNodes([withRefs])).toBe(1 + 4 + 2 * 3);
    // Several schemas (an output format and strict tools) add up; a recursive one is never within a budget.
    expect(grammarNodes([obj(strings(3)), obj(strings(2))])).toBe(7);
    const loop = { ...obj({ next: { $ref: '#/$defs/n' } }), $defs: { n: obj({ next: { $ref: '#/$defs/n' } }) } };
    expect(grammarNodes([loop])).toBe(Number.POSITIVE_INFINITY);
  });

  it('the one-request extraction schema the API refused is over the budget and requestIssues refuses it locally', () => {
    expect(formatNodes(Extraction)).toBe(86);
    const body = requestParams(resolveRoute('extract_steady'), { system: 's', messages: [{ role: 'user', content: 'x' }], format: outputFormat(Extraction), mode: 'batch' });
    expect(grammarIssues(body)).toEqual([`86 schema nodes in the strict schemas (max ${GRAMMAR_MAX_NODES}: the compiled grammar would be too large)`]);
    expect(requestIssues(body)).toEqual(grammarIssues(body));
  });

  it("a window's two requests are each well under it (pinned: growing either is a decision, re-check with yb llm-smoke --live)", () => {
    expect(formatNodes(ExtractionKnowledge)).toBe(58);
    expect(formatNodes(ExtractionObligations)).toBe(29);
    // Live on 2026-10-18 the knowledge schema still compiled with 16 extra fields and failed with 18.
    expect(GRAMMAR_MAX_NODES - formatNodes(ExtractionKnowledge)).toBeGreaterThanOrEqual(6);
    // Together they hold exactly the one-request schema's fields: nothing extraction produced was dropped.
    expect([...Object.keys(ExtractionKnowledge.shape), ...Object.keys(ExtractionObligations.shape)].sort()).toEqual(Object.keys(Extraction.shape).sort());
  });
});

describe('every schema Claude fills', () => {
  it('is within the grammar budget and passes requestIssues on its route', () => {
    for (const e of LLM_SCHEMAS) {
      const body = requestParams(resolveRoute(e.route), {
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        ...(e.schema ? { format: outputFormat(e.schema) } : {}),
        ...(e.tools ? { tools: e.tools } : {}),
        mode: 'sync',
      });
      expect(requestIssues(body), e.name).toEqual([]);
      const strict = ((body.tools ?? []) as { input_schema: unknown }[]).map((t) => t.input_schema);
      const format = (body.output_config as { format?: { schema: unknown } }).format;
      expect(grammarNodes(format ? [format.schema, ...strict] : strict), e.name).toBeLessThanOrEqual(GRAMMAR_MAX_NODES);
    }
  });

  it('is registered: each `schema: X` an LLM call passes is in src/llmSchemas.ts (the one-request Extraction never is)', () => {
    const registered = new Set(LLM_SCHEMAS.map((e) => e.name));
    expect(registered.has('Extraction')).toBe(false);
    const used = new Map<string, string>();
    for (const f of files(SRC)) {
      if (f.endsWith('llmSchemas.ts')) continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bschema: ([A-Z][A-Za-z0-9_]+)\s*[,}]/g)) used.set(m[1]!, path.relative(SRC, f));
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
    const missing = [...used].filter(([name]) => !registered.has(name)).map(([name, f]) => `${name} (${f})`);
    expect(missing).toEqual([]);
  });
});

describe('yb llm-smoke (smokeSchemas)', () => {
  const GRAMMAR_400 = 'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.';
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const cases = [
    { name: 'obligations', route: 'extract_steady' as const, schema: ExtractionObligations },
    { name: 'knowledge', route: 'extract_steady' as const, schema: ExtractionKnowledge },
    { name: 'one-request', route: 'extract_steady' as const, schema: Extraction },
  ];

  it('sends one request per schema shaped like production, and reports only the status and the API text', async () => {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ path: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname, body });
      const props = ((body.output_config as { format: { schema: { properties: Record<string, unknown> } } }).format.schema.properties);
      if ('facts' in props) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: GRAMMAR_400 } });
      return json(200, { id: 'msg_fake', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 13, output_tokens: 20 } });
    }) as typeof globalThis.fetch;
    const rows = await smokeSchemas({ apiKey: 'test-key', cases, fetch });
    expect(rows.map((r) => [r.name, r.nodes, r.status, r.detail])).toEqual([
      ['obligations', 29, 200, 'end_turn'],
      ['knowledge', 58, 400, GRAMMAR_400],
      ['one-request', 86, 'local', `86 schema nodes in the strict schemas (max ${GRAMMAR_MAX_NODES}: the compiled grammar would be too large)`],
    ]);
    // The over-budget schema never left; the others went out like the real route (Haiku, thinking off, effort low,
    // cached system block, the fixed literal user turn, no sampling parameters).
    expect(sent).toHaveLength(2);
    for (const { path: p, body } of sent) {
      expect(p).toBe('/v1/messages');
      expect(body).toMatchObject({ model: resolveRoute('extract_steady').model, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, messages: [{ role: 'user', content: SMOKE_USER }] });
      expect((body.system as { cache_control?: unknown }[])[0]!.cache_control).toBeDefined();
      expect(body).not.toHaveProperty('temperature');
    }
  });

  it('without an API key nothing is sent (node counts and local issues only)', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return json(500, {});
    }) as unknown as typeof globalThis.fetch;
    const rows = await smokeSchemas({ apiKey: null, cases, fetch });
    expect(rows.map((r) => r.status)).toEqual(['not_sent', 'not_sent', 'local']);
    expect(calls).toBe(0);
  });
});
