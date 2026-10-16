/**
 * Suggestions: feedback on digest items, "Why this?", and the history list (AGENT_ROUTES 'routes/suggestions.ts').
 *
 *   GET  /suggestions?status=&kind=&personId=&cursor=&limit=   → SuggestionList (people through person_visible)
 *   POST /suggestions/:id/feedback   SuggestionFeedback → SuggestionFeedbackResult
 *        done | snooze{until} | skip | wrong{note?} | why | draft | open | mute{scope}; a journaled side effect
 *        (closing a reply debt, retracting a fact, muting a kind) answers its batchId, undoable from Today
 *   GET  /suggestions/:id/why        → WhyThis (factors incl. the learned ones)
 *
 * Openers returned by `draft` are DRAFTS ONLY: nothing on this path, or any other, sends them.
 */
import { Router } from 'express';
import { SuggestionFeedback, SuggestionListQuery, UuidId } from '@yb/shared';
import { badRequest } from '../http/errors';
import { applySuggestionFeedback, whyThis } from '../pipeline/suggestions/feedback';
import { listSuggestions } from '../pipeline/suggestions/why';
import { servicesFor, type ServicesProvider } from '../services';
import type { RouteDeps } from './index';

const idParam = (raw: unknown): string => {
  const r = UuidId.safeParse(raw);
  if (!r.success) throw badRequest('Malformed suggestion id.');
  return r.data.toLowerCase();
};

export function suggestionsRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const services: ServicesProvider = deps.services ?? ((d) => servicesFor(d, deps.config, deps.log));
  const r = Router();

  r.get('/suggestions', (req, res) => {
    const q = SuggestionListQuery.safeParse(req.query);
    if (!q.success) throw badRequest('Invalid query.', q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    res.json(listSuggestions(db, q.data));
  });

  r.post('/suggestions/:id/feedback', async (req, res) => {
    const id = idParam(req.params.id);
    const body = SuggestionFeedback.parse(req.body);
    res.json(await applySuggestionFeedback(db, id, body, { channel: 'web', now: Date.now(), services }));
  });

  r.get('/suggestions/:id/why', (req, res) => {
    res.json(whyThis(db, idParam(req.params.id)));
  });

  return r;
}
