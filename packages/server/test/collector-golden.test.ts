/**
 * Cross-language contract check: the Swift collector tests write collector/Tests/Golden/*.json (synthetic data),
 * and every one must parse with its zod schema here without zod silently dropping a key. A Swift-side rename
 * (chat_guid → chatGuid) would otherwise turn into a null on the Node side instead of a failure. Lives with the
 * server tests because @yb/shared stays free of Node types.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ChatsResponse,
  CollectorError,
  ContactsResponse,
  EditedResponse,
  HandlesResponse,
  Health,
  MessagesResponse,
  SendResponse,
  WhatsAppSnapshotResponse,
} from '@yb/shared/collector/v1';

const GOLDEN = path.resolve(import.meta.dirname, '../../../collector/Tests/Golden');

const SCHEMAS: Record<string, z.ZodType> = {
  'contacts.json': ContactsResponse,
  'error-recipient-not-allowed.json': CollectorError,
  'health.json': Health,
  'imessage-chats.json': ChatsResponse,
  'imessage-edited.json': EditedResponse,
  'imessage-handles.json': HandlesResponse,
  'imessage-messages-by-date.json': MessagesResponse,
  'imessage-messages-page.json': MessagesResponse,
  'imessage-messages.json': MessagesResponse,
  'imessage-send-failed.json': SendResponse,
  'imessage-send.json': SendResponse,
  'whatsapp-snapshot.json': WhatsAppSnapshotResponse,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Input keys missing from the parsed output: keys the schema doesn't declare (zod objects strip them). */
function strippedKeys(input: unknown, output: unknown, at = '$'): string[] {
  if (Array.isArray(input) && Array.isArray(output)) return input.flatMap((v, i) => strippedKeys(v, output[i], `${at}[${i}]`));
  if (!isObject(input) || !isObject(output)) return [];
  return Object.keys(input).flatMap((k) => (k in output ? strippedKeys(input[k], output[k], `${at}.${k}`) : [`${at}.${k}`]));
}

const goldens = fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).sort();

describe('collector golden files (written by the Swift tests)', () => {
  it('every golden has a schema here, and every schema entry has a golden', () => {
    expect(goldens).toEqual(Object.keys(SCHEMAS).sort());
  });

  it.each(goldens)('%s parses with no key dropped', (file) => {
    const schema = SCHEMAS[file];
    expect(schema, `no schema mapped for ${file}`).toBeDefined();
    const json: unknown = JSON.parse(fs.readFileSync(path.join(GOLDEN, file), 'utf8'));
    const parsed = schema!.safeParse(json);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(strippedKeys(json, parsed.data)).toEqual([]);
  });
});
