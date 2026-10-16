/**
 * Message cross-reference for one occasion (PLAN step 3): every 1:1 and group message in [start − 14 d, end + 2 d]
 * is checked for
 *   - mentions: the occasion's distinctive title/venue/artist tokens (two weak tokens, one strong token, or one
 *     token plus "tickets" or a date phrase that resolves to the occasion's day via chrono-node);
 *   - date phrases resolving to the day ("see you Saturday", "dinner tmrw?"), before the occasion ends;
 *   - "tickets" talk before it starts;
 *   - logistics within ±3 h of the start ("omw", "here", "where are you");
 *   - after-the-fact messages up to 36 h after it ends ("great seeing you", "thanks for dinner");
 *   - photos sent in a 1:1 thread during or just after it.
 * In a 1:1 thread the counterpart gets the signal whoever wrote; in a group the sender does, and a small group
 * that discussed the occasion gives each member a weak 'group_discussed' signal. Message text never leaves this
 * module: only ids and signal types do.
 * Occasions are scanned in start order, so consecutive windows mostly overlap: the scanner keeps the rows of its
 * current window (and their analyses) and reads only the new tail from SQLite, instead of every window's rows.
 */
import * as chrono from 'chrono-node';
import { localParts } from '@yb/shared';
import type { DB } from '../../db/connection';
import { SMALL_GROUP, type PeopleIndex } from './people';
import { WEIGHTS, type Signal } from './signals';
import { words } from './text';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface OccasionWindow {
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  /** Local dates (YYYY-MM-DD) the occasion covers. */
  days: ReadonlySet<string>;
  tokens: readonly string[];
  /** Tokens that alone make a message about the occasion (the venue's main word, long rare words). */
  strong: ReadonlySet<string>;
  /** Event-kind words of the title ("dinner", "drinks"): they make a date phrase specific. */
  kindWords: ReadonlySet<string>;
}

export interface MessageEvidence {
  byPerson: Map<string, Signal[]>;
  /** Messages about the occasion written by the owner (corroborates a shared-calendar event). */
  aboutFromMe: number[];
  /** Messages about it from the other side of 1:1 threads. */
  aboutFromOthersDm: number[];
  /** Group chats that discussed it → message ids. */
  groupsDiscussed: Map<string, number[]>;
  scanned: number;
}

const LOGISTICS =
  /\b(omw|on my way|otw|i'?m here|we'?re here|here now|just got here|got here|i'?m outside|outside now|where (are|r) (you|u|y'?all)|wya|wru|running (late|behind)|be there (in|soon)|almost there|\d+ min(s|utes)? away|leaving now|heading (over|out|there)|parking now|found parking|grabbed a table|got a table|at the bar|at the door|which entrance|see you (soon|there|in a)|cya soon|in line)\b/i;
