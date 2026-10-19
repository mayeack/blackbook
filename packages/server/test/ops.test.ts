import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, DEFAULT_DATA_DIR, loadConfig, parseSecretsKey } from '../src/config';
import { createLogger, fileSink, memorySink, pruneLogs, sanitize } from '../src/ops/logger';
import { redact } from '../src/ops/redact';
import { deleteSecret, getSecret, listSecrets, setSecret, SecretsUnavailableError } from '../src/security/secrets';
import { memDb, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmp = () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('redact', () => {
  it('masks phones, emails and long digit runs, then truncates', () => {
    expect(redact('call +1 212-555-0123 or (212) 555-0199')).toBe('call [phone] or [phone]');
    expect(redact('from +442079460123: hi')).toBe('from [phone]: hi');
    expect(redact('mail sam.q+x@example.com now')).toBe('mail [email] now');
    expect(redact('otp 1234567 / short 123456')).toBe('otp [num] / short 123456');
    expect(redact(new Error('bad 9999999999'))).toBe('bad [num]');
    const long = redact('x'.repeat(1000));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('secrets', () => {
  const key = crypto.randomBytes(32);

  it('round-trips with AES-256-GCM and never stores plaintext', () => {
    const db = memDb();
    setSecret(db, key, 'partiful.refresh_token', 'synthetic-token-value');
    expect(getSecret(db, key, 'partiful.refresh_token')).toBe('synthetic-token-value');
    const raw = db.prepare('SELECT ciphertext, iv, tag FROM secrets').get() as { ciphertext: Buffer; iv: Buffer; tag: Buffer };
    expect(raw.ciphertext.toString('utf8')).not.toContain('synthetic');
    expect(raw.iv).toHaveLength(12);
    expect(raw.tag).toHaveLength(16);
    setSecret(db, key, 'partiful.refresh_token', 'rotated');
    expect(getSecret(db, key, 'partiful.refresh_token')).toBe('rotated');
    expect(listSecrets(db).map((s) => s.name)).toEqual(['partiful.refresh_token']);
    expect(getSecret(db, key, 'missing')).toBeNull();
    expect(deleteSecret(db, 'partiful.refresh_token')).toBe(true);
  });

  it('fails with the wrong key, a moved row, or no key', () => {
    const db = memDb();
    setSecret(db, key, 'beeper.token', 'abc');
    expect(() => getSecret(db, crypto.randomBytes(32), 'beeper.token')).toThrow(/could not be decrypted/);
    db.prepare(`INSERT INTO secrets (name, ciphertext, iv, tag, updated_at) SELECT 'google.refresh', ciphertext, iv, tag, 1 FROM secrets`).run();
    expect(() => getSecret(db, key, 'google.refresh')).toThrow(/could not be decrypted/); // AAD binds the name
    expect(() => setSecret(db, null, 'x', 'y')).toThrow(SecretsUnavailableError);
    expect(() => setSecret(db, key, 'Bad Name', 'y')).toThrow(/invalid secret name/);
  });

  it('rejects a truncated auth tag or a wrong-size iv', () => {
    const db = memDb();
    setSecret(db, key, 'beeper.token', 'abc');
    expect(db.prepare(`SELECT length(iv), length(tag) FROM secrets`).raw().get()).toEqual([12, 16]);
    db.prepare(`UPDATE secrets SET tag = substr(tag, 1, 4)`).run();
    expect(() => getSecret(db, key, 'beeper.token')).toThrow(/could not be decrypted/);
    setSecret(db, key, 'beeper.token', 'abc');
    db.prepare(`UPDATE secrets SET iv = CAST(iv || x'00' AS BLOB)`).run();
    expect(() => getSecret(db, key, 'beeper.token')).toThrow(/could not be decrypted/);
  });

  it('parses SECRETS_KEY', () => {
    const b64 = crypto.randomBytes(32).toString('base64');
    expect(parseSecretsKey(b64)).toHaveLength(32);
    expect(parseSecretsKey(crypto.randomBytes(32).toString('base64url'))).toHaveLength(32);
    expect(() => parseSecretsKey(crypto.randomBytes(16).toString('base64'))).toThrow();
    expect(() => parseSecretsKey('not base64!')).toThrow();
  });
});

describe('config', () => {
  const base = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-config-test' };
  const access = { CF_ACCESS_TEAM: 'team', CF_ACCESS_AUD: 'aud', ALLOWED_EMAIL: 'Owner@Example.com' };

  it('defaults to loopback:4320 and lowercases the allowed email', () => {
    const c = loadConfig({ ...base, ...access });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(4320);
    expect(c.access).toEqual({ team: 'team', aud: 'aud', allowedEmail: 'owner@example.com' });
    expect(c.collectorUrl).toBe('http://127.0.0.1:4321');
    expect(c.dbPath).toBe(path.join('/tmp/yb-config-test', 'yeackbot.db'));
    expect(c.collectorTokenFile).toBe(path.join('/tmp/yb-config-test', 'collector.token'));
  });

  it('DEV_AUTH_BYPASS only outside production', () => {
    expect(loadConfig({ ...base, DEV_AUTH_BYPASS: '1' }).devAuthBypass).toBe(true);
    expect(() =>
      loadConfig({ ...base, ...access, NODE_ENV: 'production', DEV_AUTH_BYPASS: '1', SECRETS_KEY: crypto.randomBytes(32).toString('base64') }),
    ).toThrow(/DEV_AUTH_BYPASS is not allowed/);
  });

  it('rejects unsafe or incomplete settings', () => {
    expect(() => loadConfig(base)).toThrow(ConfigError); // no Access, no bypass
    expect(() => loadConfig({ ...base, ...access, HOST: '0.0.0.0' })).toThrow(/HOST/);
    expect(() => loadConfig({ ...base, ...access, COLLECTOR_URL: 'http://192.0.2.1:4321' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, ...access, NODE_ENV: 'production' })).toThrow(/SECRETS_KEY is required/);
    expect(() => loadConfig({ ...base, ...access, VAPID_PUBLIC_KEY: 'x' })).toThrow(/VAPID/);
    expect(() => loadConfig({ ...base, ...access, SECRETS_KEY: 'short' })).toThrow(/SECRETS_KEY/);
  });

  it('refuses the real data dir under tests', () => {
    expect(() => loadConfig({ VITEST: '1', ...access })).toThrow(/temporary directory/);
    expect(() => loadConfig({ VITEST: '1', ...access, YB_DATA_DIR: DEFAULT_DATA_DIR })).toThrow(/temporary directory/);
  });
});

describe('logger', () => {
  it('keeps only allow-listed fields and redacts error text', () => {
    const rec = sanitize('error', 'job.failed', {
      job: 'imessage-tail',
      ids: ['01a13ba4-0000-7000-8000-000000000000', 42, 'Sam Quill', '+12125550123'],
      counts: { messages: 12, 'bad key!': 3 },
      error_message: 'sender +12125550123 sam@example.com',
      // @ts-expect-error unknown fields are dropped at runtime too
      text: 'secret message body',
    });
    expect(rec).toMatchObject({ level: 'error', event: 'job.failed', job: 'imessage-tail', ids: ['01a13ba4-0000-7000-8000-000000000000', 42], counts: { messages: 12 } });
    expect(rec.error_message).toBe('sender [phone] [email]');
    expect(JSON.stringify(rec)).not.toMatch(/Sam Quill|secret message|555/);
  });

  it('keeps an upstream request id only in its req_… shape', () => {
    expect(sanitize('warn', 'llm_call_failed', { request_id: 'req_011CSynthetic' }).request_id).toBe('req_011CSynthetic');
    for (const bad of ['sam@example.com', 'req_with space', 'Sam Quill']) expect(sanitize('warn', 'llm_call_failed', { request_id: bad })).not.toHaveProperty('request_id');
  });

  it('writes JSONL files and prunes old ones', () => {
    const dir = tmp();
    const mem = memorySink();
    const log = createLogger([fileSink(dir, 'UTC'), mem]);
    log.info('boot.ok', { counts: { n: 1 } });
    log.debug('hidden');
    expect(mem.records).toHaveLength(1);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim())).toMatchObject({ event: 'boot.ok', counts: { n: 1 } });
    fs.writeFileSync(path.join(dir, 'server-2020-01-01.jsonl'), '');
    expect(pruneLogs(dir, 14)).toEqual(['server-2020-01-01.jsonl']);
    expect(fs.statSync(path.join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });
});
