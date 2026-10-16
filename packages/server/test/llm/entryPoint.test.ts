/**
 * One way out: the Anthropic SDK is constructed only in llm/client.ts, on llm/egress.ts' egressFetch, and nothing
 * outside src/llm/ imports the SDK at runtime or names the API host. Every other module reaches Claude through the
 * LlmClient from services.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '../../src');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const rel = (f: string) => path.relative(SRC, f);

describe('LLM single entry point', () => {
  const all = files(SRC).map((f) => ({ f: rel(f), src: fs.readFileSync(f, 'utf8') }));

  it('no runtime import of the Anthropic SDK outside src/llm/ (type-only imports are fine)', () => {
    const bad = all.filter(({ f, src }) => !f.startsWith('llm/') && /^\s*import\s+(?!type\b)[^;]*['"]@anthropic-ai\/sdk[^'"]*['"]/m.test(src));
    expect(bad.map((b) => b.f)).toEqual([]);
  });

  it('the SDK client is built once, in llm/client.ts, on egressFetch', () => {
    const builders = all.filter(({ src }) => /new\s+Anthropic\s*\(/.test(src)).map((b) => b.f);
    expect(builders).toEqual(['llm/client.ts']);
    const client = all.find((b) => b.f === 'llm/client.ts')!.src;
    expect(client).toMatch(/new Anthropic\(\{[\s\S]*fetch: egressFetch\(/);
  });

  it('nothing outside src/llm/ names the API host', () => {
    const bad = all.filter(({ f, src }) => !f.startsWith('llm/') && /api\.anthropic\.com/.test(src)).map((b) => b.f);
    expect(bad).toEqual([]);
  });
});
