/**
 * A window's two requests (prompt.ts extractionParts: knowledge always, obligations when they can be kept) and how
 * their answers become one. The window keeps ONE lifecycle: one extraction_items row (the knowledge request's
 * custom_id), one validate, one apply, one journal batch. Both requests go out in the same batch, so a collect
 * sees both results; any failure of either decides for the window (re-queued, refused or dead-lettered together).
 *
 *   custom_ids     knowledge: customId(kind, version, window, attempt); obligations: the same with "_o" after the
 *                  subject (same kind, so llm_requests.kind needs no new value).
 *   joinBatchParts the two batch results → one: errors first (invalid_request > other > canceled > expired), then a
 *                  refusal, then a cut-off; otherwise the answers merged (schema.ts mergeExtractionParts).
 *   parseWindowSync the same two requests synchronously (a refusal re-run on a route with fallbacks; shadow eval).
 */
import type { LlmBatchResult, LlmClient, LlmOutcome, LlmParseRequest, LlmUsage } from '../llm/types';
import { extractionParts, type ExtractionPart } from './prompt';
import { Extraction, mergeExtractionParts } from './schema';

export const OBLIGATIONS_ID_SUFFIX = '_o';
const OBLIGATIONS_ID_RE = /_o-(\d{1,2})$/;

/** The obligations request's custom_id for a window's (knowledge) custom_id. */
export const obligationsCustomId = (knowledgeId: string): string => knowledgeId.replace(/-(\d{1,2})$/, `${OBLIGATIONS_ID_SUFFIX}-$1`);
export const isObligationsCustomId = (id: string): boolean => OBLIGATIONS_ID_RE.test(id);
/** The window's custom_id (extraction_items) a result belongs to. */
export const windowCustomId = (resultId: string): string => resultId.replace(OBLIGATIONS_ID_RE, '-$1');

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Merged JSON text of the parts' answers, or null when one is not a JSON object (→ schema failure). */
export function mergedText(knowledge: string | null, obligations: string | null | undefined): string | null {
  const merged = mergeExtractionParts(parseJson(knowledge), obligations === undefined ? null : (parseJson(obligations) ?? 'invalid'));
  return merged ? JSON.stringify(merged) : null;
}

type Succeeded = Extract<LlmBatchResult, { type: 'succeeded' }>;

/**
 * A window's batch results → one result under the window's custom_id. `obligations` = whether that request was
 * sent; a result missing from the batch counts as an error (the window is re-queued or retried whole).
 */
export function joinBatchParts(knowledge: LlmBatchResult, obligations: LlmBatchResult | null, sentObligations: boolean): LlmBatchResult {
  const customId = knowledge.customId;
  const missing: LlmBatchResult = { customId, type: 'errored', errorType: 'other', message: 'missing_part' };
  const parts = sentObligations ? [knowledge, obligations ?? missing] : [knowledge];
  const failed =
    parts.find((p) => p.type === 'errored' && p.errorType === 'invalid_request') ??
    parts.find((p) => p.type === 'errored') ??
    parts.find((p) => p.type === 'canceled') ??
    parts.find((p) => p.type === 'expired');
  if (failed) return { ...failed, customId };
  const ok = parts as Succeeded[];
  const k = ok[0]!;
  const refused = ok.find((p) => p.stopReason === 'refusal');
  if (refused) return { ...k, stopReason: 'refusal', text: null, refusalCategory: refused.refusalCategory };
  const cut = ok.find((p) => p.stopReason === 'max_tokens');
  if (cut) return { ...k, stopReason: 'max_tokens', text: cut.text };
  const other = ok.find((p) => p.stopReason !== 'end_turn' && p.stopReason !== 'stop_sequence');
  // Usage stays the knowledge request's: each request's own usage and cost are in the ledger.
  return { ...k, stopReason: other?.stopReason ?? k.stopReason, text: mergedText(k.text, sentObligations ? ok[1]!.text : undefined) };
}

const sumUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  costUsd: a.costUsd + b.costUsd,
  batch: a.batch && b.batch,
  servedByModel: b.servedByModel ?? a.servedByModel,
  fallbackUsed: a.fallbackUsed || b.fallbackUsed,
});

export type WindowParseRequest = Omit<LlmParseRequest<unknown>, 'system' | 'schema' | 'validate' | 'estimateUsd'> & {
  /** Estimate per request (its system prompt and expected output). */
  estimateUsd: (part: ExtractionPart) => number;
  /** Replaces a part's system prompt (shadow eval with a prompt file). */
  systems?: Partial<Record<ExtractionPart['name'], string>>;
};

/**
 * A window's requests, one after the other (the knowledge request first), as one outcome: the first request that
 * is not ok decides (its usage plus what was spent before it); otherwise the merged answer, validated as an
 * Extraction. Nothing is sent after a failed part.
 */
export async function parseWindowSync(llm: LlmClient, req: WindowParseRequest, obligations: boolean): Promise<LlmOutcome<Extraction>> {
  const { estimateUsd, systems, ...base } = req;
  const answers: Record<string, string> = {};
  let usage: LlmUsage | null = null;
  let requestId = '';
  for (const part of extractionParts(obligations)) {
    const out = await llm.parse<unknown>({ ...base, system: systems?.[part.name] ?? part.system, schema: part.schema, estimateUsd: estimateUsd(part) });
    if (out.status === 'unavailable') return out;
    usage = usage ? sumUsage(usage, out.usage) : out.usage;
    requestId ||= out.requestId;
    if (out.status !== 'ok') return { ...out, usage, requestId };
    answers[part.name] = out.text;
  }
  const text = mergedText(answers.knowledge ?? null, obligations ? (answers.obligations ?? null) : undefined) ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: 'invalid', issues: ['not JSON'], text, usage: usage!, requestId };
  }
  const parsed = Extraction.safeParse(json);
  if (!parsed.success) return { status: 'invalid', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), text, usage: usage!, requestId };
  return { status: 'ok', value: parsed.data, text, usage: usage!, requestId };
}
