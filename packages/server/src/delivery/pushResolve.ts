/**
 * Which PushSender a route or job uses (kept apart from push.ts so services.ts → push.ts has no import cycle).
 *
 *   1. injected services (tests) win;
 *   2. VAPID keys from .env (services.push);
 *   3. the secrets-backed sender already registered for this database (routes register it at startup, so jobs —
 *      which have no SECRETS_KEY — reuse it);
 *   4. with SECRETS_KEY: the stored pair (generated once when `generate`, i.e. GET /push/vapid);
 *   5. the inert sender.
 */
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import { resolveServices, type ServicesConfig, type ServicesProvider } from '../services';
import { createPushSender, ensureVapidKeys, loadVapidKeys, registeredPushSender, registerPushSender } from './push';
import type { PushSender } from './types';

export interface PushResolveDeps {
  db: DB;
  services?: ServicesProvider;
  config?: ServicesConfig & { secretsKey?: Buffer | null };
  log?: Logger;
}

export function pushSenderFor(deps: PushResolveDeps, o: { generate?: boolean } = {}): PushSender {
  const services = resolveServices(deps);
  if (deps.services || services.push.configured) return services.push;
  const registered = registeredPushSender(deps.db);
  if (registered?.configured) return registered;
  const secretsKey = deps.config?.secretsKey ?? null;
  const keys = o.generate ? ensureVapidKeys(deps.db, secretsKey) : loadVapidKeys(deps.db, secretsKey);
  if (!keys) return services.push;
  const sender = createPushSender({ vapid: keys, log: deps.log });
  registerPushSender(deps.db, sender);
  return sender;
}
