/**
 * A small synthetic chat world for the extraction tests. Every name is invented, phones are in the fictional
 * 555-01xx range and emails use example.com. Nothing here resembles real data.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import type { ExtractionDeps } from '../../src/extraction/run';
import type { Egress, EgressPacket, PseudonymizedPacket } from '../../src/llm/types';
import { FakeEgress, FakeLlmClient, type FakeLlmOptions } from '../fakes/llm';
import { memDb, seedIdentity, seedPerson } from '../helpers';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** 2026-10-16 03:30 in America/Chicago (CDT, UTC−5): inside the night's wave window. */
export const NOW = Date.UTC(2026, 9, 16, 8, 30);
export const TZ = 'America/Chicago';

export interface XWorld {
  db: DB;
  me: string;
  sam: string;
  jordan: string;
  priya: string;
  dana: string;
  ids: { me: string; sam: string; jordan: string; priya: string; dana: string };
  dm: string;
  group: string;
  msg(conv: string, from: string | null, at: number, text: string | null, extra?: Record<string, unknown>): number;
  conversation(kind: 'direct' | 'group', members: string[], title?: string | null, memberCount?: number): string;
}

export function buildXWorld(): XWorld {
  const db = memDb();
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('tz', ?, 0, 0)`).run(JSON.stringify(TZ));
  const me = seedPerson(db, { kind: 'me', first_name: 'Robin', last_name: 'Quill', display_name: 'Robin Quill' });
  const sam = seedPerson(db, { first_name: 'Sam', last_name: 'Rivera', display_name: 'Sam Rivera' });
  const jordan = seedPerson(db, { first_name: 'Jordan', last_name: 'Vale', display_name: 'Jordan Vale' });
  const priya = seedPerson(db, { first_name: 'Priya', last_name: 'Nandi', display_name: 'Priya Nandi' });
  const dana = seedPerson(db, { first_name: 'Dana', last_name: 'Kettle', display_name: 'Dana Kettle' });
  const ids = {
    me: seedIdentity(db, me, 'phone', '+12125550100'),
    sam: seedIdentity(db, sam, 'phone', '+12125550101'),
    jordan: seedIdentity(db, jordan, 'phone', '+12125550102'),
    priya: seedIdentity(db, priya, 'phone', '+12125550103'),
    dana: seedIdentity(db, dana, 'phone', '+12125550104'),
  };
  // Dana is known (T ≥ 20) so a first-name match makes her a mentionable.
  db.prepare(`INSERT INTO person_stats (person_id, tie_strength, computed_at) VALUES (?, 35, 0)`).run(dana);

  const conversation = (kind: 'direct' | 'group', members: string[], title: string | null = null, memberCount?: number) => {
    const id = uuidv7();
    db.prepare(
      `INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at) VALUES (?, 'imessage', ?, ?, ?, ?, 0, 0)`,
    ).run(id, id, kind, title, memberCount ?? members.length + 1);
    const ins = db.prepare(`INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`);
    for (const m of members) ins.run(id, m, 0, 0);
    return id;
  };
  const msg = (conv: string, from: string | null, at: number, text: string | null, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      source: 'imessage',
      source_msg_id: uuidv7(),
      conversation_id: conv,
      sender_identity_id: from,
      is_from_me: from === null ? 1 : 0,
      sent_at: at,
      kind: 'text',
      text,
      ingested_at: at,
      updated_at: at,
      ...extra,
    };
    const cols = Object.keys(row);
    const id = Number(db.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
    db.prepare('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?').run(at, conv);
    return id;
  };
  const dm = conversation('direct', [ids.sam]);
  const group = conversation('group', [ids.jordan, ids.priya], 'Climbing crew');
  return { db, me, sam, jordan, priya, dana, ids, dm, group, msg, conversation };
}

/**
 * A FakeEgress that re-scans its own output and throws, like the real pseudonymize(). Its scrub is a single pass, so
 * back-to-back handles ("@a@b") leave the second one raw: the shape that stopped the 2026-10-16 backfill.
 */
export class StrictEgress extends FakeEgress {
  override pseudonymize(packet: EgressPacket): PseudonymizedPacket {
    const out = super.pseudonymize(packet);
    this.scan(out.text);
    return out;
  }
}

/** Two invented handles written back to back (no separator). */
export const ADJACENT_HANDLES = '@trail_mix_42@summit_crew';

/** Fakes whose unscripted replies are valid empty answers (an empty extraction / consolidation). */
export function fakes(o: FakeLlmOptions = {}, egress: FakeEgress = new FakeEgress()): { llm: FakeLlmClient; egress: FakeEgress } {
  const responder = (c: { kind: string }) => ({ json: c.kind === 'consolidate' ? { summary: '', merges: [], invalidate: [] } : extraction() });
  return { llm: new FakeLlmClient({ responder, ...o }), egress };
}

export function deps(w: XWorld, f: { llm: FakeLlmClient; egress: Egress }, now = NOW): ExtractionDeps {
  let t = now;
  return { db: w.db, llm: f.llm, egress: f.egress, now: () => t++ };
}

/** The stored packet of a window (line numbers / tokens for scripting fake replies). */
export function packetOf(db: DB, windowId: string): { lines: { n: number; msgId: number; author: string; role: string; body: string }[]; refs: Record<string, { personId: string }>; facts: Record<string, { factId: string }>; commitments: Record<string, { commitmentId: string }> } {
  return JSON.parse(db.prepare('SELECT packet FROM extraction_packets WHERE window_id = ?').pluck().get(windowId) as string);
}

export function tokenOf(db: DB, windowId: string, personId: string): string {
  const p = packetOf(db, windowId);
  const t = Object.entries(p.refs).find(([, r]) => r.personId === personId)?.[0];
  if (!t) throw new Error('person not in packet');
  return t;
}

export const lineOf = (db: DB, windowId: string, msgId: number): string => `m:${packetOf(db, windowId).lines.find((l) => l.msgId === msgId)!.n}`;

export function windowsOf(db: DB, conv: string): { id: string; status: string; mode: string; wave: number }[] {
  return db.prepare('SELECT id, status, mode, wave FROM windows WHERE conversation_id = ? ORDER BY created_at, from_msg').all(conv) as {
    id: string;
    status: string;
    mode: string;
    wave: number;
  }[];
}

/** An Extraction with everything empty, overridable per field. */
export function extraction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '',
    facts: [],
    commitments: [],
    needs_reply: { state: 'n_a', msg: null, reason: null, urgency: 'normal', conf: 0.5 },
    mentions: [],
    relations: [],
    self_id: [],
    topics: [],
    ...over,
  };
}

export const fact = (subject: string, cat: string, value: string, ev: { msg: string; quote: string }[], conf = 0.9, over: Record<string, unknown> = {}) => ({
  op: 'ADD',
  subject,
  target: null,
  cat,
  value,
  valid_from: null,
  valid_to: null,
  sensitive: false,
  ev,
  conf,
  ...over,
});
