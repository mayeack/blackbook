import { describe, expect, it } from 'vitest';
import {
  ChatsResponse,
  CollectorError,
  ContactsResponse,
  Health,
  HandlesResponse,
  MessagesQuery,
  MessagesResponse,
  SendRequest,
  SendResponse,
  timestampToMs,
  WhatsAppSnapshotResponse,
} from '../src/collector/v1';

const T = Date.UTC(2026, 9, 13, 19, 4, 5, 123);

// Synthetic payloads only (555-01xx numbers, example.com addresses, invented names).
const msg = {
  rowid: 8812,
  guid: 'A1B2C3D4-0000-4000-8000-000000000001',
  chat_guid: 'iMessage;-;+12125550123',
  chat_style: 45,
  chat_identifier: '+12125550123',
  service: 'iMessage',
  sender_handle: '+12125550123',
  is_from_me: 0,
  date: T,
  text: 'are you free saturday?',
  text_source: 'attributedBody',
  item_type: 0,
  group_action_type: 0,
  is_spam: 0,
  is_delivered: 1,
  error: 0,
  attachments: [{ mime: 'image/heic', uti: 'public.heic', name: 'IMG_0001.HEIC', bytes: 2048, is_sticker: false }],
};

describe('collector v1 contract', () => {
  it('parses a message envelope; omitted optionals become null, 0/1 become booleans', () => {
    const res = MessagesResponse.parse({ api: 'v1', generated_at: new Date(T).toISOString(), items: [msg], next_after_rowid: 8812, has_more: false, max_rowid: 9000 });
    const m = res.items[0]!;
    expect(m.is_from_me).toBe(false);
    expect(m.is_delivered).toBe(true);
    expect(m.date).toBe(T);
    expect(m.date_edited).toBeNull();
    expect(m.chat_display_name).toBeNull();
    expect(m.assoc).toBeNull();
    expect(m.attachments[0]!.is_sticker).toBe(false);
    expect(res.generated_at).toBe(T);
  });

  it('accepts a group send from me with a tapback association', () => {
    const tapback = {
      ...msg,
      rowid: 8813,
      guid: 'A1B2C3D4-0000-4000-8000-000000000002',
      chat_style: 43,
      chat_guid: 'iMessage;+;chat000000000000000001',
      chat_display_name: 'Ski Trip',
      sender_handle: null,
      is_from_me: true,
      text: null,
      text_source: 'none',
      assoc: { type: 2000, target_guid: 'p:0/A1B2C3D4-0000-4000-8000-000000000001', emoji: null },
      attachments: undefined,
    };
    const m = MessagesResponse.parse({ api: 'v1', generated_at: T, items: [tapback] }).items[0]!;
    expect(m.sender_handle).toBeNull();
    expect(m.assoc?.type).toBe(2000);
    expect(m.attachments).toEqual([]);
  });

  it('rejects malformed messages', () => {
    expect(MessagesResponse.safeParse({ api: 'v1', generated_at: T, items: [{ ...msg, guid: '' }] }).success).toBe(false);
    expect(MessagesResponse.safeParse({ api: 'v1', generated_at: T, items: [{ ...msg, text_source: 'ocr' }] }).success).toBe(false);
    expect(MessagesResponse.safeParse({ api: 'v2', generated_at: T, items: [] }).success).toBe(false);
  });

  it('timestamps: ms, seconds and ISO all land on Unix ms', () => {
    expect(timestampToMs(T)).toBe(T);
    expect(timestampToMs(T / 1000)).toBe(T);
    expect(timestampToMs(new Date(T).toISOString())).toBe(T);
  });

  it('query params coerce and cap', () => {
    expect(MessagesQuery.parse({ after_rowid: '10' })).toEqual({ after_rowid: 10, limit: 500 });
    expect(MessagesQuery.safeParse({ after_rowid: '10', limit: '5000' }).success).toBe(false);
    expect(MessagesQuery.safeParse({}).success).toBe(false);
  });

  it('health, chats, handles', () => {
    const h = Health.parse({
      version: '2.0.0',
      build: 42,
      macos: '26.1',
      uptime_s: 12,
      permissions: { fda: true, contacts: 'not_determined', automation_messages: 'granted' },
      chatdb: { max_rowid: 9000, newest_at: T },
      whatsapp: { installed: 1, running: 0, container_mtime: null },
      messages_app_running: true,
    });
    expect(h.permissions.fda).toBe('granted');
    expect(h.build).toBe('42');
    expect(h.whatsapp.running).toBe(false);

    const chats = ChatsResponse.parse({
      api: 'v1',
      generated_at: T,
      items: [{ chat_rowid: 3, chat_guid: 'iMessage;+;chat000000000000000001', style: 43, members: ['+12125550123', 'sam@example.com'] }],
    });
    expect(chats.items[0]!.display_name).toBeNull();
    expect(HandlesResponse.parse({ api: 'v1', generated_at: T, items: [{ rowid: 1, id: '+12125550123', service: 'iMessage' }] }).items).toHaveLength(1);
  });

  it('send request/response', () => {
    expect(SendRequest.parse({ to: 'owner@example.com', text: '🅨 hello', client_ref: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' }).verify_timeout_ms).toBe(8000);
    expect(SendRequest.safeParse({ to: 'x', text: 'y', client_ref: 'not-a-uuid' }).success).toBe(false);
    expect(SendRequest.safeParse({ to: 'x', text: 'hello', client_ref: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' }).success).toBe(false);
    expect(SendRequest.safeParse({ to: 'x', text: ' \u{1F168} hello', client_ref: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' }).success).toBe(false);
    expect(SendResponse.parse({ status: 'delivered', message_guids: ['G1'], rowids: [9001] }).error_code).toBeNull();
    expect(SendResponse.safeParse({ status: 'maybe' }).success).toBe(false);
    expect(CollectorError.parse({ error: { code: 'recipient_not_allowed', message: 'no' } }).error.code).toBe('recipient_not_allowed');
  });

  it('whatsapp snapshot and contacts', () => {
    const snap = WhatsAppSnapshotResponse.parse({
      unchanged: false,
      snapshot_dir: '/tmp/snap',
      files: { chat: '/tmp/snap/ChatStorage.sqlite', contacts: '/tmp/snap/ContactsV2.sqlite' },
      source_mtime: T,
      max_pk: 12,
      bytes: 4096,
    });
    expect(snap.files.lid).toBeNull();
    const contacts = ContactsResponse.parse({
      hash: 'h1',
      items: [
        {
          id: 'AB-1',
          given: 'Sam',
          family: 'Quill',
          phones: [{ label: 'mobile', value: '(212) 555-0123' }],
          emails: [{ value: 'sam@example.com' }],
          birthday: { m: 2, d: 29 },
          social: [{ service: 'Instagram', username: 'samquill.example' }],
          urls: ['https://example.com/sam'],
        },
      ],
    });
    const card = contacts.items[0]!;
    expect(card.emails[0]!.label).toBeNull();
    expect(card.urls[0]).toEqual({ label: null, value: 'https://example.com/sam' });
    expect(card.birthday?.y).toBeNull();
    expect(card.postal).toEqual([]);
  });
});
