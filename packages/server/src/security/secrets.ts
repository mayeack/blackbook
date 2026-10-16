import crypto from 'node:crypto';
import type { DB } from '../db/connection';

/**
 * Third-party credentials (Beeper token, Partiful refresh token, Google refresh token, VAPID key) live in the
 * `secrets` table, AES-256-GCM encrypted with SECRETS_KEY from .env. The name is bound in as AAD, so a
 * ciphertext copied onto another row fails to decrypt.
 */
export class SecretsUnavailableError extends Error {
  constructor() {
    super('SECRETS_KEY is not configured.');
    this.name = 'SecretsUnavailableError';
  }
}

export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function requireKey(key: Buffer | null): Buffer {
  if (!key) throw new SecretsUnavailableError();
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes.');
  return key;
}

function checkName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error('invalid secret name');
}

export function setSecret(db: DB, key: Buffer | null, name: string, plaintext: string, now = Date.now()): void {
  checkName(name);
  const k = requireKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  db.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
  ).run(name, ciphertext, iv, tag, now);
}

/** Decrypted value, or null if not set. Throws if the key is wrong or the row was tampered with. */
export function getSecret(db: DB, key: Buffer | null, name: string): string | null {
  checkName(name);
  const row = db.prepare('SELECT ciphertext, iv, tag FROM secrets WHERE name = ?').get(name) as
    | { ciphertext: Buffer; iv: Buffer; tag: Buffer }
    | undefined;
  if (!row) return null;
  const k = requireKey(key);
  const fail = () => new Error(`secret "${name}" could not be decrypted (wrong SECRETS_KEY or corrupted row)`);
  // A truncated tag would otherwise be accepted (GCM verifies however many bytes it is given).
  if (row.iv.length !== IV_BYTES || row.tag.length !== TAG_BYTES) throw fail();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, row.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw fail();
  }
}

export function deleteSecret(db: DB, name: string): boolean {
  checkName(name);
  return db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;
}

/** Names and update times only — never values. */
export function listSecrets(db: DB): { name: string; updatedAt: number }[] {
  return (db.prepare('SELECT name, updated_at FROM secrets ORDER BY name').all() as { name: string; updated_at: number }[]).map(
    (r) => ({ name: r.name, updatedAt: r.updated_at }),
  );
}
