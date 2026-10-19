/**
 * The cost pass (owner, 2026-10-16: cheapest model first, cache everything): the route table, the override
 * allowlist (Opus is not selectable), request shapes for every route (no sampling params, no fallbacks to Haiku,
 * explicit effort, thinking off on structured-output routes), cache_control placement and byte-stability, the
 * 100K prompt guard, pricing (cache reads/writes, batch, the >100K rate card), and the source lint: no model id
 * outside src/llm/models.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASK_SYSTEM_PROMPT } from '../../src/ask/prompt';
import { ASK_TOOL_DEFS } from '../../src/ask/tools';
import { INTENT_SYSTEM } from '../../src/commands/intent';
import { DRAFT_SYSTEM } from '../../src/commands/draft';
import { COMPOSER_SYSTEM } from '../../src/delivery/llmComposer';
import { CONSOLIDATION_SYSTEM, EXTRACTION_SYSTEM } from '../../src/extraction/prompt';
import { TIEBREAK_SYSTEM } from '../../src/identity/tiebreak';
import { ADJUDICATION_SYSTEM } from '../../src/intel/adjudicationPrompt';
import { outputFormat, volatileMarkers } from '../../src/llm/caching';
import { promptTokens, requestIssues, requestParams, routeOverrides, STRICT_MAX_OPTIONAL_PARAMS, STRICT_MAX_UNION_PARAMS, strictParamCounts, strictSchemaIssues } from '../../src/llm/client';
import {
  BATCH_CACHE_MISS_SHARE,
  CACHE_WRITE_MULTIPLIER,
  costUsd,
  DEFAULT_MODEL,
  estimatePromptTokens,
  estimateRouteUsd,
  HAIKU_5_5,
  isAllowedModel,
  LLM_ROUTES,
  MODEL_ALLOWLIST,
  priceTokens,
  PROMPT_TOKEN_LIMIT,
  refusalRerunnable,
  resolveRoute,
  routeOverrideIssues,
  ROUTES,
  sendsFallbacks,
  SONNET_5_5,
  thinkingParam,
  type LlmRoute,
} from '../../src/llm/models';
import { NAMING_SYSTEM } from '../../src/pipeline/circles/naming';
import { readSetting, SettingsError, writeSettings } from '../../src/settings/registry';
import type { LlmParseRequest } from '../../src/llm/types';
import { FakeLlmClient } from '../fakes/llm';
import { memDb, T0 } from '../helpers';

/** An Opus id, assembled so this file doesn't carry the literal either. */
const OPUS = ['claude', 'opus', '5', '5'].join('-');

describe('route table defaults', () => {
  it('every route runs on Claude Haiku 5.5 at effort low; thinking off except the Ask tool loop', () => {
    expect(DEFAULT_MODEL).toBe(HAIKU_5_5);
    expect(HAIKU_5_5).toBe('claude-haiku-5-5');
    expect(Object.keys(ROUTES).sort()).toEqual([...LLM_ROUTES].sort());
    expect(LLM_ROUTES).toEqual([
      'extract_steady',
      'extract_historical',
      'extract_consolidate',
      'tiebreak',
      'intent',
      'circle_name',
      'adjudicate',
      'digest_compose',
      'draft_openers',
      'ask_web',
      'ask_imessage',
      'eval_shadow',
    ]);
    for (const r of LLM_ROUTES) {
      const p = ROUTES[r];
      expect(p.model, r).toBe(HAIKU_5_5);
      expect(p.effort, r).toBe('low');
      expect(p.thinking, r).toBe(r.startsWith('ask_') ? 'adaptive' : 'disabled');
      // Non-streaming calls stay ≤16k; tight caps everywhere.
      expect(p.maxTokens, r).toBeLessThanOrEqual(8000);
    }
  });

  it('cache TTL: 1 h on batch routes, 5 min on synchronous ones, no marker where the prefix is never re-read', () => {
    const unmarked = ['digest_compose', 'intent'];
    for (const r of LLM_ROUTES) expect(ROUTES[r].cacheTtl, r).toBe(ROUTES[r].mode === 'batch' ? '1h' : unmarked.includes(r) ? null : '5m');
    expect(LLM_ROUTES.filter((r) => ROUTES[r].mode === 'batch').sort()).toEqual(['adjudicate', 'extract_consolidate', 'extract_historical', 'extract_steady']);
  });

  it('the web and iMessage Ask routes share model, effort and thinking (so they share one cached prefix)', () => {
    const { ask_web: w, ask_imessage: i } = ROUTES;
    expect([w.model, w.effort, w.thinking, w.cacheTtl]).toEqual([i.model, i.effort, i.thinking, i.cacheTtl]);
  });
});

