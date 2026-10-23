/**
 * Met-at candidate events: the owner's past social happenings (intel/common.ts attendedEvents: active,
 * non-sensitive social occasions — ticket occasions included — plus Partiful events no occasion covers), with
 *   - Partiful events only when the owner's RSVP is going / approved / checked_in / attended or he hosts (never
 *     'maybe'); an occasion linked to a 'maybe' RSVP weighs like any other social occasion (× 0.85);
 *   - weight 1.0 for a ticket occasion whose ticket is still held or a confirmed Partiful one, 0.85 for everything
 *     else;
 *   - an end: the source's, else start + 6 h (club), 10 h (festival) or 4 h;
 *   - labels for the self-reference filter: ticket performers, venues, distinctive title tokens (never words any
 *     show title may carry — live, tour, presents, … — or kind-of-place words like rooftop or gallery).
 * Candidates that overlap in time and share a venue key, a performer or a distinctive title token are merged into one
 * happening first. A happening's keys (store.ts targetKeys of every member: o:<surviving occasion>, e:<Partiful
 * event>, both ways through occasions.event_id) are what links and rejections are matched on. Reads only.
 */
import type { DB } from '../../db/connection';
import { survivingOccasion } from '../../pipeline/occasions/build';
import { distinctiveTokens, VENUE_WORDS, venueKey } from '../../pipeline/occasions/text';
import { attendedEvents } from '../common';
import { compact, MET_AT, type HappeningLabels } from './score';
import { targetKeys } from './store';

const GOING = new Set(['going', 'approved', 'checked_in', 'attended']);
const HOSTING = new Set(['host', 'co_host', 'cohost']);

/** Title words two unrelated shows share all the time: never enough to make them one happening. */
const GENERIC_TITLE = new Set([
  ...'live tour presents present featuring feat special guest guests edition vol volume session sessions series world opening official nights admission general vip entry experience'.split(' '),
  ...VENUE_WORDS,
]);
const titleTokens = (titles: readonly string[]): string[] =>
  distinctiveTokens([...titles], [], 24)
    .filter((t) => !GENERIC_TITLE.has(t))
    .slice(0, 12);

export interface Member {
  type: 'occasion' | 'event';
  id: string;
  /** 'o:<id>' / 'e:<id>'. */
  key: string;
  title: string | null;
  startsAt: number;
  endsAt: number;
  weight: number;
  venueKey: string;
  /** Occasions: the linked Partiful event. */
  eventId: string | null;
  ticket: boolean;
}

export interface Happening {
  /** The first member's key (stable within a run). */
  key: string;
  members: Member[];
  startsAt: number;
  endsAt: number;
  venues: Set<string>;
  labels: HappeningLabels;
  /** Every o:/e: key that names this happening (members, linked Partiful events, occasions covering them). */
  keys: Set<string>;
}

interface TicketRow {
  id: string;
  title: string;
  performers: string;
  category: string;
  venue: string | null;
  venue_key: string | null;
  status: string;
  merged_into_id: string | null;
}

const parseList = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
};

