/**
 * Attendee candidates for one social occasion (PLAN step 3) and their deterministic scores (step 4):
 *   explicit attendees (email → identity; a bare display name is resolved like a written name),
 *   names in the title/notes ("w/ X", "X & Y", "X has my ticket") and group nicknames (circle names, small
 *   group-chat titles), Partiful GOING/MAYBE guests and host, the people the owner's ticket emails name as
 *   transfer counterparties (ticket_parties resolved to a person: named ticket holders), and the message
 *   cross-reference (messages.ts; a ticket-only occasion has no calendar notes, so its title, performers and venue
 *   carry the scan).
 * Names resolve only against visible people: first name (+ nickname table), or first + last; an ambiguous first
 * name is settled by 1:1 recency around the occasion, message evidence for it, and co-membership with the other
 * people named, else it stays an unresolved name candidate for the LLM step. A ticket count caps how many
 * unnamed (message-only) companions can count.
 */
import { normalizeNamePart } from '@yb/shared';
import type { DB } from '../../db/connection';
import type { OccasionDraft } from './build';
import type { MessageEvidence, MessageScanner, OccasionWindow } from './messages';
import type { PeopleIndex } from './people';
import { BELOW_POSSIBLE, CAPPED, combine, COUNTED, isNamed, MAX_UNNAMED, mergeSignals, WEIGHTS, type Signal, type SignalType } from './signals';
import { distinctiveTokens, VENUE_WORDS, venueKey, words, type Mention } from './text';

export type AttendeeRole = 'companion' | 'host' | 'guest' | 'ticket_holder';

export interface PersonCandidate {
  kind: 'person';
  key: string;
  personId: string;
  score: number;
  role: AttendeeRole;
  signals: Signal[];
  /** Named in the calendar, the invite or Partiful (vs. inferred from messages only). */
  named: boolean;
  /** The name as written, when one was. */
  surface: string | null;
}

export interface NameCandidate {
  kind: 'name';
  key: string;
  surface: string;
  role: AttendeeRole;
  /** Up to 5 people the name could be (best first); empty when nobody matches. */
  alternatives: string[];
  signals: Signal[];
  score: number;
}

export interface GroupCandidate {
  kind: 'group';
  key: string;
  surface: string;
  groupId: string;
  groupType: 'conv' | 'circle';
  members: string[];
  signals: Signal[];
  score: number;
}

export type Candidate = PersonCandidate | NameCandidate | GroupCandidate;

export interface Inference {
  candidates: Candidate[];
  people: PersonCandidate[];
  corroborated: boolean;
  window: OccasionWindow;
  scanned: number;
}

/** A written name to resolve: a title/notes mention, or an invitee known only by display name. */
type NameInput = Mention & { explicit?: boolean };

const KIND_WORDS = new Set(
  'dinner lunch brunch breakfast drinks drink coffee cocktails party bday birthday concert show gig tickets tix game match movie festival date'.split(' '),
);
const GOING = new Set(['going', 'approved', 'checked_in', 'attended', 'host']);
const MAYBE = new Set(['maybe']);

function addSignal(map: Map<string, Signal[]>, personId: string, s: Signal) {
  map.set(personId, [...(map.get(personId) ?? []), s]);
}

const nameSignalType = (m: Mention): SignalType =>
  m.role === 'ticket_holder' ? 'ticket_holder' : m.pattern === 'pair' ? 'pair_name' : m.where === 'title' ? 'title_name' : 'notes_name';
const nameWeight = (t: SignalType): number =>
  t === 'ticket_holder' ? WEIGHTS.ticketHolder : t === 'pair_name' ? WEIGHTS.pairName : t === 'title_name' ? WEIGHTS.titleName : WEIGHTS.notesName;

export interface InferContext {
  db: DB;
  people: PeopleIndex;
  scanner: MessageScanner;
  days: ReadonlySet<string>;
}

/** The message-scan window for an occasion: tokens from its titles and venue, minus the people's names. */
export function occasionWindow(d: OccasionDraft, days: ReadonlySet<string>): OccasionWindow {
  const names = d.mentions.map((m) => m.surface);
  const texts = [
    ...d.events.filter((e) => !e.reservation).map((e) => e.title),
    d.venueText,
    d.eventTitle,
    ...d.events.filter((e) => e.reservation).map((e) => e.venue),
    ...(d.ticket?.performers ?? []),
  ];
  const tokens = distinctiveTokens(texts, names, 10);
  // Alone, only the venue's own name or a title's single rare word makes a message about this occasion.
  const venueWords = words(venueKey(d.venueText)).filter((w) => w.length >= 4 && !VENUE_WORDS.has(w) && tokens.includes(w));
  const titleTokens = distinctiveTokens([d.title, d.eventTitle], names, 10);
  const strong = new Set([...venueWords.slice(0, 2), ...(titleTokens.length === 1 && titleTokens[0]!.length >= 6 ? titleTokens : [])]);
  const kindWords = new Set(words([d.title, d.eventTitle ?? ''].join(' ')).filter((w) => KIND_WORDS.has(w)));
  return { startsAt: d.startsAt, endsAt: d.endsAt, allDay: d.allDay, days, tokens, strong, kindWords };
}

