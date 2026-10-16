/**
 * Admin interface: a unix socket ($DATA/admin.sock, 0600), never TCP — cloudflared reaches the HTTP port from
 * loopback, so loopback-only HTTP admin routes would be public. Protocol: one JSON request per line,
 * one JSON response per line.
 *   → {"cmd":"status"}                 ← {"ok":true,"data":{…}}
 *   → {"cmd":"run-job","name":"backup"} ← {"ok":true,"data":{job,status,jobRunId,durationMs}}
 *   → {"cmd":"set-self-handles","handles":[…]} ← {"ok":true,"data":{changed}}   (yb setup-self)
 *   ← {"ok":false,"error":{"code","message"}} on failure
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from '../db/connection';
import { currentVersion } from '../db/migrate';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { redact } from '../ops/redact';
import { JobAlreadyRunningError, type Scheduler } from '../scheduler/scheduler';
import { parseSelfHandles, writeSelfHandlesSetting } from '../setup/selfHandles';

export const AdminRequest = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('run-job'), name: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
  z.object({ cmd: z.literal('set-self-handles'), handles: z.array(z.string().max(320)).min(1).max(20) }),
]);
export type AdminRequest = z.infer<typeof AdminRequest>;

export type AdminResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export interface AdminDeps {
  socketPath: string;
  db: DB;
  scheduler: Scheduler;
  version: string;
  startedAt: number;
  log?: Logger;
}

const MAX_LINE = 64 * 1024;

export function serverStatus(d: Pick<AdminDeps, 'db' | 'scheduler' | 'version' | 'startedAt'>) {
  return {
    pid: process.pid,
    version: d.version,
    uptimeS: Math.round((Date.now() - d.startedAt) / 1000),
    schemaVersion: currentVersion(d.db),
    jobs: d.scheduler.status(),
  };
}

async function handle(d: AdminDeps, req: AdminRequest): Promise<AdminResponse> {
  switch (req.cmd) {
    case 'status':
      return { ok: true, data: serverStatus(d) };
    case 'run-job':
      if (!d.scheduler.jobNames().includes(req.name)) return { ok: false, error: { code: 'UNKNOWN_JOB', message: `No job named ${req.name}.` } };
      try {
        return { ok: true, data: await d.scheduler.runNow(req.name) };
      } catch (e) {
        if (e instanceof JobAlreadyRunningError) return { ok: false, error: { code: 'ALREADY_RUNNING', message: e.message } };
        throw e;
      }
    case 'set-self-handles': {
      // Re-validated here: the socket is local, but only normalized phones/emails may become settings.
      const parsed = parseSelfHandles(req.handles.join('\n'));
      if (parsed.rejected || !parsed.handles.length) return { ok: false, error: { code: 'BAD_HANDLES', message: 'Some handles are not valid phones or emails.' } };
      return { ok: true, data: { changed: writeSelfHandlesSetting(d.db, parsed.handles) } };
    }
  }
}

/** Listens on the admin socket (stale socket files are replaced: the data-dir lock proves no other server owns it). */
export async function startAdminServer(d: AdminDeps): Promise<{ close(): Promise<void> }> {
  const log = d.log ?? nullLogger;
  fs.mkdirSync(path.dirname(d.socketPath), { recursive: true, mode: 0o700 });
  fs.rmSync(d.socketPath, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) {
        sock.end(`${JSON.stringify({ ok: false, error: { code: 'TOO_LARGE', message: 'Request too large.' } })}\n`);
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void respond(line).then((res) => {
          if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
  });
  const respond = async (line: string): Promise<AdminResponse> => {
    let parsed: AdminRequest;
    try {
      parsed = AdminRequest.parse(JSON.parse(line));
    } catch {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'Unknown or malformed command.' } };
    }
    try {
      return await handle(d, parsed);
    } catch (e) {
      log.error('admin.command_failed', errorFields(e));
      return { ok: false, error: { code: 'FAILED', message: redact(e) } };
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(d.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(d.socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        fs.rmSync(d.socketPath, { force: true });
      }),
  };
}

export class AdminUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`admin socket unavailable (${code})`);
    this.name = 'AdminUnavailableError';
  }
}

/** Sends one request and resolves with the response. Rejects with AdminUnavailableError if nothing listens. */
export function adminRequest(socketPath: string, req: AdminRequest, timeoutMs = 10 * 60 * 1000): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('admin request timed out'));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as AdminResponse);
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') reject(new AdminUnavailableError(e.code));
      else reject(e);
    });
  });
}
