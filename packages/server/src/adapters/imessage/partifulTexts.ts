/**
 * Partiful notification texts (from the verified business chat, short code 39781 or the login-code number) parsed
 * into partiful_text_signals: event id, title, inviter, my RSVP, venue. Templates seen in chat.db (research
 * 2026-10, placeholders only):
 *   invite     "🎉 Hey {me}, {inviter} invited you to {title}!"  + "Reply X to stop invites from this host"
 *   rsvp       "🤘 You're now on the list for {title}!"           (link carries &rsvped=true)
 *   reminder   "⏰ {title} is in 2 hours, at {venue}, {address}!" / "⏰ Hey {me}, 1 week until {title}! …"
 *   blast      "📣 The host of {title} sent a Text Blast: {body}" (body is never stored)
 *   host_rsvp  "Congrats {me}, you got your first RSVP! {guest} responded "Going" to {title}"
 * The link (partiful.com/e/{id}, go.partiful.com/{code}) often arrives as a separate row right after the text;
 * pairing copies the event id onto the template row.
 */
import type { DB } from '../../db/connection';

export const PARTIFUL_PARSER_VERSION = 1;

/** Link row → template row pairing window. */
const PAIR_WINDOW_MS = 120_000;

export type PartifulTextKind = 'invite' | 'rsvp' | 'reminder' | 'blast' | 'host_rsvp' | 'link' | 'other';
export type PartifulRsvp = 'invited' | 'going' | 'maybe' | 'declined' | 'waitlist';

export interface PartifulTextSignal {
  kind: PartifulTextKind;
  eventId: string | null;
  shortCode: string | null;
  updateId: string | null;
  title: string | null;
  inviterName: string | null;
  guestName: string | null;
  rsvp: PartifulRsvp | null;
  venue: string | null;
}

const EVENT_LINK = /(?:https?:\/\/)?(?:www\.)?partiful\.com\/e\/([A-Za-z0-9_-]+)(\?\S*)?/i;
const SHORT_LINK = /(?:https?:\/\/)?go\.partiful\.com\/([A-Za-z0-9_-]+)/i;
const ANY_URL = /(?:https?:\/\/|www\.)\S+|(?:go\.)?partiful\.com\/\S+/gi;
const STOP_LINE = /reply\s+\S+\s+to stop\b.*$/gim;
const APOS = `['’]`;

const LEAD_EMOJI = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;

const TEMPLATES: { kind: PartifulTextKind; re: RegExp; map: (m: RegExpExecArray) => Partial<PartifulTextSignal> }[] = [
  {
    kind: 'invite',
    re: /^Hey\s+.+?,\s+(.+?)\s+invited you to\s+(.+)!$/i,
    map: (m) => ({ inviterName: m[1]!, title: m[2]!, rsvp: 'invited' }),
  },
  {
    kind: 'rsvp',
    re: new RegExp(`^You${APOS}re now on the list for\\s+(.+)!$`, 'i'),
    map: (m) => ({ title: m[1]!, rsvp: 'going' }),
  },
  {
    kind: 'rsvp',
    re: new RegExp(`^You${APOS}re (?:now )?on the waitlist for\\s+(.+)!$`, 'i'),
    map: (m) => ({ title: m[1]!, rsvp: 'waitlist' }),
  },
  {
    kind: 'reminder',
    re: /^(.+?) is in (?:\d+|an?|one|two|three) (?:hours?|minutes?|mins?)(?:,\s*at\s+([^,!]+)(?:,[^!]*)?)?!?$/i,
    map: (m) => ({ title: m[1]!, venue: m[2] ?? null }),
  },
  {
    kind: 'reminder',
    re: /^Hey\s+.+?,\s+(?:\d+|one|two) (?:weeks?|days?) until\s+(.+?)!/i,
    map: (m) => ({ title: m[1]! }),
  },
  {
    kind: 'reminder',
    re: /^(.+?) is (?:tomorrow|today|tonight)\b/i,
    map: (m) => ({ title: m[1]! }),
  },
  {
    kind: 'blast',
    re: /^The host of\s+(.+?)\s+sent a Text Blast:/i,
    map: (m) => ({ title: m[1]! }),
  },
  {
    kind: 'host_rsvp',
    re: /^(?:Congrats\s+.+?,\s+you got your first RSVP!\s*)?(.+?)\s+responded\s+["“](.+?)["”]\s+to\s+(.+?)[.!]?$/i,
    map: (m) => ({ guestName: m[1]!, rsvp: rsvpWord(m[2]!), title: m[3]! }),
  },
];

function rsvpWord(s: string): PartifulRsvp | null {
  const w = s.toLowerCase();
  if (w.startsWith('going')) return 'going';
  if (w.startsWith('maybe')) return 'maybe';
  if (/can.?t go|not going|declin/.test(w)) return 'declined';
  if (w.includes('waitlist')) return 'waitlist';
  return null;
}

const clean = (s: string | null | undefined) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