/** The surviving ticket_events row (pointer merges). */
function survivingTicket(rows: ReadonlyMap<string, TicketRow>, id: string): TicketRow | undefined {
  const seen = new Set<string>();
  let cur = rows.get(id);
  while (cur?.merged_into_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = rows.get(cur.merged_into_id);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** Compacted performer names of every ticket event the owner ever had (any status). */
export function ticketPerformers(db: DB): Set<string> {
  const out = new Set<string>();
  for (const raw of db.prepare('SELECT performers FROM ticket_events WHERE merged_into_id IS NULL').pluck().all() as string[]) {
    for (const p of parseList(raw)) {
      const c = compact(p);
      if (c.length >= 3) out.add(c);
    }
  }
  return out;
}

/**
 * Union-find over `order` (indexes sorted by start): only pairs that overlap in time are tested, so the scan stops
 * at the first later start past an item's end.
 */
function groups(order: readonly number[], startOf: (i: number) => number, endOf: (i: number) => number, joined: (a: number, b: number) => boolean): number[][] {
  const parent = new Map<number, number>(order.map((i) => [i, i]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (let i = 0; i < order.length; i++) {
    const a = order[i]!;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j]!;
      if (startOf(b) > endOf(a)) break;
      if (joined(a, b)) parent.set(find(b), find(a));
    }
  }
  const out = new Map<number, number[]>();
  for (const i of order) {
    const r = find(i);
    const g = out.get(r) ?? [];
    g.push(i);
    out.set(r, g);
  }
  return [...out.values()];
}

/** Past happenings (start < now), merged, sorted by start. */
export function loadHappenings(db: DB, now: number): Happening[] {
  const raw = attendedEvents(db, { startTo: now });
  if (!raw.length) return [];

  const tickets = new Map(
    (db.prepare('SELECT id, title, performers, category, venue, venue_key, status, merged_into_id FROM ticket_events').all() as TicketRow[]).map((r) => [r.id, r]),
  );
  // Ticket sources per surviving occasion.
  const ticketsOf = new Map<string, TicketRow[]>();
  for (const s of db.prepare(`SELECT occasion_id, source_ref FROM occasion_sources WHERE source = 'ticket'`).all() as { occasion_id: string; source_ref: string }[]) {
    const t = survivingTicket(tickets, s.source_ref);
    if (!t) continue;
    const occ = survivingOccasion(db, s.occasion_id);
    const list = ticketsOf.get(occ) ?? [];
    if (!list.some((x) => x.id === t.id)) list.push(t);
    ticketsOf.set(occ, list);
  }
  const occRow = db.prepare('SELECT venue_key, ends_at FROM occasions WHERE id = ?');
  const evRow = db.prepare('SELECT my_rsvp, my_role, ends_at, location_text FROM events WHERE id = ?');

  interface Built {
    member: Member;
    performers: string[];
    venues: string[];
    tokens: string[];
    titles: string[];
    keys: string[];
  }
  const built: Built[] = [];
  for (const e of raw) {
    const keys = [...targetKeys(db, e.type === 'occasion' ? { occasion_id: e.id, event_id: null } : { occasion_id: null, event_id: e.id })];
    let weight: number = MET_AT.weightOther;
    let ticket = false;
    let category = 'other';
    let vKey = '';
    let end: number | null = null;
    const performers: string[] = [];
    const venueTexts: string[] = [];
    const titles: string[] = [e.title ?? ''];
    if (e.type === 'event') {
      const ev = evRow.get(e.id) as { my_rsvp: string | null; my_role: string | null; ends_at: number | null; location_text: string | null } | undefined;
      const rsvp = (ev?.my_rsvp ?? '').toLowerCase();
      const role = (ev?.my_role ?? '').toLowerCase();
      if (!GOING.has(rsvp) && !HOSTING.has(role)) continue; // 'maybe' Partiful events are not attended events here
      weight = MET_AT.weightConfirmed;
      vKey = venueKey(ev?.location_text ?? e.venue);
      end = ev?.ends_at ?? null;
    } else {
      const o = occRow.get(e.id) as { venue_key: string | null; ends_at: number | null } | undefined;
      vKey = o?.venue_key || venueKey(e.venue);
      end = o?.ends_at ?? null;
      const ts = ticketsOf.get(e.id) ?? [];
      if (ts.length) {
        // Only a ticket still held confirms he went; a sold or given-away one only labels the happening.
        ticket = ts.some((t) => t.status === 'holding');
        if (ticket) weight = MET_AT.weightConfirmed;
        for (const t of ts) {
          performers.push(...parseList(t.performers));
          if (t.venue) venueTexts.push(t.venue);
          if (t.venue_key) venueTexts.push(t.venue_key);
          titles.push(t.title);
          if (t.category === 'club' || t.category === 'festival') category = t.category;
        }
      }
      if (e.eventId) {
        const ev = evRow.get(e.eventId) as { my_rsvp: string | null; my_role: string | null } | undefined;
        const rsvp = (ev?.my_rsvp ?? '').toLowerCase();
        const role = (ev?.my_role ?? '').toLowerCase();
        if (!ticket && (GOING.has(rsvp) || HOSTING.has(role))) weight = MET_AT.weightConfirmed;
      }
    }
    if (e.venue) venueTexts.push(e.venue);
    const len = category === 'club' ? MET_AT.defaultLenMs.club : category === 'festival' ? MET_AT.defaultLenMs.festival : MET_AT.defaultLenMs.other;
    const endsAt = end !== null && end > e.startsAt ? end : e.startsAt + len;
    const member: Member = {
      type: e.type,
      id: e.id,
      key: e.type === 'occasion' ? `o:${e.id}` : `e:${e.id}`,
      title: e.title,
      startsAt: e.startsAt,
      endsAt,
      weight,
      venueKey: vKey,
      eventId: e.type === 'occasion' ? e.eventId : null,
      ticket,
    };
    built.push({
      member,
      performers: performers.map(compact).filter((p) => p.length >= 3),
      venues: [vKey, ...venueTexts.map((v) => venueKey(v))].map(compact).filter((v) => v.length >= 3),
      tokens: titleTokens(titles),
      titles: titles.map(compact).filter((t) => t.length >= 4),
      keys,
    });
  }

  const order = built.map((_, i) => i).sort((a, b) => built[a]!.member.startsAt - built[b]!.member.startsAt);
  const share = (a: readonly string[], b: readonly string[]) => a.some((x) => x !== '' && b.includes(x));
  const joined = (i: number, j: number) => {
    const a = built[i]!;
    const b = built[j]!;
    return (a.member.venueKey !== '' && a.member.venueKey === b.member.venueKey) || share(a.performers, b.performers) || share(a.tokens, b.tokens);
  };
  const out: Happening[] = [];
  for (const g of groups(order, (i) => built[i]!.member.startsAt, (i) => built[i]!.member.endsAt, joined)) {
    const parts = g.map((i) => built[i]!);
    const members = parts.map((p) => p.member);
    out.push({
      key: members[0]!.key,
      members,
      startsAt: Math.min(...members.map((m) => m.startsAt)),
      endsAt: Math.max(...members.map((m) => m.endsAt)),
      venues: new Set(members.map((m) => m.venueKey).filter((v) => v !== '')),
      labels: {
        performers: new Set(parts.flatMap((p) => p.performers)),
        venues: new Set(parts.flatMap((p) => p.venues)),
        titleTokens: new Set(parts.flatMap((p) => p.tokens)),
        titles: new Set(parts.flatMap((p) => p.titles)),
      },
      keys: new Set(parts.flatMap((p) => p.keys)),
    });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt || (a.key < b.key ? -1 : 1));
}
