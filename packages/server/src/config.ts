import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** The repo root: nearest folder above this file holding packages/server (works from src/ and the dist bundle). */
function findProjectRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'packages', 'server', 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(from, '../../..');
  }
}

export const PROJECT_ROOT = findProjectRoot(import.meta.dirname);
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Yeackbot');
export const DEFAULT_PORT = 4320;

/** macOS caps unix-socket paths at 104 bytes. A deep data dir falls back to a per-dir name in the per-user $TMPDIR (0700). */
const MAX_SOCKET_PATH = 103;
export function adminSocketPathFor(dataDir: string): string {
  const preferred = path.join(dataDir, 'admin.sock');
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `yb-${id}.sock`);
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

export const DEFAULT_BEEPER_URL = 'http://127.0.0.1:23373';
export const DEFAULT_BROWSER_CDP_URL = 'http://127.0.0.1:4331';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_GOOGLE_REDIRECT_URI = 'https://yeackbot.com/api/v1/google/callback';
export const DEFAULT_IMPORTS_DIR = path.join(os.homedir(), 'Yeackbot Imports');

/** An empty `KEY=` line in .env means "use the default". */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);

const urlWithDefault = (fallback: string) => z.preprocess(blankAsUnset, z.url().default(fallback));

/** A local URL (Beeper Desktop, the sandbox browser's DevTools port): never anything off this Mac. */
const loopbackUrl = (fallback: string, what: string) =>
  urlWithDefault(fallback).refine((u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname), `${what} must be on loopback`);

/** "~/x" → "<home>/x" (.env files are not shell-expanded). */
const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

const flag = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.enum(LOOPBACK_HOSTS).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  YB_DATA_DIR: optionalText,
  CF_ACCESS_TEAM: optionalText.refine((v) => v === undefined || /^[a-z0-9-]+$/i.test(v), 'team name only, e.g. "myteam"'),
  CF_ACCESS_AUD: optionalText,
  ALLOWED_EMAIL: optionalText.refine((v) => v === undefined || /^[^@\s]+@[^@\s]+$/.test(v), 'must be an email'),
  SECRETS_KEY: optionalText,
  COLLECTOR_URL: z
    .url()
    .default('http://127.0.0.1:4321')
    .refine((u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname), 'collector must be on loopback'),
  COLLECTOR_TOKEN_FILE: optionalText,
  ANTHROPIC_API_KEY: optionalText,
  OLLAMA_URL: loopbackUrl(DEFAULT_OLLAMA_URL, 'Ollama'),
  VAPID_PUBLIC_KEY: optionalText,
  VAPID_PRIVATE_KEY: optionalText,
  VAPID_SUBJECT: optionalText,
  BEEPER_URL: loopbackUrl(DEFAULT_BEEPER_URL, 'Beeper Desktop API'),
  BEEPER_TOKEN: optionalText,
  BROWSER_CDP_URL: loopbackUrl(DEFAULT_BROWSER_CDP_URL, 'the sandbox browser (CDP)'),
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  GOOGLE_REDIRECT_URI: urlWithDefault(DEFAULT_GOOGLE_REDIRECT_URI),
  IMPORTS_DIR: optionalText,
  DEV_AUTH_BYPASS: flag,
  LOG_STDERR: flag,
});

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: (typeof LOOPBACK_HOSTS)[number];
  port: number;
  dataDir: string;
  dbPath: string;
  lockPath: string;
  backupDir: string;
  logDir: string;
  adminSocketPath: string;
  webDist: string;
  access: { team: string; aud: string; allowedEmail: string } | null;
  /** Non-production only: skips Cloudflare Access verification (refused when NODE_ENV=production). */
  devAuthBypass: boolean;
  /** 32-byte AES-256-GCM key for the secrets table (null = secrets unavailable). */
  secretsKey: Buffer | null;
  collectorUrl: string;
  collectorTokenFile: string;
  anthropicApiKey: string | null;
  /** Ollama on loopback: the local model reads free-text commands before Claude (settings llm.local_*). */
  ollamaUrl: string;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /**
   * Beeper Desktop API on loopback (Instagram network only, GET-only). The env token is a bootstrap: the adapter
   * keeps its token in the secrets table. Never log it.
   */
  beeper: { url: string; token: string | null };
  /** Chrome DevTools endpoint of the sandbox browser (Partiful session). */
  browserCdpUrl: string;
  /** Google Calendar OAuth web client (calendar.readonly); null until the owner creates it. */
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** Watched folder for manual exports (Instagram "Download your information" zips). */
  importsDir: string;
  logToStderr: boolean;
}

