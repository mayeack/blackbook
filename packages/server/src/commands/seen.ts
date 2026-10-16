/**
 * Tapbacks on the bot's own rows in the self thread mean "seen" only (critic resolution: never `done`). Each one
 * is recorded once as a 'seen' feedback row on the digest it reacted to; nothing else changes and no reply goes out.
 * Only bot rows from the last 36 h are looked at (the window a brief is current).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { digestForBotMessage } from './context';

const WINDOW_MS = 36 * 3_600_000;

export function recordSeenReactions(db: DB, now: number): number {
  const rows = db
    .prepare(
      `SELECT r.source_reaction_id, r.message_id, r.type, r.at FROM messages m
       JOIN message_reactions r ON r.message_id = m.id JOIN conversations c ON c.id = m.conversation_id
       WHERE m.sent_at > ? AND m.is_bot = 1 AND c.kind = 'self' AND r.is_from_me = 1 AND r.removed = 0
         AND NOT EXISTS (SELECT 1 FROM command_seen_reactions sr WHERE sr.source_reaction_id = r.source_reaction_id)
       ORDER BY r.at LIMIT 200`,
    )
    .all(now - WINDOW_MS) as { source_reaction_id: string; message_id: number; type: string; at: number }[];
  if (!rows.length) return 0;
  return tx(db, () => {
    const mark = db.prepare('INSERT OR IGNORE INTO command_seen_reactions (source_reaction_id, message_id, digest_id, seen_at) VALUES (?, ?, ?, ?)');
    const fb = db.prepare(
      `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, created_at)
       VALUES (?, NULL, 'digest', ?, 'seen', ?, 'imessage', ?)`,
    );
    let n = 0;
    for (const r of rows) {
      const digest = digestForBotMessage(db, r.message_id);
      if (!mark.run(r.source_reaction_id, r.message_id, digest?.id ?? null, now).changes) continue;
      if (digest) fb.run(uuidv7(now), digest.id, JSON.stringify({ reaction: r.type, at: r.at }), now);
      n++;
    }
    return n;
  });
}