describe('overrides: only allowlisted models, Opus never', () => {
  it('the allowlist is Haiku 5.5 and Sonnet 5.5', () => {
    expect([...MODEL_ALLOWLIST]).toEqual([HAIKU_5_5, SONNET_5_5]);
    expect(isAllowedModel(OPUS)).toBe(false);
    expect(routeOverrideIssues({ tiebreak: { model: OPUS } })).toEqual([expect.stringMatching(/model must be one of/)]);
    expect(routeOverrideIssues({ nope: {} })).toEqual(['unknown route "nope"']);
    expect(routeOverrideIssues({ intent: { effort: 'max' } })).toEqual([expect.stringMatching(/effort/)]);
    expect(routeOverrideIssues({ intent: { model: SONNET_5_5, effort: 'medium' } })).toEqual([]);
  });

  it('resolveRoute applies a valid override and ignores anything off the allowlist', () => {
    expect(resolveRoute('tiebreak', { tiebreak: { model: SONNET_5_5 } })).toMatchObject({ model: SONNET_5_5, effort: 'low', overridden: true });
    expect(resolveRoute('tiebreak', { tiebreak: { effort: 'medium' } })).toMatchObject({ model: HAIKU_5_5, effort: 'medium', overridden: true });
    expect(resolveRoute('tiebreak', { tiebreak: { model: OPUS as never } })).toMatchObject({ model: HAIKU_5_5, overridden: false });
    expect(resolveRoute('intent', { tiebreak: { model: SONNET_5_5 } })).toMatchObject({ model: HAIKU_5_5, overridden: false });
  });

  it('settings: llm.route_overrides accepts Sonnet, rejects Opus (400 path), and a stored Opus value reads as {}', () => {
    const db = memDb();
    writeSettings(db, { 'llm.route_overrides': { digest_compose: { model: SONNET_5_5 } } }, { actor: 'user', now: T0 });
    expect(routeOverrides(db)).toEqual({ digest_compose: { model: SONNET_5_5 } });
    expect(() => writeSettings(db, { 'llm.route_overrides': { digest_compose: { model: OPUS } } }, { actor: 'user', now: T0 })).toThrow(SettingsError);
    expect(() => writeSettings(db, { 'llm.route_overrides': { not_a_route: {} } }, { actor: 'user', now: T0 })).toThrow(SettingsError);
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'llm.route_overrides'`).run(JSON.stringify({ ask_web: { model: OPUS } }));
    expect(readSetting(db, 'llm.route_overrides')).toEqual({});
    expect(new FakeLlmClient({ overrides: { ask_web: { model: OPUS as never } } }).params('ask_web').model).toBe(HAIKU_5_5);
  });
});

describe('request shape per route', () => {
  const Out = z.object({ ok: z.boolean() });
  const tools = [{ name: 'b_tool', description: 'b', inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] } }, { name: 'a_tool', description: 'a', inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] } }];
  const build = (route: LlmRoute, mode: 'sync' | 'batch', overrides?: Parameters<typeof resolveRoute>[1]) =>
    requestParams(resolveRoute(route, overrides), {
      system: 'A stable system prompt.',
      messages: [{ role: 'user', content: 'hello' }],
      ...(route.startsWith('ask_') ? { tools } : { format: outputFormat(Out) }),
      mode,
    });

  it('Haiku: no sampling params, no fallbacks/betas (sync or batch), explicit effort, thinking per route', () => {
    for (const r of LLM_ROUTES) {
      for (const mode of ['sync', 'batch'] as const) {
        if (r.startsWith('ask_') && mode === 'batch') continue;
        const b = build(r, mode);
        for (const k of ['temperature', 'top_p', 'top_k', 'fallbacks', 'betas']) expect(b, `${r} ${mode}`).not.toHaveProperty(k);
        expect(b).toMatchObject({ model: HAIKU_5_5, max_tokens: ROUTES[r].maxTokens, output_config: { effort: 'low' } });
        expect(b.thinking).toEqual(r.startsWith('ask_') ? { type: 'adaptive' } : { type: 'disabled' });
        expect(requestIssues(b), r).toEqual([]);
      }
    }
  });

  it('Sonnet 5.5 override: fallbacks only on sync calls; thinking-off spelled between_tools', () => {
    const o = { intent: { model: SONNET_5_5 } } as const;
    expect(build('intent', 'sync', o)).toMatchObject({ model: SONNET_5_5, fallbacks: 'default', thinking: { type: 'between_tools' } });
    expect(build('intent', 'batch', o)).not.toHaveProperty('fallbacks');
    expect(sendsFallbacks({ model: HAIKU_5_5 }, 'sync')).toBe(false);
    expect(sendsFallbacks({ model: SONNET_5_5 }, 'batch')).toBe(false);
    expect(thinkingParam({ model: SONNET_5_5, thinking: 'adaptive' })).toEqual({ type: 'adaptive' });
  });

  it('cache_control: the system block at the route TTL; tool loops add the 5-min moving breakpoint; tools sorted', () => {
    expect(build('extract_steady', 'batch').system).toEqual([{ type: 'text', text: 'A stable system prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(build('tiebreak', 'sync').system).toEqual([{ type: 'text', text: 'A stable system prompt.', cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    expect(build('tiebreak', 'sync')).not.toHaveProperty('cache_control');
    // A sync call on a batch route (on-demand consolidation, refusal re-run) writes at 5 min, not the batch's 1 h.
    expect(build('extract_consolidate', 'sync').system).toEqual([{ type: 'text', text: 'A stable system prompt.', cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    expect(build('extract_consolidate', 'batch').system).toEqual([{ type: 'text', text: 'A stable system prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    // Once-a-day / sporadic routes send no marker at all (a write would never be read).
    for (const r of ['digest_compose', 'intent'] as const) {
      const body = build(r, 'sync');
      expect(body.system, r).toEqual([{ type: 'text', text: 'A stable system prompt.' }]);
      expect(JSON.stringify(body), r).not.toContain('cache_control');
    }
    const ask = build('ask_web', 'sync');
    expect(ask.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect((ask.tools as { name: string }[]).map((t) => t.name)).toEqual(['a_tool', 'b_tool']);
    // Render order tools → system → messages: the cached prefix comes first in the body too.
    expect(Object.keys(ask).indexOf('tools')).toBeLessThan(Object.keys(ask).indexOf('system'));
    expect(Object.keys(ask).indexOf('system')).toBeLessThan(Object.keys(ask).indexOf('messages'));
  });

  it('byte-stable: two builds of the same request (and of every stage system prompt) are identical', () => {
    for (const r of LLM_ROUTES) {
      const a = build(r, ROUTES[r].mode);
      const b = build(r, ROUTES[r].mode);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(outputFormat(Out)).toBe(outputFormat(Out)); // memoized: one schema object per zod schema
    const systems = { EXTRACTION_SYSTEM, CONSOLIDATION_SYSTEM, TIEBREAK_SYSTEM, INTENT_SYSTEM, DRAFT_SYSTEM, COMPOSER_SYSTEM, ADJUDICATION_SYSTEM, ASK_SYSTEM_PROMPT, NAMING_SYSTEM };
    for (const [name, sys] of Object.entries(systems)) {
      // Fixed few-shot dates in the extraction examples are literals; nothing else may look volatile.
      const markers = volatileMarkers(sys).filter((m) => !(name === 'EXTRACTION_SYSTEM' && m === 'iso_timestamp'));
      expect(markers, name).toEqual([]);
    }
    expect(JSON.stringify(ASK_TOOL_DEFS)).toBe(JSON.stringify(ASK_TOOL_DEFS));
  });

  it('cacheable prefixes clear the 512-token minimum on the routes that reuse them at volume', () => {
    // Batch routes and the Ask loop (conservative 3 chars/token; the schema/tools are part of the prefix).
    expect(estimatePromptTokens(EXTRACTION_SYSTEM)).toBeGreaterThan(512);
    expect(estimatePromptTokens(CONSOLIDATION_SYSTEM)).toBeGreaterThan(512);
    expect(estimatePromptTokens(ADJUDICATION_SYSTEM)).toBeGreaterThan(512);
    expect(estimatePromptTokens(ASK_SYSTEM_PROMPT + JSON.stringify(ASK_TOOL_DEFS))).toBeGreaterThan(512);
  });

  it('the 100K guard: promptTokens counts tools + system + messages + schema conservatively; prefill and sampling are flagged', () => {
    const big = requestParams(resolveRoute('intent'), { system: 's', messages: [{ role: 'user', content: 'x'.repeat(PROMPT_TOKEN_LIMIT * 3 + 300) }], format: outputFormat(Out), mode: 'sync' });
    expect(promptTokens(big)).toBeGreaterThan(PROMPT_TOKEN_LIMIT);
    const ok = build('intent', 'sync');
    expect(promptTokens(ok)).toBeLessThan(200);
    expect(requestIssues({ ...ok, temperature: 0 })).toEqual(['sampling parameter temperature']);
    expect(requestIssues({ ...ok, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '{' }] })).toEqual(['last message must be a user turn (no prefill)']);
    expect(requestIssues({ ...ok, fallbacks: 'default' })).toEqual(['fallbacks on a model without server-side fallback']);
    expect(requestIssues({ ...ok, model: OPUS })).toEqual(['model not in the allowlist']);
  });

  it('strict tool sets over the API schema limits (16 union-typed, 24 optional parameters) are flagged', () => {
    const tool = (name: string, properties: Record<string, unknown>, required: string[]) => ({ name, strict: true, input_schema: { type: 'object', additionalProperties: false, properties, required } });
    const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    // The shape that 400'd in production: 24 required-nullable filters across the Ask tools.
    const unions = Array.from({ length: 3 }, (_, i) => tool(`t${i}`, Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`p${j}`, nullable])), Array.from({ length: 8 }, (_, j) => `p${j}`)));
    expect(strictParamCounts(unions.map((t) => t.input_schema))).toEqual({ union: 24, optional: 0 });
    expect(strictSchemaIssues(unions)).toEqual(['24 union-typed tool parameters (max 16)']);
    expect(strictSchemaIssues(unions.map((t) => ({ ...t, strict: false })))).toEqual([]);
    const optional = [tool('a', Object.fromEntries(Array.from({ length: 25 }, (_, j) => [`p${j}`, { type: 'string' }])), [])];
    expect(strictSchemaIssues(optional)).toEqual(['25 optional tool parameters (max 24)']);
    expect(requestIssues({ ...build('intent', 'sync'), tools: unions })).toEqual(['24 union-typed tool parameters (max 16)']);
  });

  it('the Ask tools fit the strict schema limits', () => {
    const body = requestParams(resolveRoute('ask_web'), { system: ASK_SYSTEM_PROMPT, messages: [{ role: 'user', content: 'Who do I know in Lisbon?' }], tools: ASK_TOOL_DEFS, mode: 'sync' });
    expect(requestIssues(body)).toEqual([]);
    const n = strictParamCounts(ASK_TOOL_DEFS.map((t) => t.inputSchema));
    expect(n.union).toBeLessThanOrEqual(STRICT_MAX_UNION_PARAMS);
    expect(n.optional).toBeLessThanOrEqual(STRICT_MAX_OPTIONAL_PARAMS);
  });
});

describe('pricing', () => {
  const t = (input: number, output: number, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });

  it('Haiku 5.5: $0.10/$0.50 up to 100K prompt tokens, $0.50/$2.50 above; cache 0.1× / 1.25× / 2×; batch 50%', () => {
    expect(priceTokens(t(100_000, 1000), { model: HAIKU_5_5, mode: 'sync' })).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(priceTokens(t(100_001, 1000), { model: HAIKU_5_5, mode: 'sync' })).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e6, 12);
    // The tier counts the whole prompt (uncached + cache read + cache write).
    expect(priceTokens(t(50_000, 0, 60_000), { model: HAIKU_5_5, mode: 'sync' })).toBeCloseTo((50_000 * 0.5 + 60_000 * 0.05) / 1e6, 12);
    expect(priceTokens(t(0, 0, 10_000, 10_000, 10_000), { model: HAIKU_5_5, mode: 'sync' })).toBeCloseTo((10_000 * 0.01 + 10_000 * 0.125 + 10_000 * 0.2) / 1e6, 12);
    expect(priceTokens(t(10_000, 1000, 10_000, 0, 10_000), { model: HAIKU_5_5, mode: 'batch' })).toBeCloseTo(
      priceTokens(t(10_000, 1000, 10_000, 0, 10_000), { model: HAIKU_5_5, mode: 'sync' }) / 2,
      12,
    );
    expect(CACHE_WRITE_MULTIPLIER).toEqual({ '5m': 1.25, '1h': 2 });
  });

  it('Sonnet 5.5: $2/$10, cache read $0.20; unknown (fallback) models are priced like the requested one', () => {
    expect(costUsd({ inputTokens: 1e6, outputTokens: 1e6, cacheReadInputTokens: 1e6, cacheCreationInputTokens: 0 }, 'sync', '1h', SONNET_5_5)).toBeCloseTo(2 + 10 + 0.2, 9);
    expect(costUsd({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1e6 }, 'batch', '5m', SONNET_5_5)).toBeCloseTo(2.5 / 2, 9);
    expect(priceTokens(t(1e6, 0), { model: 'claude-sonnet-5', mode: 'sync' })).toBeCloseTo(priceTokens(t(1e6, 0), { model: HAIKU_5_5, mode: 'sync' }), 12);
  });

  it('route estimates follow the resolved model (an override to Sonnet costs 20×)', () => {
    const haiku = estimateRouteUsd(resolveRoute('extract_steady'), { userTokens: 4000, systemTokens: 6000, mode: 'batch' });
    const sonnet = estimateRouteUsd(resolveRoute('extract_steady', { extract_steady: { model: SONNET_5_5 } }), { userTokens: 4000, systemTokens: 6000, mode: 'batch' });
    // Batch: BATCH_CACHE_MISS_SHARE of the prefix is a 1-h write (2× at the 50% batch rate), the rest a read.
    const prefix = 6000 * (1 - BATCH_CACHE_MISS_SHARE) * 0.005 + 6000 * BATCH_CACHE_MISS_SHARE * 0.1;
    expect(haiku).toBeCloseTo((4000 * 0.05 + prefix + ROUTES.extract_steady.estOutputTokens * 0.25) / 1e6, 12);
    expect(sonnet / haiku).toBeCloseTo(20, 6);
  });

  it('estimates: sync reads the prefix, cold calls write it, unmarked routes and sub-512 prefixes pay plain input', () => {
    const out = { outputTokens: 0 };
    const tb = resolveRoute('tiebreak');
    expect(estimateRouteUsd(tb, { userTokens: 0, systemTokens: 1000, mode: 'sync', ...out })).toBeCloseTo((1000 * 0.01) / 1e6, 12);
    expect(estimateRouteUsd(tb, { userTokens: 0, systemTokens: 1000, mode: 'sync', systemCached: false, ...out })).toBeCloseTo((1000 * 0.125) / 1e6, 12);
    expect(estimateRouteUsd(tb, { userTokens: 0, systemTokens: 400, mode: 'sync', ...out })).toBeCloseTo((400 * 0.1) / 1e6, 12);
    expect(estimateRouteUsd(resolveRoute('digest_compose'), { userTokens: 0, systemTokens: 1000, mode: 'sync', ...out })).toBeCloseTo((1000 * 0.1) / 1e6, 12);
    // A sync call on a batch route writes at 5 min.
    expect(estimateRouteUsd(resolveRoute('extract_consolidate'), { userTokens: 0, systemTokens: 1000, mode: 'sync', systemCached: false, ...out })).toBeCloseTo((1000 * 0.125) / 1e6, 12);
    // An explicit miss share overrides the batch default.
    expect(estimateRouteUsd(resolveRoute('extract_steady'), { userTokens: 0, systemTokens: 1000, mode: 'batch', cacheMissShare: 1, ...out })).toBeCloseTo((1000 * 0.1) / 1e6, 12);
  });

  it('refusal re-runs: only Sonnet-sent items on a route still on Sonnet, and only categories the fallback retries', () => {
    expect(refusalRerunnable(SONNET_5_5, SONNET_5_5, 'cyber')).toBe(true);
    expect(refusalRerunnable(SONNET_5_5, SONNET_5_5, 'frontier_llm')).toBe(true);
    for (const c of ['bio', 'general_harms', 'reasoning_extraction', null]) expect(refusalRerunnable(SONNET_5_5, SONNET_5_5, c), String(c)).toBe(false);
    // Override removed since the item went out: the re-run would go to Haiku (no fallback) — a paid second refusal.
    expect(refusalRerunnable(SONNET_5_5, HAIKU_5_5, 'cyber')).toBe(false);
    // Sent on Haiku: never escalated to a bigger model.
    expect(refusalRerunnable(HAIKU_5_5, SONNET_5_5, 'cyber')).toBe(false);
  });

  it('token estimates: ASCII at 3 chars/token, other code points ≥ 1 token (astral 2), so CJK can not undercount', () => {
    expect(estimatePromptTokens('abcdef')).toBe(2);
    expect(estimatePromptTokens(9)).toBe(3);
    expect(estimatePromptTokens('東京で会いましょう')).toBe(9);
    expect(estimatePromptTokens('ab😀')).toBe(3);
    expect(estimatePromptTokens('é')).toBe(1);
    // 60K CJK characters estimate at 60K tokens (a character count / 3 would have said 20K).
    expect(estimatePromptTokens('語'.repeat(60_000))).toBe(60_000);
  });
});

describe('source lint', () => {
  const SRC = path.resolve(import.meta.dirname, '../../src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  it("no 'claude-…' model id outside src/llm/models.ts (every call site takes its model from the route table)", () => {
    const offenders = files(SRC)
      .filter((f) => path.relative(SRC, f) !== path.join('llm', 'models.ts'))
      .flatMap((f) =>
        fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => /['"`]claude-|\bclaude-(?:opus|sonnet|haiku|fable|mythos|instant)\b/i.test(line))
          .map(({ i }) => `${path.relative(SRC, f)}:${i + 1}`),
      );
    expect(offenders).toEqual([]);
  });

  it('request types carry a route, never effort / thinking / cacheTtl / fallbacks / sampling params (compile-time)', () => {
    const S = z.object({ ok: z.boolean() });
    const ok: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', route: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S };
    // @ts-expect-error effort comes from the route table
    const e: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', route: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S, effort: 'low' };
    // @ts-expect-error so does the cache TTL
    const c: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', route: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S, cacheTtl: '1h' };
    // @ts-expect-error and fallbacks (sent only for models that have them)
    const f: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', route: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S, fallbacks: true };
    // @ts-expect-error sampling parameters don't exist at all
    const t: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', route: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S, temperature: 0 };
    // @ts-expect-error a route is required
    const r: LlmParseRequest<{ ok: boolean }> = { kind: 'intent', subjectRef: 's', promptVersion: 'v', system: 's', messages: [], schema: S };
    expect([ok, e, c, f, t, r].length).toBe(6);
  });
});
