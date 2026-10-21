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
  AttachmentImageResponse,
  ChatsResponse,
  CollectorError,
  CollectorErrorCode,
  ContactsResponse,
  EditedResponse,
  HandlesResponse,
  Health,
  MessagesResponse,
  OcrResponse,
  SendResponse,
  WhatsAppSnapshotResponse,
} from '@yb/shared/collector/v1';

const GOLDEN = path.resolve(import.meta.dirname, '../../../collector/Tests/Golden');

const SCHEMAS: Record<string, z.ZodType> = {
  'contacts.json': ContactsResponse,
  'error-image-unreadable.json': CollectorError,
  'error-recipient-not-allowed.json': CollectorError,
  'health.json': Health,
  'imessage-attachment.json': AttachmentImageResponse,
  'imessage-chats.json': ChatsResponse,
  'imessage-edited.json': EditedResponse,
  'imessage-handles.json': HandlesResponse,
  'imessage-messages-by-date.json': MessagesResponse,
  'imessage-messages-page.json': MessagesResponse,
  'imessage-messages.json': MessagesResponse,
  'imessage-send-failed.json': SendResponse,
  'imessage-send.json': SendResponse,
  'vision-ocr.json': OcrResponse,
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

const readGolden = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(GOLDEN, file), 'utf8'));

describe('collector golden files (written by the Swift tests)', () => {
  it('every golden has a schema here, and every schema entry has a golden', () => {
    expect(goldens).toEqual(Object.keys(SCHEMAS).sort());
  });

  it.each(goldens)('%s parses with no key dropped', (file) => {
    const schema = SCHEMAS[file];
    expect(schema, `no schema mapped for ${file}`).toBeDefined();
    const json = readGolden(file);
    const parsed = schema!.safeParse(json);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(strippedKeys(json, parsed.data)).toEqual([]);
  });
});

describe('collector golden values', () => {
  it('vision-ocr: lines in reading order with top-left 0–1 boxes', () => {
    const ocr = OcrResponse.parse(readGolden('vision-ocr.json'));
    expect(ocr.width).toBeGreaterThan(0);
    expect(ocr.lines.map((l) => l.text)).toEqual(['Ada Example', '+1 212 555 0142', 'ada@example.com']);
    const ys = ocr.lines.map((l) => l.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    for (const l of ocr.lines) {
      expect(l.x + l.w).toBeLessThanOrEqual(1);
      expect(l.y + l.h).toBeLessThanOrEqual(1);
    }
    expect(ocr.generated_at).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
  });

  it('error-image-unreadable: a documented collector error code', () => {
    const err = CollectorError.parse(readGolden('error-image-unreadable.json'));
    expect(CollectorErrorCode.parse(err.error.code)).toBe('image_unreadable');
  });

  it('contacts: created_at parses to Unix ms and an unknown one to null', () => {
    const items = ContactsResponse.parse(readGolden('contacts.json')).items;
    expect(items.map((c) => c.created_at)).toEqual([Date.parse('2026-03-03T18:04:05.250Z'), null]);
  });
});
