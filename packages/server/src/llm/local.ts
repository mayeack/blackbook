/**
 * Local inference through Ollama on loopback (config OLLAMA_URL; settings llm.local_enabled / llm.local_model). It is
 * the FIRST reader of free-text self-thread commands (commands/intent.ts): nothing leaves the Mac and nothing is
 * billed, so a local answer spends no budget and needs no pseudonymization. Claude stays the fallback: whenever this
 * answers anything but 'ok' (or the model isn't sure), the caller takes the Claude route exactly as before.
 *
 *   - POST /api/chat with stream false and `format` = the zod schema as JSON Schema (Ollama compiles it into a
 *     grammar, so the reply always parses), temperature 0, `think: false` on models that think (a structured answer
 *     needs no reasoning trace), keep_alive 30 min (the first call after that loads the model again: a few seconds).
 *   - POST /api/show once per model, cached: is it pulled, can it read images, does it think?
 *   - Bounds the grammar can't enforce are the caller's `validate`, as for Claude.
 *   - Never throws: unreachable / model_missing / timeout / error → 'unavailable'; unparseable output or validate
 *     issues → 'invalid'. Nothing here writes to llm_requests (that ledger prices Claude calls); callers log.
 */
import { z } from 'zod';
import type { LlmImage } from './types';

/** Small enough for a 16 GB Mac mini next to everything else (≈2.5 GB on disk, text only). */
export const DEFAULT_LOCAL_MODEL = 'qwen3:4b';
export const LOCAL_TIMEOUT_MS = 45_000;
const KEEP_ALIVE = '30m';
const NUM_CTX = 8192;
const NUM_PREDICT = 1024;
/** How long /api/show answers are reused: a pulled model stays pulled; a missing one is re-checked sooner. */
const INFO_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 60_000;

export type LocalUnavailableReason = 'unreachable' | 'model_missing' | 'no_vision' | 'timeout' | 'aborted' | 'error';

export type LocalOutcome<T> =
  | { status: 'ok'; value: T; model: string; ms: number }
  | { status: 'invalid'; issues: string[]; model: string; ms: number }
  | { status: 'unavailable'; reason: LocalUnavailableReason; detail?: string };

export interface LocalModelInfo {
  model: string;
  available: boolean;
  vision: boolean;
  thinking: boolean;
}

export interface LocalParseRequest<T> {
  model: string;
  /** Byte-stable instructions (Ollama reuses the prompt prefix of a loaded model). */
  system: string;
  user: string;
  /** Sent only to a model that reads images; to any other the answer is 'unavailable' / 'no_vision'. */
  images?: LlmImage[];
  schema: z.ZodType<T>;
  validate?: (value: T) => string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalLlm {
  readonly url: string;
  /** null = Ollama isn't reachable. */
  info(model: string, signal?: AbortSignal): Promise<LocalModelInfo | null>;
  parse<T>(req: LocalParseRequest<T>): Promise<LocalOutcome<T>>;
}

const formats = new WeakMap<z.ZodType, Record<string, unknown>>();

/**
 * The JSON Schema Ollama gets as `format`: zod's, minus `$schema` and the ±2^53 integer bounds zod adds to every
 * int (a grammar for that range is large and says nothing; the caller's validate checks real bounds).
 */
export function localFormat(schema: z.ZodType): Record<string, unknown> {
  let f = formats.get(schema);
  if (!f) {
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (!v || typeof v !== 'object') return v;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === '$schema') continue;
        if ((k === 'minimum' || k === 'maximum') && typeof x === 'number' && Math.abs(x) >= Number.MAX_SAFE_INTEGER) continue;
        out[k] = strip(x);
      }
      return out;
    };
    f = strip(z.toJSONSchema(schema)) as Record<string, unknown>;
    formats.set(schema, f);
  }
  return f;
}

/** Ollama's `{"error": "…"}`, or the status line. */
async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    return typeof j.error === 'string' ? j.error.slice(0, 200) : `http ${res.status}`;
  } catch {
    return `http ${res.status}`;
  }
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

/** `url`: config OLLAMA_URL (loopback only; default http://127.0.0.1:11434). */
export function createOllamaClient(o: { url: string; fetch?: typeof fetch; now?: () => number }): LocalLlm {
  const url = o.url.replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; info: LocalModelInfo | null }>();

  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    doFetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

  async function info(model: string, signal?: AbortSignal): Promise<LocalModelInfo | null> {
    const hit = cache.get(model);
    if (hit && now() - hit.at < (hit.info?.available ? INFO_TTL_MS : MISSING_TTL_MS)) return hit.info;
    let res: Response;
    try {
      res = await post('/api/show', { model }, signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000));
    } catch {
      cache.set(model, { at: now(), info: null });
      return null;
    }
    let out: LocalModelInfo;
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { capabilities?: unknown };
      const caps = Array.isArray(j.capabilities) ? j.capabilities.filter((c): c is string => typeof c === 'string') : [];
      out = { model, available: true, vision: caps.includes('vision'), thinking: caps.includes('thinking') };
    } else {
      out = { model, available: false, vision: false, thinking: false };
    }
    cache.set(model, { at: now(), info: out });
    return out;
  }

  async function parse<T>(req: LocalParseRequest<T>): Promise<LocalOutcome<T>> {
    const started = now();
    if (req.signal?.aborted) return { status: 'unavailable', reason: 'aborted' };
    const m = await info(req.model, req.signal);
    if (!m) return { status: 'unavailable', reason: 'unreachable' };
    if (!m.available) return { status: 'unavailable', reason: 'model_missing', detail: req.model };
    const images = req.images ?? [];
    if (images.length && !m.vision) return { status: 'unavailable', reason: 'no_vision', detail: req.model };
    const timeout = AbortSignal.timeout(req.timeoutMs ?? LOCAL_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let content: string;
    try {
      const res = await post(
        '/api/chat',
        {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user, ...(images.length ? { images: images.map((i) => i.data) } : {}) },
          ],
          format: localFormat(req.schema),
          stream: false,
          ...(m.thinking ? { think: false } : {}),
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0, num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
        },
        signal,
      );
      if (!res.ok) {
        const detail = await errorText(res);
        if (res.status === 404) cache.delete(req.model);
        return { status: 'unavailable', reason: res.status === 404 ? 'model_missing' : 'error', detail };
      }
      const j = (await res.json()) as { message?: { content?: unknown } };
      content = typeof j.message?.content === 'string' ? j.message.content : '';
    } catch (e) {
      if (isAbort(e)) return { status: 'unavailable', reason: req.signal?.aborted ? 'aborted' : 'timeout' };
      cache.delete(req.model);
      return { status: 'unavailable', reason: 'unreachable', detail: e instanceof Error ? e.name : undefined };
    }
    const ms = now() - started;
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return { status: 'invalid', issues: ['not JSON'], model: req.model, ms };
    }
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return { status: 'invalid', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`), model: req.model, ms };
    const issues = req.validate?.(parsed.data) ?? [];
    if (issues.length) return { status: 'invalid', issues, model: req.model, ms };
    return { status: 'ok', value: parsed.data, model: req.model, ms };
  }

  return { url, info, parse };
}

/** No local model (tests, or Ollama turned off): every parse is 'unreachable'. */
export const disabledLocalLlm: LocalLlm = {
  url: '',
  info: async () => null,
  parse: async () => ({ status: 'unavailable', reason: 'unreachable' }),
};