export function inferAttendees(ctx: InferContext, d: OccasionDraft): Inference {
  const { db, people } = ctx;
  const window = occasionWindow(d, ctx.days);
  const msgs: MessageEvidence = ctx.scanner.scan(window);
  const byPerson = new Map<string, Signal[]>();
  for (const [pid, list] of msgs.byPerson) if (pid !== people.me) byPerson.set(pid, [...list]);
  const surfaceOf = new Map<string, string>();
  const names: NameCandidate[] = [];
  const groups: GroupCandidate[] = [];

  // explicit invitees
  const nameMentions: NameInput[] = [...d.mentions];
  for (const a of d.attendees) {
    if (a.response === 'declined') continue;
    const pid = a.email ? people.personOfEmail(a.email) : null;
    if (pid && pid !== people.me) {
      const weight = a.response === 'accepted' ? WEIGHTS.explicitAccepted : a.response === 'tentative' ? WEIGHTS.explicitTentative : WEIGHTS.explicitInvited;
      addSignal(byPerson, pid, { type: 'explicit', weight, ref: `cal:${a.calEventId}` });
    } else if (a.name && !a.name.includes('@')) {
      const norm = normalizeNamePart(a.name);
      if (norm) nameMentions.push({ surface: a.name, norm, where: 'title', pattern: 'with', role: 'companion', capitalized: true, explicit: true });
    }
  }

  // Partiful guest list of the linked event
  if (d.eventId) {
    const guests = db.prepare(`SELECT person_id, status, role FROM event_attendees WHERE event_id = ?`).all(d.eventId) as {
      person_id: string;
      status: string;
      role: string | null;
    }[];
    for (const g of guests) {
      const pid = people.visibleCanonical(g.person_id);
      if (!pid || pid === people.me) continue;
      const status = g.status.toLowerCase();
      const ref = `event:${d.eventId}`;
      if (g.role === 'host' || g.role === 'co_host' || status === 'host') addSignal(byPerson, pid, { type: 'partiful_host', weight: WEIGHTS.partifulHost, ref });
      else if (GOING.has(status)) addSignal(byPerson, pid, { type: 'partiful_going', weight: WEIGHTS.partifulGoing, ref });
      else if (MAYBE.has(status)) addSignal(byPerson, pid, { type: 'partiful_maybe', weight: WEIGHTS.partifulMaybe, ref });
    }
  }

  // people the ticket emails name: who he sent tickets to or got them from (resolved by the ledger)
  if (d.ticket) {
    const ids = [d.ticket.id, ...d.ticket.aliases];
    const holders = db
      .prepare(
        `SELECT DISTINCT person_id FROM ticket_parties
         WHERE ticket_event_id IN (SELECT value FROM json_each(?)) AND person_id IS NOT NULL ORDER BY person_id`,
      )
      .pluck()
      .all(JSON.stringify(ids)) as string[];
    for (const raw of holders) {
      const pid = people.visibleCanonical(raw);
      if (!pid || pid === people.me) continue;
      addSignal(byPerson, pid, { type: 'ticket_holder', weight: WEIGHTS.ticketHolder, ref: `ticket:${d.ticket.id}` });
    }
  }

  // names → people: unique matches first, so ambiguous ones can use co-membership with them
  const pending: { m: NameInput; ids: string[]; full: boolean }[] = [];
  const resolved = new Set<string>();
  const resolve = (m: NameInput, pid: string, conf: number) => {
    const type: SignalType = m.explicit ? 'explicit_name' : nameSignalType(m);
    const base = m.explicit ? WEIGHTS.explicitName : nameWeight(type);
    addSignal(byPerson, pid, { type, weight: base * conf });
    resolved.add(pid);
    if (!surfaceOf.has(pid)) surfaceOf.set(pid, m.surface);
  };
  for (const m of nameMentions) {
    const { ids, full } = people.lookupName(m.norm);
    const visible = ids.filter((id) => id !== people.me);
    // A name a hidden person also answers to is never resolved or kept, unless it is a full visible name.
    if (people.hiddenNamesake(m.norm) && !(full && visible.length === 1)) continue;
    if (visible.length === 1) {
      const pid = visible[0]!;
      const recent = people.nearestDmDays(pid, d.startsAt, 365) !== null;
      resolve(m, pid, full ? 0.97 : recent ? 0.92 : 0.72);
    } else pending.push({ m, ids: visible, full });
  }
  for (const { m, ids } of pending) {
    if (ids.length === 0) {
      const matched = m.pattern === 'with' ? people.matchGroups(m.norm) : [];
      if (matched.length) {
        for (const g of matched) {
          const members = [...g.members].filter((p) => p !== people.me).sort();
          const ref = `${g.type === 'conv' ? 'conv' : 'circle'}:${g.id}`;
          const weight = members.length <= 6 ? WEIGHTS.groupNickname : WEIGHTS.groupNicknameLarge;
          for (const pid of members) addSignal(byPerson, pid, { type: 'group_nickname', weight, ref });
          groups.push({ kind: 'group', key: `g:${g.id}`, surface: m.surface, groupId: g.id, groupType: g.type, members, signals: [], score: 0 });
        }
      } else if (m.pattern !== 'pair' && (m.capitalized || m.pattern === 'ticket')) {
        names.push({ kind: 'name', key: `n:${m.norm}`, surface: m.surface, role: m.role === 'ticket_holder' ? 'ticket_holder' : 'companion', alternatives: [], signals: [], score: 0 });
      }
      continue;
    }
    const scored = ids
      .map((pid) => {
        const near = people.nearestDmDays(pid, d.startsAt, 120);
        const recency = near === null ? 0 : Math.exp(-near / 30);
        const evidence = msgs.byPerson.has(pid) ? 1 : 0;
        const together = [...resolved].some((o) => o !== pid && people.shareSmallGroup(pid, o)) ? 1 : 0;
        return { pid, s: 0.5 * recency + 0.35 * evidence + 0.15 * together };
      })
      .sort((a, b) => b.s - a.s || (a.pid < b.pid ? -1 : 1));
    const [top, second] = [scored[0]!, scored[1]!];
    const margin = top.s - second.s;
    if (margin >= 0.15 && top.s >= 0.2) resolve(m, top.pid, Math.min(0.9, 0.6 + margin));
    else if (m.pattern !== 'pair') {
      names.push({
        kind: 'name',
        key: `n:${m.norm}`,
        surface: m.surface,
        role: m.role === 'ticket_holder' ? 'ticket_holder' : 'companion',
        alternatives: scored.slice(0, 5).map((x) => x.pid),
        signals: [],
        score: 0,
      });
    }
  }

  // score, then cap unnamed companions at the ticket count
  let candidates: PersonCandidate[] = [...byPerson].map(([personId, list]) => {
    const signals = mergeSignals(list);
    const types = new Set(signals.map((s) => s.type));
    const role: AttendeeRole = types.has('ticket_holder')
      ? 'ticket_holder'
      : types.has('partiful_host')
        ? 'host'
        : types.has('explicit') || types.has('partiful_going') || types.has('partiful_maybe')
          ? 'guest'
          : 'companion';
    return { kind: 'person', key: `p:${personId}`, personId, score: combine(signals), role, signals, named: isNamed(signals), surface: surfaceOf.get(personId) ?? null };
  });
  const unnamed = candidates.filter((c) => !c.named).sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1));
  if (d.ticketCount !== null) {
    let allowed = Math.max(0, d.ticketCount - 1 - candidates.filter((c) => c.named).length);
    for (const c of unnamed) {
      if (c.score < COUNTED) continue;
      if (allowed > 0) allowed--;
      else c.score = CAPPED;
    }
  }
  // A busy day of texting must not turn half the address book into "possible" companions.
  unnamed.sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1));
  for (const c of unnamed.slice(MAX_UNNAMED)) c.score = Math.min(c.score, BELOW_POSSIBLE);
  candidates = candidates.sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1));

  for (const g of groups) {
    const scores = g.members.map((m) => candidates.find((c) => c.personId === m)?.score ?? 0);
    g.score = scores.length ? Math.max(...scores) : 0;
  }

  return {
    candidates: [...candidates, ...names, ...groups],
    people: candidates,
    corroborated: corroboration(db, d, msgs),
    window,
    scanned: msgs.scanned,
  };
}

/** A shared-calendar event becomes an occasion only with an RSVP or messages about it (PLAN step 1). */
function corroboration(db: DB, d: OccasionDraft, msgs: MessageEvidence): boolean {
  if (d.treatment !== 'candidate') return true;
  if (d.eventId) {
    const rsvp = db.prepare(`SELECT lower(coalesce(my_rsvp, '')) || '|' || lower(coalesce(my_role, '')) FROM events WHERE id = ?`).pluck().get(d.eventId) as string | undefined;
    if (rsvp && /^(going|approved|maybe|checked_in|attended)\||\|(host|co_?host)$/.test(rsvp)) return true;
  }
  if (d.partifulId) {
    const text = db
      .prepare(`SELECT 1 FROM partiful_text_signals WHERE event_id = ? AND (rsvp IN ('going', 'maybe') OR kind IN ('reminder', 'host_rsvp')) LIMIT 1`)
      .get(d.partifulId);
    if (text) return true;
  }
  return msgs.aboutFromMe.length >= 1 || msgs.aboutFromOthersDm.length >= 2;
}
