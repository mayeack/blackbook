/**
 * POST /api/v1/ask and read the text/event-stream with fetch + ReadableStream (EventSource can't POST). Same rules
 * as the JSON client: same origin, `X-YB: 1`, no redirects (an Access bounce → top-level re-login), JSON errors
 * become ApiError. Frames are parsed with the shared SseParser.
 */
import { SseParser, type AskEvent, type AskRequest } from '@yb/shared/api';
import { ApiError } from '../../api/client';

export interface StreamEnv {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Top-level navigation to "/" so Access can sign the user in again. */
  relogin: () => void;
}

const ctype = (res: Response) => (res.headers.get('content-type') ?? '').toLowerCase();

/** Access answered instead of our server (redirect, or an HTML page where a stream or JSON error belongs). */
function isBounce(res: Response): boolean {
  if (res.type === 'opaqueredirect' || res.type === 'opaque' || res.redirected) return true;
  if (res.status >= 300 && res.status < 400) return true;
  return ctype(res).includes('text/html');
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Streams one question; resolves when the stream ends (after `done` or `error`), rejects on transport errors. */
export async function streamAsk(env: StreamEnv, body: AskRequest, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await env.fetch('/api/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-YB': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      signal,
    });
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    throw new ApiError(0, 'NETWORK', 'Cannot reach yeackbot. Check your connection.');
  }
  if (isBounce(res)) {
    env.relogin();
    throw new ApiError(401, 'SESSION_EXPIRED', 'Your session expired. Signing you in again…');
  }
  if (!res.ok) {
    let err: { code?: string; message?: string } | undefined;
    try {
      err = ((await res.json()) as { error?: { code?: string; message?: string } }).error;
    } catch {
      // not JSON
    }
    if (res.status === 401) env.relogin();
    if (res.status === 429) throw new ApiError(429, err?.code ?? 'RATE_LIMITED', 'Too many questions in a minute. Wait a moment and ask again.');
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.status >= 500 ? 'yeackbot is not responding right now. Try again in a minute.' : 'Ask couldn’t take that question.'));
  }
  if (!ctype(res).includes('text/event-stream') || !res.body) throw new ApiError(res.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
    }
    // A last frame without its blank line.
    for (const e of parser.push(`${decoder.decode()}\n\n`)) onEvent(e);
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    throw new ApiError(0, 'NETWORK', 'The answer was cut off. Check your connection and ask again.');
  } finally {
    reader.releaseLock?.();
  }
}
