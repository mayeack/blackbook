/**
 * Settings → Eval (/settings/eval) and the eval report (AGENT_ROUTES 'routes/eval.ts', intelligence §8):
 *
 *   GET  /eval/items?set=&status=&cursor=&limit=   → EvalItemPage  (an empty set is sampled from local data on
 *                                                   first visit; a short one is topped up at most daily)
 *   POST /eval/labels   EvalLabelInput             → EvalLabelResult (one label per item; relabeling replaces it)
 *   GET  /eval/report                              → EvalReport (metrics vs targets; counts and rates only)
 *
 * Golden items live in the local database only; nothing here calls the LLM or sends anything. Labels are the
 * owner's judgements (system tables, not journaled: they change nothing the agent does).
 */
import { Router } from 'express';
import { EvalItemsQuery, EvalLabelInput } from '@yb/shared';
import { buildReport, itemPage, saveLabel } from '../eval';
import type { RouteDeps } from './index';

export function evalRoutes({ db }: RouteDeps): Router {
  const r = Router();

  r.get('/eval/items', async (req, res) => {
    const q = EvalItemsQuery.parse(req.query);
    res.json(await itemPage(db, q));
  });

  r.post('/eval/labels', (req, res) => {
    const body = EvalLabelInput.parse(req.body);
    res.json(saveLabel(db, body));
  });

  r.get('/eval/report', (_req, res) => {
    res.json(buildReport(db));
  });

  return r;
}