/** Parses one Partiful text; null for empty input. Unknown shapes come back as kind 'other' (with any link ids). */
export function parsePartifulText(text: string | null): PartifulTextSignal | null {
  if (!text?.trim()) return null;
  const link = EVENT_LINK.exec(text);
  const query = link?.[2] ?? '';
  const out: PartifulTextSignal = {
    kind: 'other',
    eventId: link?.[1] ?? null,
    shortCode: SHORT_LINK.exec(text)?.[1] ?? null,
    updateId: /[?&]update=([A-Za-z0-9_-]+)/.exec(query)?.[1] ?? null,
    title: null,
    inviterName: null,
    guestName: null,
    rsvp: /[?&]rsvped=true/i.test(query) ? 'going' : null,
    venue: null,
  };
  const body = text.replace(STOP_LINE, '').replace(ANY_URL, ' ');
  const lines = body
    .split(/\n+/)
    .map((l) => l.replace(LEAD_EMOJI, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return (out.eventId || out.shortCode) ? { ...out, kind: 'link' } : out;
  for (const line of lines) {
    for (const t of TEMPLATES) {
      const m = t.re.exec(line);
      if (!m) continue;
      const fields = t.map(m);
      return {
        ...out,
        ...fields,
        kind: t.kind,
        title: clean(fields.title),
        inviterName: clean(fields.inviterName),
        guestName: clean(fields.guestName),
        venue: clean(fields.venue),
        rsvp: fields.rsvp ?? out.rsvp,
      };
    }
  }
  return out;
}

interface SignalRow {
  message_id: number;
  kind: PartifulTextKind;
  event_id: string | null;
  short_code: string | null;
  update_id: string | null;
  title: string | null;
  inviter_name: string | null;
  guest_name: string | null;
  rsvp: PartifulRsvp | null;
  venue: string | null;
  conversation_id: string;
  sent_at: number;
  paired_message_id: number | null;
  parser_version: number;
}

/**
 * Upserts the signal for one message (idempotent on message_id) and pairs a text row with its separate link row
 * in the same conversation within two minutes. Returns the parsed signal, or null if the text was empty.
 */
export function storePartifulSignal(
  db: DB,
  m: { messageId: number; conversationId: string; sentAt: number; text: string | null; now: number },
): PartifulTextSignal | null {
  const s = parsePartifulText(m.text);
  if (!s) return null;
  const row = {
    message_id: m.messageId,
    kind: s.kind,
    event_id: s.eventId,
    short_code: s.shortCode,
    update_id: s.updateId,
    title: s.title,
    inviter_name: s.inviterName,
    guest_name: s.guestName,
    rsvp: s.rsvp,
    venue: s.venue,
    conversation_id: m.conversationId,
    sent_at: m.sentAt,
    parser_version: PARTIFUL_PARSER_VERSION,
    now: m.now,
  };
  // event_id/rsvp may have been filled by pairing: a re-parse only overwrites them with real values.
  db.prepare(
    `INSERT INTO partiful_text_signals (message_id, kind, event_id, short_code, update_id, title, inviter_name, guest_name, rsvp,
       venue, conversation_id, sent_at, parser_version, created_at, updated_at)
     VALUES (@message_id, @kind, @event_id, @short_code, @update_id, @title, @inviter_name, @guest_name, @rsvp,
       @venue, @conversation_id, @sent_at, @parser_version, @now, @now)
     ON CONFLICT (message_id) DO UPDATE SET kind = excluded.kind,
       event_id = coalesce(excluded.event_id, event_id), short_code = coalesce(excluded.short_code, short_code),
       update_id = coalesce(excluded.update_id, update_id), title = excluded.title, inviter_name = excluded.inviter_name,
       guest_name = excluded.guest_name, rsvp = coalesce(excluded.rsvp, rsvp), venue = excluded.venue,
       parser_version = excluded.parser_version, updated_at = excluded.updated_at
     WHERE kind IS NOT excluded.kind OR title IS NOT excluded.title OR parser_version <> excluded.parser_version
       OR (excluded.event_id IS NOT NULL AND event_id IS NOT excluded.event_id)
       OR (excluded.rsvp IS NOT NULL AND rsvp IS NOT excluded.rsvp)`,
  ).run(row);
  pair(db, m.messageId, m.now);
  return s;
}

/** Links a template row and a link row of the same conversation that sit within PAIR_WINDOW_MS of each other. */
function pair(db: DB, messageId: number, now: number): void {
  const self = db.prepare('SELECT * FROM partiful_text_signals WHERE message_id = ?').get(messageId) as SignalRow | undefined;
  if (!self || self.paired_message_id !== null) return;
  const isLink = self.kind === 'link';
  if (!isLink && (self.event_id || self.short_code)) return;
  if (isLink && !self.event_id && !self.short_code) return;
  const partner = db
    .prepare(
      isLink
        ? `SELECT * FROM partiful_text_signals WHERE conversation_id = ? AND kind NOT IN ('link','other') AND paired_message_id IS NULL
             AND sent_at BETWEEN ? - ${PAIR_WINDOW_MS} AND ? AND message_id <> ? ORDER BY sent_at DESC, message_id DESC LIMIT 1`
        : `SELECT * FROM partiful_text_signals WHERE conversation_id = ? AND kind = 'link' AND paired_message_id IS NULL
             AND sent_at BETWEEN ? AND ? + ${PAIR_WINDOW_MS} AND message_id <> ? ORDER BY sent_at, message_id LIMIT 1`,
    )
    .get(self.conversation_id, self.sent_at, self.sent_at, messageId) as SignalRow | undefined;
  if (!partner) return;
  const [template, link] = isLink ? [partner, self] : [self, partner];
  db.prepare(
    `UPDATE partiful_text_signals SET event_id = coalesce(event_id, @event_id), short_code = coalesce(short_code, @short_code),
       update_id = coalesce(update_id, @update_id), rsvp = coalesce(rsvp, @rsvp), paired_message_id = @link, updated_at = @now
     WHERE message_id = @template`,
  ).run({
    event_id: link.event_id,
    short_code: link.short_code,
    update_id: link.update_id,
    rsvp: link.rsvp,
    link: link.message_id,
    template: template.message_id,
    now,
  });
  db.prepare('UPDATE partiful_text_signals SET paired_message_id = ?, updated_at = ? WHERE message_id = ?').run(
    template.message_id,
    now,
    link.message_id,
  );
}
