/**
 * Settings API (non-secret keys only; internal keys such as self_handles never leave the server):
 *
 *   GET   /settings     → SettingsResponse {values, defaults, meta, environment}
 *   PATCH /settings     SettingsPatch {values?, reset?} → SettingsPatchResult (one journaled batch, undoable)
 *   GET   /settings/do-not-merge · DELETE /settings/do-not-merge/:a/:b · GET /settings/my-identities  (Privacy)
 *   GET   /settings/export   the JSON export (Data; an attachment for the owner's browser only)
 *
 * Settings → Hidden stays in routes/settings.ts (/settings/hidden…).
 */
import { Router } from 'express';
import { z } from 'zod';
import { SettingsPatch, type BatchRef, type DoNotMergeList, type MyIdentities, type SettingsPatchResult, type SettingsResponse } from '@yb/shared';
import type { DB } from '../db/connection';
import { badRequest } from '../http/errors';
import { spendSnapshot } from '../llm/ledger';
import { DEFAULT_MODEL, LLM_ROUTES, modelLabel, resolveRoute, type RouteOverrides } from '../llm/models';
import { allowMerge, dataExport, doNotMergeList, myIdentities } from './privacy';
import type { RouteDeps } from '../routes/index';
import {
  exposedSettings,
  readSetting,
  settingDefaults,
  settingsMeta,
  SettingsError,
  systemTimeZone,
  writeSettings,
  type AnySettingKey,
} from './registry';

export function settingsResponse(db: DB, config: RouteDeps['config']): SettingsResponse {
  return {
    values: exposedSettings(db),
    defaults: settingDefaults(),
    meta: settingsMeta(db),
    environment: {
      llmConfigured: Boolean(config?.anthropicApiKey),
      pushConfigured: Boolean(config?.vapid),
      systemTimeZone: systemTimeZone(),
      llmSpend: spendSnapshot(db, Date.now()),
      llmModel: llmModelSummary(db),
    },
  };
}

/** "Claude Haiku 5.5" and how many routes run on something else (Settings → llm.route_overrides). */
export function llmModelSummary(db: DB): { label: string; overriddenRoutes: number } {
  const o = readSetting(db, 'llm.route_overrides') as RouteOverrides;
  return { label: modelLabel(DEFAULT_MODEL), overriddenRoutes: LLM_ROUTES.filter((r) => resolveRoute(r, o).overridden).length };
}

export function patchSettings(db: DB, body: unknown, now = Date.now()): SettingsPatchResult {
  const patch = SettingsPatch.parse(body);
  try {
    const { batchId, changed } = writeSettings(db, patch.values, { actor: 'user', reset: (patch.reset ?? []) as AnySettingKey[], now });
    return { batchId, changed, values: exposedSettings(db) };
  } catch (e) {
    if (e instanceof SettingsError) throw badRequest('Some settings are invalid.', e.issues);
    throw e;
  }
}

export function settingsApiRoutes({ db, config }: RouteDeps): Router {
  const r = Router();
  r.get('/settings', (_req, res) => {
    res.json(settingsResponse(db, config));
  });
  r.patch('/settings', (req, res) => {
    res.json(patchSettings(db, req.body));
  });
  const Pair = z.object({ a: z.string().regex(/^[0-9a-f-]{36}$/i), b: z.string().regex(/^[0-9a-f-]{36}$/i) });
  r.get('/settings/do-not-merge', (_req, res) => {
    res.json(doNotMergeList(db) satisfies DoNotMergeList);
  });
  r.delete('/settings/do-not-merge/:a/:b', (req, res) => {
    const { a, b } = Pair.parse(req.params);
    res.json(allowMerge(db, a, b) satisfies BatchRef);
  });
  r.get('/settings/my-identities', (_req, res) => {
    res.json(myIdentities(db) satisfies MyIdentities);
  });
  r.get('/settings/export', (_req, res) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="yeackbot-export-${day}.json"`);
    res.json(dataExport(db, now));
  });
  return r;
}
