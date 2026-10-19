/**
 * Ask your network (web). DTOs in @yb/shared (api/ask.ts); the engine in ../ask.
 *
 *   POST /ask                       AskRequest → text/event-stream: start → (tool_status | delta | citation)* → done | error
 *   GET  /ask/conversations         AskConversationList (most recent first) + suggested prompts
 *   GET  /ask/conversations/:id     AskConversation
 *
 * The POST is a normal JSON + X-YB request (CSRF middleware), validated before the stream opens (bad input → 400
 * JSON, unknown conversation → 404). Once streaming, failures arrive as an `error` frame. A comment frame every
 * 15 s keeps proxies from closing a quiet stream; a client that goes away aborts the turn (no more spend).
 */
import { Router } from 'express';
import { z } from 'zod';
import { AskRequest, encodeSseEvent, UuidId, type AskConversationList, type AskEvent } from '@yb/shared';
import { askNetwork, conversationExists, getConversation, listConversations, suggestedPrompts } from '../ask';
import { notFound } from '../http/errors';
import { resolveServices } from '../services';
import type { RouteDeps } from './index';

const PING_MS = 15_000;

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export function askRoutes(deps: RouteDeps): Router {
  const { db, log } = deps;
  const r = Router();

  r.post('/ask', async (req, res) => {
    const body = AskRequest.parse(req.body ?? {});
    if (body.conversationId !== undefined) {
      if (!UuidId.safeParse(body.conversationId).success || !conversationExists(db, body.conversationId)) throw notFound('Conversation');
    }
    const services = resolveServices(deps);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const send = (e: AskEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(encodeSseEvent(e));
    };
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, PING_MS);
    ping.unref();

    try {
      const out = await askNetwork({
        db,
        question: body.question,
        channel: 'web',
        conversationId: body.conversationId ?? null,
        onEvent: send,
        services: () => services,
        log,
        signal: abort.signal,
      });
      if (out.error || !out.conversationId || !out.turnId) {
        send({ type: 'error', code: out.error?.code ?? 'internal', message: out.error?.message ?? 'Ask failed.' });
      } else {
        send({
          type: 'done',
          conversationId: out.conversationId,
          turnId: out.turnId,
          answer: out.answer,
          citations: out.citations,
          people: out.people,
          list: out.list ?? null,
          degraded: out.degraded,
          usage: out.usage ?? null,
        });
      }
    } catch {
      send({ type: 'error', code: 'internal', message: 'Ask hit a problem. Try again in a moment.' });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  r.get('/ask/conversations', (req, res) => {
    const q = ListQuery.parse(req.query);
    const body: AskConversationList = { conversations: listConversations(db, q.limit), suggestedPrompts: suggestedPrompts(db) };
    res.json(body);
  });

  r.get('/ask/conversations/:id', (req, res) => {
    const id = UuidId.safeParse(req.params.id);
    const c = id.success ? getConversation(db, id.data.toLowerCase()) : null;
    if (!c) throw notFound('Conversation');
    res.json(c);
  });

  return r;
}
