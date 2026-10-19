/**
 * `yb llm-smoke [--live] [--model <id>] [--only <name,…>]`: every schema in llmSchemas.ts against the API's schema
 * compiler. Without --live nothing is sent: it prints each schema's grammar nodes (llm/client.ts GRAMMAR_MAX_NODES)
 * and any local issue. With --live (and ANTHROPIC_API_KEY) it sends one empty synchronous request per schema, built
 * like the real one on its route (model, thinking, effort, cache marker, output format or strict tools), and
 * prints only the HTTP status and the API's error text. Exit 0 when every schema passes.
 */
import { GRAMMAR_MAX_NODES, isAllowedModel, LLM_ROUTES, smokeSchemas, type RouteOverrides, type SchemaSmokeResult } from './llm';
import { LLM_SCHEMAS } from './llmSchemas';

export const LLM_SMOKE_USAGE = `usage: yb llm-smoke [--live] [--model <id>] [--only <name,…>]
  without --live: grammar nodes per schema (budget ${GRAMMAR_MAX_NODES}) and local issues; nothing is sent
  --live          one empty request per schema to the API (needs ANTHROPIC_API_KEY; a fraction of a cent on Haiku)
  --model <id>    send every route on this allowlisted model instead of its default
  --only <names>  just these schemas (comma-separated names from the list)`;

export function formatSmoke(rows: readonly SchemaSmokeResult[]): string[] {
  const w = (k: keyof SchemaSmokeResult) => Math.max(...rows.map((r) => String(r[k]).length));
  return rows.map((r) => `${r.name.padEnd(w('name'))}  ${r.model.padEnd(w('model'))}  ${String(r.nodes).padStart(3)} nodes  ${String(r.status)}${r.detail ? `  ${r.detail}` : ''}`);
}

export async function llmSmokeCommand(args: readonly string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const live = args.includes('--live');
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const model = value('--model');
  if (args.includes('--model') && (!model || !isAllowedModel(model))) {
    io.err(`--model must be one of the allowlisted models`);
    return 2;
  }
  const only = value('--only')?.split(',').map((s) => s.trim());
  const cases = LLM_SCHEMAS.filter((c) => !only || only.includes(c.name));
  if (!cases.length) {
    io.err(`no schema matches --only (known: ${LLM_SCHEMAS.map((c) => c.name).join(', ')})`);
    return 2;
  }
  const apiKey = live ? process.env.ANTHROPIC_API_KEY?.trim() || null : null;
  if (live && !apiKey) {
    io.err('no ANTHROPIC_API_KEY: nothing was sent');
    return 1;
  }
  const overrides: RouteOverrides | null = model ? (Object.fromEntries(LLM_ROUTES.map((r) => [r, { model }])) as RouteOverrides) : null;
  const rows = await smokeSchemas({ apiKey, cases, overrides });
  for (const line of formatSmoke(rows)) io.out(line);
  const bad = rows.filter((r) => (live ? r.status !== 200 : r.status === 'local' || r.nodes > GRAMMAR_MAX_NODES));
  io.out(live ? `${rows.length - bad.length}/${rows.length} accepted by the API` : `${rows.length - bad.length}/${rows.length} within the local checks (nothing sent; --live to ask the API)`);
  return bad.length ? 1 : 0;
}