/** A text that is only "here" (or "here!", "ok here") is an arrival; "here" inside a sentence isn't. */
const JUST_HERE = /^\s*(?:ok(?:ay)?\s+|i'?m\s+|we'?re\s+)?here\s*[!.]*\s*$/i;
export const isLogistics = (text: string): boolean => LOGISTICS.test(text) || JUST_HERE.test(text);
const AFTER =
  /\b((so )?(great|good|nice|lovely|fun|awesome|amazing) (to see|seeing|catching up|hanging)|thanks? (you )?(so much )?for (coming|dinner|drinks|last night|tonight|having (me|us)|hosting|the invite|inviting)|ty for (coming|dinner|last night)|(had|such) an? (great|fun|good|amazing|awesome|lovely) (time|night)|fun (last night|tonight|night)|last night was|that was (so )?(fun|great)|let'?s do (it|that) again|home safe|got home)\b/i;
const TICKETS = /\b(tix|tickets?)\b/i;
const DATEISH =
  /\b(tonight|tomorrow|tmrw|tmr|tomo|today|this (weekend|week|evening|afternoon|morning)|next (week|weekend|mon|tue|wed|thu|fri|sat|sun)\w*|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(st|nd|rd|th)\b/i;
const RELATIVE_DAY = /tonight|tomorrow|tmrw|tmr|tomo|today/i;

interface Analysis {
  words: Set<string>;
  tickets: boolean;
  logistics: boolean;
  after: boolean;
  dates: Set<string> | null;
}

interface Row {
  id: number;
  conversation_id: string;
  conv_kind: 'direct' | 'group';
  sender_identity_id: string | null;
  is_from_me: number;
  sent_at: number;
  kind: string;
  text: string | null;
}

/** Minutes east of UTC for `ms` in `timeZone` (chrono's reference offset). */
export function tzOffsetMinutes(ms: number, timeZone?: string): number {
  const p = localParts(ms, timeZone);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = p.hhmm.split(':').map(Number) as [number, number];
  return Math.round((Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** Local dates a message's date phrases resolve to (relative to when it was sent). */
export function messageDates(text: string, sentAt: number, timeZone?: string): Set<string> {
  const out = new Set<string>();
  if (!DATEISH.test(text)) return out;
  const ref = { instant: new Date(sentAt), timezone: tzOffsetMinutes(sentAt, timeZone) };
  for (const r of chrono.parse(text.slice(0, 600), ref, { forwardDate: true })) {
    if (!(r.start.isCertain('day') || r.start.isCertain('weekday') || RELATIVE_DAY.test(r.text))) continue;
    for (const c of r.end ? [r.start, r.end] : [r.start]) {
      const y = c.get('year');
      const m = c.get('month');
      const d = c.get('day');
      if (y && m && d) out.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return out;
}

export class MessageScanner {
  private readonly cache = new Map<number, Analysis>();
  private readonly stmt;
  /** The rows with sent_at in [lo, hi], in (sent_at, id) order. */
  private rows: Row[] = [];
  private lo = 0;
  private hi = -1;

  constructor(
    db: DB,
    private readonly people: PeopleIndex,
    private readonly timeZone?: string,
  ) {
    this.stmt = db.prepare(
      `SELECT m.id, m.conversation_id, c.kind AS conv_kind, m.sender_identity_id, m.is_from_me, m.sent_at, m.kind, m.text
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.sent_at BETWEEN @from AND @to AND c.kind IN ('direct', 'group') AND c.agent_excluded = 0
         AND m.is_bot = 0 AND m.is_spam = 0 AND m.dup_of IS NULL AND m.retracted_at IS NULL
         AND m.kind IN ('text', 'link', 'attachment')
       ORDER BY m.sent_at, m.id`,
    );
  }

  private analyze(r: Row): Analysis {
    let a = this.cache.get(r.id);
    if (!a) {
      const text = r.text ?? '';
      a = { words: new Set(words(text)), tickets: TICKETS.test(text), logistics: isLogistics(text), after: AFTER.test(text), dates: null };
      this.cache.set(r.id, a);
    }
    return a;
  }

  /**
   * The rows with sent_at in [from, to] (the first `n` of this.rows). The cached window slides forward: rows before
   * `from` are dropped with their analyses, rows after the cached end are read once. A window that starts before
   * the cached one (or after its end) is read afresh.
   */
  private window(from: number, to: number): number {
    if (from < this.lo || from > this.hi) {
      this.rows = this.stmt.all({ from, to }) as Row[];
      this.cache.clear();
      this.lo = from;
      this.hi = to;
    } else {
      let drop = 0;
      while (drop < this.rows.length && this.rows[drop]!.sent_at < from) this.cache.delete(this.rows[drop++]!.id);
      if (drop) this.rows = this.rows.slice(drop);
      this.lo = from;
      if (to > this.hi) {
        for (const r of this.stmt.all({ from: this.hi + 1, to }) as Row[]) this.rows.push(r);
        this.hi = to;
      }
    }
    // first row after `to` (binary search: rows are in sent_at order)
    let a = 0;
    let b = this.rows.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (this.rows[mid]!.sent_at <= to) a = mid + 1;
      else b = mid;
    }
    return a;
  }

  /** Date phrases are parsed (chrono) only for messages that could point forward to the occasion. */
  private dates(r: Row, a: Analysis): Set<string> {
    if (a.dates === null) a.dates = r.text ? messageDates(r.text, r.sent_at, this.timeZone) : new Set();
    return a.dates;
  }

  scan(w: OccasionWindow): MessageEvidence {
    const out: MessageEvidence = { byPerson: new Map(), aboutFromMe: [], aboutFromOthersDm: [], groupsDiscussed: new Map(), scanned: 0 };
    const add = (personId: string | null, s: Signal) => {
      if (!personId) return;
      const list = out.byPerson.get(personId) ?? [];
      list.push(s);
      out.byPerson.set(personId, list);
    };
    const n = this.window(Math.floor(w.startsAt - 14 * DAY), Math.ceil(w.endsAt + 2 * DAY));
    const rows = this.rows;
    const groupAbout = new Map<string, { ids: number[]; fromMe: boolean }>();
    for (let i = 0; i < n; i++) {
      const r = rows[i]!;
      out.scanned++;
      const group = r.conv_kind === 'group' ? this.people.groups.get(r.conversation_id) : undefined;
      if (r.conv_kind === 'group' && (!group || group.size > 41)) continue;
      const a = this.analyze(r);
      const hits = w.tokens.filter((t) => a.words.has(t));
      const dateHit = r.sent_at <= w.endsAt && [...this.dates(r, a)].some((d) => w.days.has(d));
      const about = hits.length >= 2 || hits.some((t) => w.strong.has(t)) || (hits.length === 1 && (dateHit || a.tickets));
      const keyword = [...w.kindWords].some((k) => a.words.has(k));
      const nearStart = !w.allDay && Math.abs(r.sent_at - w.startsAt) <= 3 * HOUR;
      const after = r.sent_at > w.startsAt + HOUR && r.sent_at <= w.endsAt + 36 * HOUR && a.after;
      const photos = !w.allDay && r.kind === 'attachment' && r.sent_at >= w.startsAt && r.sent_at <= w.endsAt + 12 * HOUR;
      const sender = r.is_from_me ? null : this.people.personOfIdentity(r.sender_identity_id);
      const m = [r.id];

      if (about) {
        if (r.is_from_me) out.aboutFromMe.push(r.id);
        else if (r.conv_kind === 'direct') out.aboutFromOthersDm.push(r.id);
      }
      if (r.conv_kind === 'direct') {
        const who = this.people.dmCounterpart.get(r.conversation_id) ?? null;
        if (about) add(who, { type: 'mention_dm', weight: WEIGHTS.mentionDm, m });
        else if (dateHit) add(who, { type: 'date_dm', weight: keyword ? WEIGHTS.dateKeywordDm : WEIGHTS.dateDm, m });
        else if (a.tickets && r.sent_at <= w.startsAt) add(who, { type: 'tickets_dm', weight: WEIGHTS.ticketsDm, m });
        if (nearStart && a.logistics) add(who, { type: 'logistics_dm', weight: WEIGHTS.logisticsDm, m });
        if (after) add(who, { type: 'after_dm', weight: WEIGHTS.afterDm, m });
        if (photos) add(who, { type: 'photos_dm', weight: WEIGHTS.photosDm, m });
        continue;
      }
      // group chat
      if (about) {
        add(sender, { type: 'mention_group', weight: WEIGHTS.mentionGroup, m, ref: `conv:${r.conversation_id}` });
        const g = groupAbout.get(r.conversation_id) ?? { ids: [], fromMe: false };
        g.ids.push(r.id);
        g.fromMe ||= r.is_from_me === 1;
        groupAbout.set(r.conversation_id, g);
      }
      if (nearStart && a.logistics && group!.size <= 9) add(sender, { type: 'logistics_group', weight: WEIGHTS.logisticsGroup, m });
      if (after && group!.size <= SMALL_GROUP + 1) add(sender, { type: 'after_group', weight: WEIGHTS.afterGroup, m });
    }
    for (const [conv, g] of groupAbout) {
      const info = this.people.groups.get(conv)!;
      if (info.size > SMALL_GROUP + 1 || !(g.fromMe || g.ids.length >= 2)) continue;
      out.groupsDiscussed.set(conv, g.ids);
      for (const pid of info.members) add(pid, { type: 'group_discussed', weight: WEIGHTS.groupDiscussed, m: g.ids.slice(0, 5), ref: `conv:${conv}` });
    }
    return out;
  }
}
