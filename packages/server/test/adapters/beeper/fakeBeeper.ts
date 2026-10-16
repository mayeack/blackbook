/**
 * In-memory Beeper Desktop API behind an undici MockAgent, shaped like the real v1 API: accounts (Instagram plus an
 * iMessage and a WhatsApp account that must never be read), chats newest-activity first with ≤20 participants per
 * listed chat, message pages of 20 newest first with opaque before-cursors, REACTION items as hidden events, and a
 * Bearer token check. Every request (method + path) is recorded. Synthetic data only.
 */
import { MockAgent } from 'undici';
import { BeeperClient } from '../../../src/adapters/beeper/client';

/** A placeholder origin, never the real Beeper Desktop port: the MockAgent answers, and refuses everything else. */
export const ORIGIN = 'http://127.0.0.1:9';
export const TOKEN = 'synthetic-test-token';
export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
export const MIN = 60_000;

export const IG_ACCOUNT = 'instagramgo.9000000001';
export const ME_IG = '9000000001';
export const ME_MATRIX = '@owner:beeper.com';
export const igUser = (n: string) => `@instagramgo_${n}:beeper.local`;

export const ROBIN = { id: igUser('9000000002'), fullName: 'Robin Example', username: 'robin.example' };
export const SKY = { id: igUser('9000000003'), fullName: 'Sky Sample', username: 'sky.sample' };
export const JORDAN = { id: igUser('9000000004'), fullName: 'Jordan Placeholder', username: 'jordan.placeholder' };
export const SELF_PARTICIPANT = { id: ME_MATRIX, isSelf: true };

export type Json = Record<string, unknown>;

export interface FakeMsgSpec {
  from: Json | 'me';
  at: number;
  text?: string | null;
  type?: string;
  id?: string;
  linkedMessageID?: string;
  reactions?: { participantID: string; reactionKey: string }[];
  attachments?: Json[];
  isDeleted?: boolean;
  editedAt?: number;
}

interface FakeChat {
  chat: Json;
  messages: Json[];
}

const PAGE = 20;
let seq = 1000;

export class FakeBeeper {
  readonly agent = new MockAgent();
  readonly requests: { method: string; path: string }[] = [];
  token = TOKEN;
  accounts: Json[] = [
    {
      accountID: IG_ACCOUNT,
      network: 'Instagram',
      bridge: { id: 'instagramgo', type: 'instagramgo', provider: 'cloud' },
      status: 'connected',
      user: { id: ME_IG, username: 'owner.sample', fullName: 'Owner Sample', isSelf: true },
    },
    { accountID: 'imessage_abc', network: 'iMessage', bridge: { type: 'imessage', provider: 'platform-sdk' }, status: 'connected', user: { id: 'imsg##x' } },
    { accountID: 'local-whatsapp_ba_x', network: 'WhatsApp', bridge: { type: 'whatsapp', provider: 'local' }, status: 'connected', user: { id: '@x:local' } },
  ];
  readonly chats = new Map<string, FakeChat>();
  /** path prefix → forced HTTP status */
  readonly failures = new Map<string, number>();

