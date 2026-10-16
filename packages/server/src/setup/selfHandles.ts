/**
 * `npm run setup:self` (`yb setup-self`): the owner's own iMessage handles. They come from a local git-ignored file
 * (default `<repo>/self-handles.local`, one handle per line, `#` comments), never from argv (shell history), and
 * are never echoed. Two outputs:
 *   - settings.self_handles (a journaled 'setting' batch): self-thread detection, the "me" person, command staging;
 *   - collector/Generated/SelfHandles.generated.swift (git-ignored): the send allowlist compiled into the signed
 *     collector, which only takes effect after the collector is rebuilt and reinstalled.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/connection';
import { withBatch } from '../journal/batch';
import { withRun } from '../journal/runs';
import { handleKey } from '../identity/resolver';

export const SELF_HANDLES_FILE = 'self-handles.local';
export const GENERATED_SWIFT = path.join('collector', 'Generated', 'SelfHandles.generated.swift');
const MAX_HANDLES = 20;
/** What a normalized E.164 phone or email may contain: anything else never reaches the Swift source. */
const SAFE = /^[A-Za-z0-9.+_@-]{3,254}$/;

export interface ParsedSelfHandles {
  handles: string[];
  phones: number;
  emails: number;
  rejected: number;
}

/** Normalizes each line to an E.164 phone or a lowercase email; anything else is rejected (counted, not shown). */
export function parseSelfHandles(text: string): ParsedSelfHandles {
  const out = new Set<string>();
  let rejected = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const k = handleKey(line);
    const ok = k && ((k.kind === 'phone' && k.confidence === 1) || k.kind === 'email') && SAFE.test(k.key);
    if (ok) out.add(k.key);
    else rejected++;
  }
  const handles = [...out].sort().slice(0, MAX_HANDLES);
  rejected += out.size - handles.length;
  const emails = handles.filter((h) => h.includes('@')).length;
  return { handles, phones: handles.length - emails, emails, rejected };
}

export function selfHandlesSwift(handles: readonly string[]): string {
  for (const h of handles) if (!SAFE.test(h)) throw new Error('refusing to write an unexpected handle into Swift source');
  return [
    '// Written by `npm run setup:self`. Git-ignored: never commit (the repo is public).',
    '// The only handles the collector will ever message, and only while chat.db shows them as this Mac\'s own.',
    '',
    'enum GeneratedSelfHandles {',
    '    static let handles: [String] = [',
    ...handles.map((h) => `        "${h}",`),
    '    ]',
    '}',
    '',
  ].join('\n');
}

export function writeSelfHandlesSwift(projectRoot: string, handles: readonly string[]): string {
  const file = path.join(projectRoot, GENERATED_SWIFT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, selfHandlesSwift(handles), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Journaled (undoable) write of settings.self_handles; returns false when the stored list is already this one. */
export function writeSelfHandlesSetting(db: DB, handles: readonly string[], now = Date.now()): boolean {
  const value = JSON.stringify([...handles]);
  return withRun(
    db,
    'user',
    (runId) =>
      withBatch(
        db,
        { runId, kind: 'setting', title: 'Updated your own iMessage handles', actor: 'user' },
        (t) => {
          if (t.get('settings', { key: 'self_handles' })) return t.update('settings', { key: 'self_handles' }, { value });
          t.insert('settings', { key: 'self_handles', value });
          return true;
        },
        { now },
      ).result,
    { now },
  );
}