export function parseSecretsKey(b64: string): Buffer {
  const s = b64.trim();
  const key = /^[A-Za-z0-9+/_-]{43}=?$/.test(s) ? Buffer.from(s, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).');
  return key;
}

export class ConfigError extends Error {}

/** Parses the environment (zod) into the server config; throws ConfigError with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const problems: string[] = [];

  if (e.DEV_AUTH_BYPASS && production) problems.push('DEV_AUTH_BYPASS is not allowed when NODE_ENV=production.');
  const access =
    e.CF_ACCESS_TEAM && e.CF_ACCESS_AUD && e.ALLOWED_EMAIL
      ? { team: e.CF_ACCESS_TEAM, aud: e.CF_ACCESS_AUD, allowedEmail: e.ALLOWED_EMAIL.toLowerCase() }
      : null;
  if (!access && !(e.DEV_AUTH_BYPASS && !production)) {
    problems.push('CF_ACCESS_TEAM, CF_ACCESS_AUD and ALLOWED_EMAIL are required (or DEV_AUTH_BYPASS=1 outside production).');
  }
  let secretsKey: Buffer | null = null;
  if (e.SECRETS_KEY) {
    try {
      secretsKey = parseSecretsKey(e.SECRETS_KEY);
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else if (production) {
    problems.push('SECRETS_KEY is required in production.');
  }
  const vapidParts = [e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY, e.VAPID_SUBJECT];
  if (vapidParts.some(Boolean) && !vapidParts.every(Boolean)) {
    problems.push('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together.');
  }
  if (Boolean(e.GOOGLE_CLIENT_ID) !== Boolean(e.GOOGLE_CLIENT_SECRET)) {
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.');
  }
  if (production && new URL(e.GOOGLE_REDIRECT_URI).protocol !== 'https:') {
    problems.push('GOOGLE_REDIRECT_URI must be https in production.');
  }

  const dataDir = path.resolve(e.YB_DATA_DIR ?? DEFAULT_DATA_DIR);
  // Tests must never touch the real data dir.
  if (env.VITEST && dataDir === path.resolve(DEFAULT_DATA_DIR)) {
    problems.push('Tests must set YB_DATA_DIR to a temporary directory.');
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'yeackbot.db'),
    lockPath: path.join(dataDir, 'yeackbot.pid'),
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    adminSocketPath: adminSocketPathFor(dataDir),
    webDist: path.join(PROJECT_ROOT, 'packages', 'web', 'dist'),
    access,
    devAuthBypass: e.DEV_AUTH_BYPASS && !production,
    secretsKey,
    collectorUrl: e.COLLECTOR_URL,
    collectorTokenFile: path.resolve(e.COLLECTOR_TOKEN_FILE ?? path.join(dataDir, 'collector.token')),
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    ollamaUrl: e.OLLAMA_URL,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY && e.VAPID_SUBJECT
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
        : null,
    beeper: { url: e.BEEPER_URL, token: e.BEEPER_TOKEN ?? null },
    browserCdpUrl: e.BROWSER_CDP_URL,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri: e.GOOGLE_REDIRECT_URI }
        : null,
    importsDir: path.resolve(expandHome(e.IMPORTS_DIR ?? DEFAULT_IMPORTS_DIR)),
    logToStderr: e.LOG_STDERR || e.NODE_ENV === 'development',
  };
}

export type DataPaths = Pick<AppConfig, 'dataDir' | 'dbPath' | 'lockPath' | 'backupDir' | 'logDir' | 'adminSocketPath'>;

/** Just the data-dir paths (no auth/secrets validation): what the `yb` CLI needs. */
export function dataPaths(env: NodeJS.ProcessEnv = process.env): DataPaths {
  const dataDir = path.resolve(env.YB_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  return {
    dataDir,
    dbPath: path.join(dataDir, 'yeackbot.db'),
    lockPath: path.join(dataDir, 'yeackbot.pid'),
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    adminSocketPath: adminSocketPathFor(dataDir),
  };
}

/** Loads <repo>/.env if present (existing environment variables win). */
export function loadDotEnv(): void {
  const file = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/** Creates the data dir (0700) and its subfolders. */
export function ensureDataDir(config: Pick<AppConfig, 'dataDir' | 'backupDir' | 'logDir'>): void {
  for (const dir of [config.dataDir, config.backupDir, config.logDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(config.dataDir, 0o700);
}
