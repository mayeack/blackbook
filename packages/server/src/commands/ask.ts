/**
 * `? …` over iMessage: the shared Ask engine through its iMessage entry point (ask/imessage.ts
 * askForImessage — channel 'imessage', effort low, ≤600 characters with the marker, footnotes, only yeackbot.com
 * links, sensitive sentences removed). This adapter adds the fallbacks the commands need:
 *   - no LLM and nothing found → "Ask needs the AI key";
 *   - the engine failing outright → a pointer to the web;
 *   - belt and braces: an answer citing a sensitive fact never goes out (the tools shouldn't return one).
 */
import type { AskCitation } from '@yb/shared';
import { askForImessage, type ImessageAnswer } from '../ask/imessage';
import { decodeRef } from '../ask/refs';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import type { ServicesConfig, ServicesProvider } from '../services';

export const ASK_LINK = 'yeackbot.com/ask';
export const ASK_NEEDS_KEY = `I need the AI key to answer questions. You can still search at ${ASK_LINK}`;
const ASK_FAILED = `I hit a problem answering that. Try ${ASK_LINK}`;
const ASK_PERSONAL = `That answer touches something personal, so it's only in the app: ${ASK_LINK}`;
/** iMessage p95 target is 30 s; give up well before the scheduler lease. */
const ASK_TIMEOUT_MS = 60_000;
/** Reasons a degraded answer means "no AI" (as opposed to a refusal or a tool budget). */
const NO_AI = new Set(['no_key', 'disabled', 'budget_daily', 'budget_monthly', 'budget_backfill']);

export interface AskReply {
  /** Reply body without the marker. */
  text: string;
  degraded: boolean;
  conversationId: string | null;
}

/** Whether any cited fact (`F<base36 seq>`) is sensitive. */
function citesSensitive(db: DB, citations: AskCitation[]): boolean {
  const q = db.prepare('SELECT sensitive FROM facts WHERE seq = ?').pluck();
  return citations.some((c) => {
    const r = c.kind === 'fact' ? decodeRef(c.ref) : null;
    return !!r && r.kind === 'fact' && q.get(r.n) === 1;
  });
}

export async function answerOverImessage(
  deps: { db: DB; services?: ServicesProvider; config?: ServicesConfig; log?: Logger; signal?: AbortSignal },
  question: string,
  now: number,
): Promise<AskReply> {
  const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let r: ImessageAnswer;
  try {
    r = await askForImessage(question.slice(0, 2000), { db: deps.db, services: deps.services, config: deps.config, log: deps.log, now, signal });
  } catch (e) {
    deps.log?.warn('commands.ask_failed', { error_class: e instanceof Error ? e.name : 'unknown' });
    return { text: ASK_FAILED, degraded: true, conversationId: null };
  }
  const e = r.engine;
  if (e.error) return { text: ASK_FAILED, degraded: true, conversationId: r.conversationId };
  if (e.degraded && !e.citations.length && !e.people.length && (!e.degradedReason || NO_AI.has(e.degradedReason))) {
    return { text: ASK_NEEDS_KEY, degraded: true, conversationId: r.conversationId };
  }
  if (citesSensitive(deps.db, e.citations)) return { text: ASK_PERSONAL, degraded: e.degraded, conversationId: r.conversationId };
  return { text: r.text, degraded: e.degraded, conversationId: r.conversationId };
}
