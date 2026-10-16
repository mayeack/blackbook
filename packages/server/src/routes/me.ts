import { Router } from 'express';
import type { Me } from '@yb/shared';
import type { AuthedUser } from '../http/cfAccess';
import type { RouteDeps } from './index';

export function meRoutes(_deps: RouteDeps): Router {
  const r = Router();
  r.get('/me', (_req, res) => {
    const user = res.locals.user as AuthedUser;
    const body: Me = { email: user.email, via: user.via };
    res.json(body);
  });
  return r;
}
