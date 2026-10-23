/**
 * A synthetic self-thread world for the commands executor: an in-memory DB with the owner's self conversation,
 * people (invented names), sent digests with items, bot rows, and pending commands; fake LLM/egress/outbound.
 * Nothing here reaches the network (the fakes never send; the suite-wide egress guard is active).
 */
import { uuidv7 } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import { processCommands } from '../../src/commands/executor';
import type { DB } from '../../src/db/connection';
import { createEgress } from '../../src/llm/egress';
import type { LocalLlm } from '../../src/llm/local';
import type { Egress } from '../../src/llm/types';
import type { AttachmentSource } from '../../src/adapters/imessage/attachments';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient, type FakeLlmOptions } from '../fakes/llm';
import { memDb, seedPerson } from '../helpers';

export const TZ = 'America/Chicago';
/** Wed 2026-10-14 08:00 CDT: the brief goes out. */
export const BRIEF_AT = Date.UTC(2026, 9, 14, 13, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface ItemSpec {
  kind?: string;
  personId?: string | null;
  sensitive?: boolean;
  status?: string;
  score?: number;
  title?: string | null;
}

interface CommandRowView {
  id: string;
  status: string;
  intent: string | null;
  target_digest_id: string | null;
  response_outbound_id: string | null;
  batch_id: string | null;
  handled_at: number | null;
}

export function setSetting(db: DB, key: string, value: unknown, now = BRIEF_AT): void {
  db.prepare(
    `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now, now);
}

export function commandsWorld(
  o: { llm?: FakeLlmOptions | FakeLlmClient; outboundConfigured?: boolean; realEgress?: boolean; attachments?: AttachmentSource; local?: LocalLlm } = {},
) {
  const db = memDb();
  setSetting(db, 'tz', TZ);
  let now = BRIEF_AT;
  const clock = () => now;
  const outbound = new FakeOutboundSender({ db, now: clock, configured: o.outboundConfigured ?? true });
  const llm = o.llm instanceof FakeLlmClient ? o.llm : new FakeLlmClient({ configured: false, ...(o.llm ?? {}) });
  const egress: Egress = o.realEgress ? createEgress(db) : new FakeEgress();
  const services: AgentServices = {
    llm,
    egress,
    outbound,
    push: new FakePushSender(),
    ...(o.attachments ? { attachments: o.attachments } : {}),
    ...(o.local ? { local: o.local } : {}),
  };
  const provider = () => services;

  const selfConv = uuidv7(now);
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', 'iMessage;-;self', 'self', ?, ?)`,
  ).run(selfConv, now, now);

  let guidSeq = 0;
  const insertMessage = (text: string, at: number, extra: { isBot?: boolean; replyTo?: number | null; guid?: string; attachments?: object[] } = {}): number =>
    Number(
      db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, reply_to_msg_id,
             is_bot, attachments, ingested_at, updated_at) VALUES ('imessage', ?, ?, NULL, 1, ?, 'text', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          extra.guid ?? `TEST-GUID-${++guidSeq}`,
          selfConv,
          at,
          text,
          extra.replyTo ?? null,
          extra.isBot ? 1 : 0,
          extra.attachments ? JSON.stringify(extra.attachments) : null,
          at,
          at,
        ).lastInsertRowid,
    );

  const world = {
    db,
    llm,
    egress,
    outbound,
    services: provider,
    get now() {
      return now;
    },
    setNow(t: number) {
      now = t;
    },
    person(first: string, last: string | null, extra: Record<string, unknown> = {}): string {
      return seedPerson(db, { first_name: first, last_name: last, display_name: [first, last].filter(Boolean).join(' '), status: 'active', ...extra });
    },
    /**
     * A text the owner typed in the self thread, staged as a pending command the way the iMessage ingest does
     * (`attachments`: chat.db attachment metadata, e.g. a screenshot sent with it).
     */
    say(text: string, at: number = now, extra: { replyTo?: number | null; attachments?: object[] } = {}): { messageId: number; commandId: string } {
      const messageId = insertMessage(text, at, extra);
      const commandId = uuidv7(at);
      db.prepare(`INSERT INTO inbound_commands (id, message_id, raw_text, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).run(commandId, messageId, text, at);
      return { messageId, commandId };
    },
    /** A bot text already in the thread (an ack, an answer): recorded in outbound_messages + its row. */
    botSays(text: string, at: number, digestId: string | null = null, ordinal: number | null = null): number {
      const body = text.startsWith(BOT_MARKER) ? text : `${BOT_MARKER} ${text}`;
      const guid = `TEST-BOT-${++guidSeq}`;
      const outId = uuidv7(at);
      db.prepare(
        `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, message_guids, digest_id, digest_ordinal, created_at, sent_at)
         VALUES (?, ?, ?, 'self@example.com', ?, 'delivered', ?, ?, ?, ?, ?)`,
      ).run(outId, uuidv7(at), digestId ? 'digest' : 'reply', outboundTextHash(body), JSON.stringify([guid]), digestId, ordinal, at, at);
      db.prepare('INSERT INTO outbound_guids (guid, outbound_id) VALUES (?, ?)').run(guid, outId);
      return insertMessage(body, at, { isBot: true, guid });
    },
    /**
     * A sent digest with numbered items, one bot text per item (like the real brief); returns its id, the first
     * text's row id, every item text's row id by ordinal and the suggestion ids by ordinal.
     */
    digest(items: ItemSpec[], at: number = BRIEF_AT, localDate = '2026-10-14') {
      const digestId = uuidv7(at);
      db.prepare(`INSERT INTO digests (id, local_date, status, sent_at, composed_at) VALUES (?, ?, 'sent', ?, ?)`).run(digestId, localDate, at, at - 30 * MIN);
      const suggestionIds = items.map((it, i) => world.suggestion({ status: 'delivered', ...it }, at, `${digestId}:${i}`));
      suggestionIds.forEach((sid, i) => db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, ?, ?)').run(digestId, i + 1, sid));
      const itemMessageIds = items.map((_, i) => world.botSays(`${i === 0 ? `Good morning! ${items.length} things for today.\n\n` : ''}${i + 1}. Item ${i + 1} of ${localDate}`, at + i, digestId, i + 1));
      const messageId = itemMessageIds[0]!;
      db.prepare('UPDATE digests SET outbound_id = (SELECT outbound_id FROM outbound_guids og JOIN messages m ON m.source_msg_id = og.guid WHERE m.id = ?) WHERE id = ?').run(
        messageId,
        digestId,
      );
      return { digestId, messageId, itemMessageIds, suggestionIds };
    },
    suggestion(it: ItemSpec, at: number = now, key = uuidv7(at)): string {
      const id = uuidv7(at);
      db.prepare(
        `INSERT INTO suggestions (id, kind, person_id, dedupe_key, base_score, score, signals, title, sensitive, status, delivered_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        it.kind ?? 'fading',
        it.personId ?? null,
        `${it.kind ?? 'fading'}:${key}`,
        it.score ?? 0.5,
        it.score ?? 0.5,
        it.title ?? null,
        it.sensitive ? 1 : 0,
        it.status ?? 'candidate',
        it.status === 'delivered' ? at : null,
        at,
        at,
      );
      return id;
    },
    run(o2: { now?: number } = {}) {
      if (o2.now !== undefined) now = o2.now;
      return processCommands(db, { services: provider, now: clock });
    },
    replies(): string[] {
      return outbound.sent.map((s) => s.text);
    },
    lastReply(): string | undefined {
      return outbound.sent.at(-1)?.text;
    },
    command(id: string) {
      const r = db.prepare('SELECT * FROM inbound_commands WHERE id = ?').get(id) as CommandRowView & { parsed: string | null };
      return { ...r, parsed: r.parsed ? (JSON.parse(r.parsed) as Record<string, unknown>) : null };
    },
    suggestionStatus(id: string): string {
      return db.prepare('SELECT status FROM suggestions WHERE id = ?').pluck().get(id) as string;
    },
  };
  return world;
}

export type CommandsWorld = ReturnType<typeof commandsWorld>;
