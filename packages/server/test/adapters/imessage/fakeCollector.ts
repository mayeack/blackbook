/**
 * In-memory collector behind an undici MockAgent: serves synthetic chat.db rows with real rowid paging, checks the
 * Bearer token, and records every request path. Synthetic data only (555-01xx numbers, example.com addresses).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MockAgent } from 'undici';
import { CollectorClient } from '../../../src/adapters/imessage/collectorClient';
import { tempDir } from '../../helpers';

export const BASE = 'http://127.0.0.1:4321';
export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const ME_PHONE = '+15125550100';
export const ME_EMAIL = 'owner@example.com';
export const ALEX = '+15125550101';
export const BLAIR = '+15125550102';
export const CASEY = '+15125550103';
export const DREW = '+15125550104';
export const EMERY = 'emery.vale@example.com';
export const OTP_SENDER = '+15125550199';
export const SHORT_CODE = '24273';
export const PARTIFUL_BIZ = 'urn:biz:29896aa3-06a9-4b54-b544-5e113c222d08';
export const PARTIFUL_SHORT = '39781';

export type Row = Record<string, unknown>;

export interface ChatRef {
  chat_guid: string;
  chat_style: number;
  chat_identifier: string;
  chat_display_name?: string | null;
}

export const dm = (handle: string, service = 'iMessage'): ChatRef => ({ chat_guid: `${service};-;${handle}`, chat_style: 45, chat_identifier: handle });
export const group = (n: number, title: string | null = null): ChatRef => ({
  chat_guid: `iMessage;+;chat${String(n).padStart(18, '0')}`,
  chat_style: 43,
  chat_identifier: `chat${String(n).padStart(18, '0')}`,
  chat_display_name: title,
});
export const selfChat = (): ChatRef => dm(ME_PHONE);

export interface MsgSpec {
  /** Sender handle, or 'me' (is_from_me with no handle, like chat.db's handle_id=0). */
  from: string;
  at: number;
  text?: string | null;
  guid?: string;
  isFromMe?: boolean;
  assoc?: { type: number; target_guid: string; emoji?: string | null };
  itemType?: number;
  groupActionType?: number;
  otherHandle?: number | string | null;
  groupTitle?: string | null;
  balloon?: string | null;
  isSpam?: boolean;
  attachments?: Row[];
  dateEdited?: number | null;
  dateRetracted?: number | null;
  threadOriginator?: string | null;
}

let guidCounter = 0;
export const newGuid = () => `00000000-0000-4000-8000-${String(++guidCounter).padStart(12, '0')}`;

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    return undefined;
  }
  const rec = headers as Record<string, string | string[]>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
};

export class FakeCollector {
  readonly msgs: Row[] = [];
  readonly edited: Row[] = [];
  readonly chats: Row[] = [];
  readonly handles: { rowid: number; id: string; service: string }[] = [];
  readonly calls: string[] = [];
  readonly agent = new MockAgent();
  readonly tokenFile: string;
  token = 'synthetic-test-token';
  /** When set, GET /v1/imessage/messages with this after_rowid answers 503 chatdb_unavailable. */
  failMessagesAfter: number | null = null;
  private rowid = 0;
  private chatRowid = 0;
  private readonly cleanup: () => void;

  constructor() {
    const t = tempDir('yb-collector-');
    this.cleanup = t.cleanup;
    this.tokenFile = path.join(t.dir, 'collector.token');
    this.agent.disableNetConnect();
    this.agent
      .get(BASE)
      .intercept({ path: () => true, method: 'GET' })
      .reply((opts) => this.route(opts.path, opts.headers))
      .persist();
  }

  writeToken(token = this.token): this {
    fs.writeFileSync(this.tokenFile, `${token}\n`, { mode: 0o600 });
    return this;
  }

  client(): CollectorClient {
    return new CollectorClient({ baseUrl: BASE, tokenFile: this.tokenFile, dispatcher: this.agent });
  }

  async close(): Promise<void> {
    await this.agent.close();
    this.cleanup();
  }

