/**
 * The agent's outward-facing services (LLM, egress, outbound iMessage-to-self, web push, command screenshots from
 * the collector), built once per database from the config and shared by routes and jobs. Every one is inert when
 * unconfigured (no API key, no collector, no VAPID keys), so callers always take their deterministic/template path
 * in that case.
 *
 * Route modules:  const { llm } = resolveServices(deps);          (deps: RouteDeps)
 * Job modules:    const { outbound } = resolveServices({ ...deps, db: ctx.db });
 * Tests inject fakes with `services: () => ({ llm: new FakeLlmClient(), … })`.
 */
import { collectorAttachmentSource, disabledAttachmentSource, type AttachmentSource } from './adapters/imessage/attachments';
import type { AppConfig } from './config';
import type { DB } from './db/connection';
import { createOutboundSender } from './delivery/outbound';
import { createPushSender } from './delivery/push';
import type { OutboundSender, PushSender } from './delivery/types';
import { createLlmClient } from './llm/client';
import { createEgress } from './llm/egress';
import type { Egress, LlmClient } from './llm/types';
import type { Logger } from './ops/logger';

export interface AgentServices {
  llm: LlmClient;
  egress: Egress;
  outbound: OutboundSender;
  push: PushSender;
  /** Self-thread command screenshots from the collector (absent = commands are text-only). */
  attachments?: AttachmentSource;
}

export type ServicesProvider = (db: DB) => AgentServices;

export type ServicesConfig = Partial<Pick<AppConfig, 'anthropicApiKey' | 'vapid' | 'collectorUrl' | 'collectorTokenFile'>>;

const cache = new WeakMap<DB, AgentServices>();

/** The default services for `db` (memoized per connection, so routes and jobs share one instance). */
export function servicesFor(db: DB, config?: ServicesConfig, log?: Logger): AgentServices {
  let s = cache.get(db);
  if (!s) {
    const egress = createEgress(db);
    s = {
      egress,
      llm: createLlmClient({ db, apiKey: config?.anthropicApiKey ?? null, egress, log }),
      outbound: createOutboundSender({
        db,
        collector: config?.collectorUrl && config.collectorTokenFile ? { url: config.collectorUrl, tokenFile: config.collectorTokenFile } : null,
        log,
      }),
      push: createPushSender({ vapid: config?.vapid ?? null, log }),
      attachments:
        config?.collectorUrl && config.collectorTokenFile
          ? collectorAttachmentSource({ url: config.collectorUrl, tokenFile: config.collectorTokenFile, log })
          : disabledAttachmentSource,
    };
    cache.set(db, s);
  }
  return s;
}

/** Injected provider if any, else the memoized defaults from config. */
export function resolveServices(deps: { db: DB; services?: ServicesProvider; config?: ServicesConfig; log?: Logger }): AgentServices {
  return deps.services ? deps.services(deps.db) : servicesFor(deps.db, deps.config, deps.log);
}
