import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** ps output for one process: text, null = no such process, undefined = ps couldn't answer. */
function ps(field: 'command=' | 'lstart=', pid: number): string | null | undefined {
  try {
    return execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) {
    return (e as { status?: number }).status === 1 ? null : undefined; // ps exits 1 when the PID doesn't exist
  }
}

/**
 * PID of the live server holding this data dir's lock, or null (missing or stale lock).
 * The lock records the PID and the process start time: after a crash or reboot the PID can belong to an
 * unrelated process, which then has a different start time. Locks without a start time fall back to
 * "is it a node process?"; if ps can't answer at all, the PID is assumed live.
 */
export function lockOwner(lockPath: string): number | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(lockPath, 'utf8').split('\n');
  } catch {
    return null;
  }
  const pid = Number(lines[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return pid;
  try {
    process.kill(pid, 0); // signal 0 = existence check
  } catch (e) {
    // EPERM means the process exists but belongs to someone else: check it below.
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  const recordedStart = lines[1]?.trim();
  const start = ps('lstart=', pid);
  if (start === null) return null;
  if (recordedStart && start !== undefined) return start === recordedStart ? pid : null;
  const command = ps('command=', pid);
  if (command === null) return null;
  return command === undefined || /node/i.test(command) ? pid : null;
}

/** Claims the data dir for this process; throws if another live server already holds it. */
export function acquireLock(lockPath: string): void {
  const owner = lockOwner(lockPath);
  if (owner != null && owner !== process.pid) {
    throw new Error(
      `Another yeackbot server (pid ${owner}) is already using ${path.dirname(lockPath)}. ` +
        `If it is the background service, stop it with "npm run service:stop" (or use "npm run yb" to talk to it). ` +
        `If no app is running, delete ${lockPath} and try again.`,
    );
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${process.pid}\n${ps('lstart=', process.pid) ?? ''}\n`);
}

export function releaseLock(lockPath: string): void {
  if (lockOwner(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
}