  constructor() {
    this.agent.disableNetConnect();
    this.agent
      .get(ORIGIN)
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => this.route(opts.method, opts.path, opts.headers))
      .persist();
  }

  client(o: { token?: string } = {}): BeeperClient {
    return new BeeperClient({ baseUrl: ORIGIN, token: o.token ?? TOKEN, dispatcher: this.agent });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** Message requests so far (GET /v1/chats/:id/messages). */
  messageRequests(): string[] {
    return this.requests.filter((r) => /\/messages/.test(r.path)).map((r) => r.path);
  }

  addChat(id: string, o: { type?: 'single' | 'group'; title?: string; participants: Json[]; accountID?: string; lastActivity?: number }): this {
    this.chats.set(id, {
      chat: {
        id,
        accountID: o.accountID ?? IG_ACCOUNT,
        network: o.accountID ? 'Other' : 'Instagram',
        title: o.title ?? 'Chat',
        type: o.type ?? 'single',
        unreadCount: 0,
        participants: { items: o.participants, hasMore: false, total: o.participants.length },
        ...(o.lastActivity ? { lastActivity: new Date(o.lastActivity).toISOString() } : {}),
      },
      messages: [],
    });
    return this;
  }

  setParticipants(chatId: string, participants: Json[]): this {
    const c = this.chats.get(chatId)!;
    c.chat.participants = { items: participants, hasMore: false, total: participants.length };
    return this;
  }

  add(chatId: string, m: FakeMsgSpec): Json {
    const c = this.chats.get(chatId)!;
    const id = m.id ?? String(++seq);
    const fromMe = m.from === 'me';
    const sender = fromMe ? { id: ME_MATRIX } : (m.from as Json);
    const row: Json = {
      id,
      chatID: chatId,
      accountID: c.chat.accountID,
      senderID: sender.id,
      senderName: fromMe ? 'Owner Sample' : sender.fullName,
      sortKey: String(++seq),
      timestamp: new Date(m.at).toISOString(),
      type: m.type ?? 'TEXT',
      isSender: fromMe,
      ...(m.text !== undefined && m.text !== null ? { text: m.text } : {}),
      ...(m.linkedMessageID ? { linkedMessageID: m.linkedMessageID } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      ...(m.isDeleted ? { isDeleted: true } : {}),
      ...(m.editedAt ? { editedTimestamp: new Date(m.editedAt).toISOString() } : {}),
      ...(m.type === 'REACTION' ? { isHidden: true } : {}),
    };
    if (m.reactions) row.reactions = m.reactions.map((r) => ({ id: r.participantID, participantID: r.participantID, reactionKey: r.reactionKey, emoji: true }));
    c.messages.push(row);
    return row;
  }

  /** A reaction: the hidden REACTION event plus the target's reactions[] entry. */
  react(chatId: string, targetId: string, actor: Json | 'me', key: string, at: number): void {
    const target = this.chats.get(chatId)!.messages.find((m) => m.id === targetId)!;
    const participantID = actor === 'me' ? ME_MATRIX : (actor.id as string);
    const list = ((target.reactions as Json[] | undefined) ?? []).filter((r) => r.participantID !== participantID);
    list.push({ id: participantID, participantID, reactionKey: key, emoji: true });
    target.reactions = list;
    this.add(chatId, { from: actor, at, type: 'REACTION', linkedMessageID: targetId });
  }

  unreact(chatId: string, targetId: string, actor: Json | 'me'): void {
    const target = this.chats.get(chatId)!.messages.find((m) => m.id === targetId)!;
    const participantID = actor === 'me' ? ME_MATRIX : (actor.id as string);
    target.reactions = ((target.reactions as Json[] | undefined) ?? []).filter((r) => r.participantID !== participantID);
    if (!(target.reactions as Json[]).length) delete target.reactions;
  }

  private lastActivity(c: FakeChat): number {
    const own = c.chat.lastActivity ? Date.parse(c.chat.lastActivity as string) : 0;
    return Math.max(own, ...c.messages.map((m) => Date.parse(m.timestamp as string)));
  }

  private listed(c: FakeChat, maxParticipants: number): Json {
    const p = c.chat.participants as { items: Json[]; total: number };
    const items = maxParticipants < 0 ? p.items : p.items.slice(0, maxParticipants);
    return { ...c.chat, lastActivity: new Date(this.lastActivity(c)).toISOString(), participants: { items, total: p.total, hasMore: items.length < p.items.length } };
  }

  private route(method: string, fullPath: string, headers: unknown): { statusCode: number; data: object } {
    this.requests.push({ method, path: fullPath });
    const auth = headerValue(headers, 'authorization');
    if (auth !== `Bearer ${this.token}`) return { statusCode: 401, data: { code: 'unauthorized', message: 'bad token' } };
    for (const [prefix, status] of this.failures) if (fullPath.startsWith(prefix)) return { statusCode: status, data: { code: 'forced' } };
    const url = new URL(fullPath, ORIGIN);
    const p = url.pathname;
    if (method !== 'GET') return { statusCode: 500, data: { code: 'write_reached_fake' } };
    if (p === '/v1/accounts') return { statusCode: 200, data: this.accounts };
    if (p === '/v1/chats') {
      const ids = url.searchParams.getAll('accountIDs');
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const start = Number(url.searchParams.get('cursor')?.replace(/^c:/, '') ?? 0);
      const all = [...this.chats.values()]
        .filter((c) => !ids.length || ids.includes(c.chat.accountID as string))
        .sort((a, b) => this.lastActivity(b) - this.lastActivity(a));
      const page = all.slice(start, start + limit);
      return {
        statusCode: 200,
        data: {
          items: page.map((c) => this.listed(c, 20)),
          hasMore: start + limit < all.length,
          oldestCursor: `c:${start + limit}`,
          newestCursor: `c:${start}`,
        },
      };
    }
    const msgs = /^\/v1\/chats\/([^/]+)\/messages$/.exec(p);
    if (msgs) {
      const c = this.chats.get(decodeURIComponent(msgs[1]!));
      if (!c) return { statusCode: 404, data: { code: 'not_found' } };
      const sorted = [...c.messages].sort((a, b) => Number(b.sortKey) - Number(a.sortKey));
      const cursor = url.searchParams.get('cursor');
      const direction = url.searchParams.get('direction') ?? 'before';
      if (cursor && !/^-?\d+$/.test(cursor)) return { statusCode: 400, data: { code: 'bad_cursor' } };
      const pool = !cursor
        ? sorted
        : direction === 'before'
          ? sorted.filter((m) => Number(m.sortKey) < Number(cursor))
          : sorted.filter((m) => Number(m.sortKey) > Number(cursor));
      const page = pool.slice(0, PAGE);
      return {
        statusCode: 200,
        data: {
          items: page,
          hasMore: pool.length > PAGE,
          oldestCursor: page.length ? String(page[page.length - 1]!.sortKey) : null,
          newestCursor: page.length ? String(page[0]!.sortKey) : null,
        },
      };
    }
    const chat = /^\/v1\/chats\/([^/]+)$/.exec(p);
    if (chat) {
      const c = this.chats.get(decodeURIComponent(chat[1]!));
      if (!c) return { statusCode: 404, data: { code: 'not_found' } };
      return { statusCode: 200, data: this.listed(c, Number(url.searchParams.get('maxParticipantCount') ?? 100)) };
    }
    return { statusCode: 404, data: { code: 'not_found' } };
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
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
}
