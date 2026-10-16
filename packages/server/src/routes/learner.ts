/**
 * Settings → "What I've learned" (AGENT_ROUTES 'routes/learner.ts'):
 *
 *   GET  /learner           → LearnerState: per-kind propensity + trend, wildcard hit rate, muted/cooled people,
 *                             adaptive cap
 *   POST /learner/reset     LearnerReset {scope: all | kind | person | wildcard} → {reset: n}
 *   POST /learner/unmute    LearnerUnmute {personId, kind?} | {kind} → {ok: true}
 *
 * Learning tunes only the ranker; nothing here moves merge thresholds or fact gates. A kind (un)mute is a setting
 * (learner.muted_kinds), so it is journaled and undoable; arms and per-person state are ranker bookkeeping.
 */
import { Router } from 'express';
import { LearnerReset, LearnerUnmute, UuidId, type LearnerResetResult, type OkResult } from '@yb/shared';
import type { DB } from '../db/connection';
import { badRequest, notFound } from '../http/errors';
import { resetLearner, unmutePerson } from '../pipeline/suggestions/learner';
import { canonOf } from '../pipeline/suggestions/people';
import { learnerState } from '../pipeline/suggestions/state';
import { readSetting, writeSettings } from '../settings/registry';
import type { RouteDeps } from './index';

function personParam(db: DB, raw: string): string {
  if (!UuidId.safeParse(raw).success) throw badRequest('Malformed person id.');
  const id = raw.toLowerCase();
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').pluck().get(id)) throw notFound('Person');
  return canonOf(db, id);
}

export function learnerRoutes({ db }: RouteDeps): Router {
  const r = Router();

  r.get('/learner', (_req, res) => {
    res.json(learnerState(db));
  });

  r.post('/learner/reset', (req, res) => {
    const body = LearnerReset.parse(req.body);
    const now = Date.now();
    const scope = body.scope === 'person' ? { scope: 'person' as const, personId: personParam(db, body.personId) } : body;
    const out: LearnerResetResult = { reset: resetLearner(db, scope, now) };
    res.json(out);
  });

  r.post('/learner/unmute', (req, res) => {
    const body = LearnerUnmute.parse(req.body);
    const now = Date.now();
    if ('personId' in body) {
      unmutePerson(db, personParam(db, body.personId), body.kind, now);
    } else {
      const muted = readSetting(db, 'learner.muted_kinds');
      if (muted.includes(body.kind)) {
        writeSettings(db, { 'learner.muted_kinds': muted.filter((k) => k !== body.kind) }, { actor: 'user', title: 'Unmuted a suggestion kind', now });
      }
    }
    const ok: OkResult = { ok: true };
    res.json(ok);
  });

  return r;
}
