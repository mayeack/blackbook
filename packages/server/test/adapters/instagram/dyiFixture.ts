/**
 * Synthetic Instagram "Download your information" exports for tests: the JSON layout of a real export (threads,
 * followers/following, personal information) with Instagram's latin1 mojibake applied to every string, written as
 * an extracted folder or a zip (a minimal stored-entry zip writer: no extra dependency). Invented names only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** What Instagram's exporter does: each UTF-8 byte of the text becomes one \u00XX code unit. */
export const mojibake = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

const deep = (v: unknown): unknown =>
  typeof v === 'string' ? mojibake(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;

/** JSON as Instagram writes it: mojibake strings, non-ASCII escaped as \u00XX. */
export const dyiJson = (v: unknown): string => JSON.stringify(deep(v), null, 2).replace(/[\u0080-ÿ]/g, (c) => `\\u00${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

export const OWNER = 'Owner Sample';
export const ROBIN = 'Robin Example';
export const SKY = 'Sky Sámple';
export const JORDAN = 'Jordan Placeholder';

export interface ThreadMsg {
  sender_name: string;
  timestamp_ms: number;
  content?: string;
  reactions?: { reaction: string; actor: string; timestamp?: number }[];
  photos?: { uri: string; creation_timestamp: number }[];
  share?: { link: string; share_text?: string };
  is_unsent?: boolean;
}

export function threadJson(o: { participants: string[]; title?: string; folder: string; messages: ThreadMsg[]; stillParticipant?: boolean }): unknown {
  return {
    participants: o.participants.map((name) => ({ name })),
    // Exports list newest first.
    messages: [...o.messages].sort((a, b) => b.timestamp_ms - a.timestamp_ms).map((m) => ({ is_geoblocked_for_viewer: false, ...m })),
    title: o.title ?? o.participants.find((p) => p !== OWNER) ?? '',
    is_still_participant: o.stillParticipant ?? true,
    thread_path: `inbox/${o.folder}`,
    magic_words: [],
  };
}

export const personalJson = (name: string, username: string) => ({
  profile_user: [{ title: '', media_map_data: {}, string_map_data: { Name: { href: '', value: name, timestamp: 0 }, Username: { href: '', value: username, timestamp: 0 } } }],
});

export const followersJson = (rows: { username: string; at: number }[]) =>
  rows.map((r) => ({ title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/${r.username}`, value: r.username, timestamp: Math.round(r.at / 1000) }] }));

/** The 2024+ layout: the username in title, href via /_u/. */
export const followingJson = (rows: { username: string; at: number }[]) => ({
  relationships_following: rows.map((r) => ({ title: r.username, string_list_data: [{ href: `https://www.instagram.com/_u/${r.username}`, timestamp: Math.round(r.at / 1000) }] })),
});

export type ExportFiles = Record<string, string | Buffer>;

export function writeFolder(root: string, files: ExportFiles): void {
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}

/** A zip of `files` (stored entries, UTF-8 names). */
export function zipBuffer(files: ExportFiles): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