  /** Appends a chat.db message row; returns it (guid, rowid). */
  add(chat: ChatRef, s: MsgSpec): Row {
    const mine = s.from === 'me' || s.isFromMe === true;
    const row: Row = {
      rowid: ++this.rowid,
      guid: s.guid ?? newGuid(),
      ...chat,
      chat_display_name: chat.chat_display_name ?? null,
      service: 'iMessage',
      sender_handle: s.from === 'me' ? null : s.from,
      is_from_me: mine ? 1 : 0,
      date: s.at,
      date_edited: s.dateEdited ?? null,
      date_retracted: s.dateRetracted ?? null,
      text: s.text === undefined ? 'hello there' : s.text,
      text_source: s.text === null ? 'none' : 'attributedBody',
      item_type: s.itemType ?? 0,
      group_action_type: s.groupActionType ?? 0,
      other_handle: s.otherHandle ?? null,
      group_title: s.groupTitle ?? null,
      assoc: s.assoc ? { emoji: null, ...s.assoc } : null,
      reply_to_guid: null,
      thread_originator_guid: s.threadOriginator ?? null,
      balloon_bundle_id: s.balloon ?? null,
      is_spam: s.isSpam ? 1 : 0,
      is_delivered: 1,
      error: 0,
      attachments: s.attachments ?? [],
    };
    this.msgs.push(row);
    return row;
  }

  addChat(chat: ChatRef, members: string[], lastAt = T0): Row {
    const row: Row = {
      chat_rowid: ++this.chatRowid,
      chat_guid: chat.chat_guid,
      style: chat.chat_style,
      chat_identifier: chat.chat_identifier,
      display_name: chat.chat_display_name ?? null,
      service: 'iMessage',
      members,
      last_message_at: lastAt,
    };
    this.chats.push(row);
    return row;
  }

  addHandle(id: string): number {
    const rowid = this.handles.length + 1;
    this.handles.push({ rowid, id, service: 'iMessage' });
    return rowid;
  }

  /** Simulates an edit: the row gets new text and date_edited and is served by /edited. */
  edit(row: Row, text: string, at: number): void {
    row.text = text;
    row.date_edited = at;
    this.edited.push(row);
  }

  private envelope(all: Row[], key: string, after: number, limit: number, now = T0) {
    const sorted = [...all].sort((a, b) => Number(a[key]) - Number(b[key]));
    const rest = sorted.filter((r) => Number(r[key]) > after);
    const items = rest.slice(0, limit);
    const last = items.length ? Number(items[items.length - 1]![key]) : after;
    return {
      api: 'v1',
      generated_at: now,
      items,
      next_after_rowid: last,
      has_more: rest.length > items.length,
      max_rowid: sorted.length ? Number(sorted[sorted.length - 1]![key]) : 0,
    };
  }

  private route(rawPath: string, headers: unknown): { statusCode: number; data: object } {
    const url = new URL(rawPath, BASE);
    this.calls.push(`${url.pathname}${url.search}`);
    if (headerValue(headers, 'authorization') !== `Bearer ${this.token}`) {
      return { statusCode: 401, data: { error: { code: 'unauthorized', message: 'bad token' } } };
    }
    const q = url.searchParams;
    const after = Number(q.get('after_rowid') ?? 0);
    const limit = Number(q.get('limit') ?? 500);
    switch (url.pathname) {
      case '/v1/health':
        return {
          statusCode: 200,
          data: {
            version: '1.0.0',
            build: 1,
            macos: '26.0',
            uptime_s: 5,
            permissions: { fda: 'granted', contacts: 'granted', automation_messages: 'not_determined' },
            chatdb: { max_rowid: this.rowid, newest_at: T0 },
            whatsapp: { installed: false, running: false, container_mtime: null },
            messages_app_running: true,
          },
        };
      case '/v1/imessage/messages':
        if (after === this.failMessagesAfter) return { statusCode: 503, data: { error: { code: 'chatdb_unavailable', message: 'busy' } } };
        return { statusCode: 200, data: this.envelope(this.msgs, 'rowid', after, limit) };
      case '/v1/imessage/messages/by-date': {
        const since = Date.parse(q.get('since')!);
        const until = Date.parse(q.get('until')!);
        return { statusCode: 200, data: this.envelope(this.msgs.filter((m) => Number(m.date) >= since && Number(m.date) <= until), 'rowid', after, limit) };
      }
      case '/v1/imessage/edited': {
        const since = Date.parse(q.get('since')!);
        return { statusCode: 200, data: this.envelope(this.edited.filter((m) => Number(m.date_edited) > since), 'rowid', after, limit) };
      }
      case '/v1/imessage/chats':
        return { statusCode: 200, data: this.envelope(this.chats, 'chat_rowid', after, limit) };
      case '/v1/imessage/handles':
        return { statusCode: 200, data: { api: 'v1', generated_at: T0, items: this.handles } };
      default:
        return { statusCode: 404, data: { error: { code: 'not_found', message: 'no route' } } };
    }
  }
}
