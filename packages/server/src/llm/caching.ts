/**
 * Prompt-caching helpers (claude-api prompt-caching: caching is a PREFIX match; render order tools → system →
 * messages). Every stage keeps one byte-stable system prompt (no timestamps, ids, flags or per-run data) marked
 * cache_control {type:'ephemeral', ttl: route.cacheTtl} (llm/models.ts: 1 h on batch routes, 5 min on sync ones,
 * none on routes whose prefix is never re-read within a TTL);
 * everything volatile goes in the user turn. Thinking and effort are constant per route (changing either between
 * requests invalidates the messages cache). The minimum cacheable prefix on Haiku/Sonnet 5.5 is 512 tokens:
 * shorter prefixes silently don't cache (and aren't charged a write).
 *
 *   systemBlocks(system, '1h')    the request's `system` value
 *   volatileMarkers(system)       why a system prompt would never hit the cache (tests assert it is empty)
 *   outputFormat(schema)          the structured-output format for a zod schema (memoized, so byte-stable)
 *   schemaJson(schema)            its JSON (for promptVersion(system, schemaJson, effort))
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

export type CacheTtl = '5m' | '1h';

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl: CacheTtl };
}

/** The stable system prompt as one cached block (ttl null: no marker, for a prefix that is never re-read). */
export function systemBlocks(system: string, ttl: CacheTtl | null = '1h'): SystemBlock[] {
  return [ttl ? { type: 'text', text: system, cache_control: { type: 'ephemeral', ttl } } : { type: 'text', text: system }];
}

const VOLATILE: { what: string; re: RegExp }[] = [
  { what: 'iso_timestamp', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/ },
  { what: 'epoch_ms', re: /\b1\d{12}\b/ },
  { what: 'epoch_s', re: /\b1\d{9}\b/ },
  { what: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { what: 'today', re: /\b(?:today is|current date|current time|now is)\b/i },
];

/**
 * Silent cache invalidators found in a system prompt (empty = cache-safe). Dates inside few-shot examples are
 * fine only when they are fixed literals; a test per stage asserts this list is empty for its prompt.
 */
export function volatileMarkers(system: string): string[] {
  return VOLATILE.filter((v) => v.re.test(system)).map((v) => v.what);
}

export interface JsonOutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

const formats = new WeakMap<object, JsonOutputFormat>();

/**
 * `output_config.format` for a zod 4 schema (the SDK's zodOutputFormat, which moves constraints the API can't
 * enforce into descriptions). Plain JSON only: the parse function is dropped, the client validates itself.
 */
export function outputFormat(schema: z.ZodType): JsonOutputFormat {
  const hit = formats.get(schema);
  if (hit) return hit;
  const f = zodOutputFormat(schema as never) as unknown as { type: 'json_schema'; schema: Record<string, unknown> };
  const out: JsonOutputFormat = { type: 'json_schema', schema: f.schema };
  formats.set(schema, out);
  return out;
}

/** The schema's JSON, for promptVersion(system, schemaJson, effort). */
export const schemaJson = (schema: z.ZodType): string => JSON.stringify(outputFormat(schema).schema);
