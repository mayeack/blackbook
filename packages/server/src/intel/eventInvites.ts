/**
 * Event invites (tickets / met-at design §4 "event_invite suggestions" + review amendments [inv]): for a show or
 * event the owner holds tickets to, whom to bring — people he newly met at a *similar* event (intel/metAt
 * person_met_at links), the ones whose contact he screenshotted first. One event_invite candidate per ticket event:
 *
 *   subjects  live occasions (active, social, not sensitive) with a `ticket` source whose ticket event (through
 *             merged_into_id) is 'holding', starting 1–21 local days out — never one he hosts (intel/invites.ts
 *             hostedEvents: party_invite owns those). subjectKey `tkt:<ticket_event survivor id>`, ≤ 3 people.
 *   people    an active met-at link (confidence ≥ 0.6) to a past happening M with sim(M, U) ≥ 0.35
 *             (intel/similarity.ts):
 *               tier A  screenshot people (a linked contact screenshot): 0.6 + 0.3·sim + 0.1·conf
 *               tier B  everyone else, when sim ≥ 0.5 and conf ≥ 0.7:   0.4 + 0.3·sim + 0.1·conf
 *             tier A first, then by score. No closeness minimum: these are new acquaintances.
 *   never     anyone who may already be going (when in doubt, they stay out):
 *               - intel/invites.ts guestCheck / alreadyInvited as they are, over U's merge chain and every Partiful
 *                 event U or its tickets link: guest rows in any status, occasion candidates, calendar invitees by
 *                 email and name, shared identities in any form, open maybe-matches, first + last names;
 *               - ticket_parties counterparties (both directions) of every ticket event on U's chain or on the same
 *                 local date at the same venue_key: the resolved person (and their names and maybe-matches), the
 *                 email key, the full name, or the first name alone (firstNameScore ≥ 0.9, and the last initial when
 *                 there is one) — for an unresolved counterparty named only "Ana" or "Ana B.", and for anyone we
 *                 know only as "Ana" when a counterparty is "Ana Quill";
 *               - a Partiful event linked to U whose guest list wasn't read in full within the hour → no item;
 *             and never the owner, hidden, merged, roster-only or service people, nor anyone muted (entirely or for
 *             event_invite) or resting after ignored suggestions.
 *   payload   ids and numbers only: metRefs ('o:<occasion>' / 'e:<event>', one per person), metLinkIds (in step
 *             with metRefs), sims, confs, screenshot (1/0), daysOut, startsAt; evidence `occ:<U>` plus each M as
 *             `occ:` / `event:`. Base 0.75 with a tier-A person, else 0.6.
 * Once shown, the item keeps the people and links it was shown with (pipeline/suggestions/store.ts). Before delivery
 * (the brief, Today, "more"), eventInviteStale drops the whole item once U is no longer holding (or gone, sensitive,
 * or its Partiful list stale), and drops the people who have joined U since or whose met-at link behind the item the
 * owner has since marked wrong. "Wrong" on an item that names exactly one person — as its Today card shows it now
 * (eventInviteShown), or as stored for a text — rejects that person's met-at links to the happening(s) behind it,
 * across the occasion chain and its Partiful twin (rejectEventInviteLinks → intel/metAt/store.ts, journaled); with
 * several people only the normal cooldown applies. The Partiful lists behind U are re-read every 30 min
 * (ticketPartifulEvents → adapters/partiful refreshHostedGuests), so the hour-fresh rule can be met.
 * Pure reader except rejectEventInviteLinks.
 */
import { emailMatchKey, firstNameScore, normalizeNamePart } from '@yb/shared';
import type { DB } from '../db/connection';
import { selfPeople } from '../identity/self';
import { personState } from '../pipeline/suggestions/learner';
import type { Candidate } from '../pipeline/suggestions/types';
import { addDays, DAY, dayStart, daysBetween, localDate, visibleCanonical } from './common';
import { alreadyInvited, guestCheck, guestListFresh, hostedEvents, partifulEventOf, type GuestCheck } from './invites';
import { activeMetAtLinks, rejectMetAtLinks, screenshotPeople, targetKeys } from './metAt/store';
import { featuresOf, similarity, survivorOccasion, ticketEventsOf, titleCorpus, titleIdf, type EventFeatures, type HappeningRef, type TicketEventRow } from './similarity';

export const EVENT_INVITE = {
  /** Ticketed events this many local days out (inclusive). */
  minDaysOut: 1,
  maxDaysOut: 21,
  maxPeople: 3,
  /** Met-at links at least this sure. */
  minLinkConfidence: 0.6,
  /** sim(M, U) for anyone (tier A, screenshot people). */
  minSim: 0.35,
  /** Tier B (everyone else) needs a closer match and a surer link. */
  tierBMinSim: 0.5,
  tierBMinConfidence: 0.7,
  baseScreenshot: 0.75,
  base: 0.6,
  /** A counterparty known only by a first name keeps out anyone whose first name scores this close. */
  minFirstNameScore: 0.9,
} as const;

/** An upcoming happening the owner holds tickets to. */
export interface TicketedEvent {
  /** The live occasion. */
  id: string;
  title: string | null;
  startsAt: number;
  /** The linked Partiful event (occasions.event_id). */
  eventId: string | null;
  /** The subject: the first holding ticket event (survivor id). */
  ticketId: string;
  /** Every surviving ticket event on the occasion's chain (any status). */
  tickets: TicketEventRow[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const jsonStrings = (raw: string | null | undefined): string[] => {
  try {
    return strings(JSON.parse(raw ?? '[]'));
  } catch {
    return [];
  }
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Live, social, non-sensitive occasions starting in [from, to) with a holding ticket event behind them. */
export function ticketedEvents(db: DB, o: { startFrom: number; startTo: number }): TicketedEvent[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.title, o.starts_at AS startsAt, o.event_id AS eventId FROM occasions o
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.sensitive = 0 AND o.is_social = 1
         AND o.starts_at >= @sf AND o.starts_at < @st
       ORDER BY o.starts_at, o.id`,
    )
    .all({ sf: o.startFrom, st: o.startTo }) as { id: string; title: string | null; startsAt: number; eventId: string | null }[];
  const out: TicketedEvent[] = [];
  for (const r of rows) {
    const tickets = ticketEventsOf(db, r.id);
    const holding = tickets.find((t) => t.status === 'holding');
    if (holding) out.push({ ...r, ticketId: holding.id, tickets });
  }
  return out;
}

/** Partiful events behind U: its linked event, and any partiful.com/e/<id> its ticket mail named. */
export function partifulEventsOf(db: DB, u: Pick<TicketedEvent, 'id' | 'eventId' | 'tickets'>): string[] {
  const out = new Set<string>();
  const linked = partifulEventOf(db, { type: 'occasion', id: u.id, eventId: u.eventId });
  if (linked) out.add(linked);
  const pids = [...new Set(u.tickets.flatMap((t) => jsonStrings(t.partiful_ids)))];
  if (pids.length) {
    for (const id of db.prepare(`SELECT id FROM events WHERE source = 'partiful' AND source_event_id IN (SELECT value FROM json_each(?)) ORDER BY id`).pluck().all(JSON.stringify(pids)) as string[]) {
      out.add(id);
    }
  }
  return [...out];
}

/**
 * Ticket event ids whose counterparties count for U: its surviving tickets, any row on the same local date at the
 * same venue_key, and every row merged into one of those.
 */
export function ticketFamily(db: DB, tickets: readonly TicketEventRow[]): string[] {
  const out = new Set(tickets.map((t) => t.id));
  const sameVenue = db.prepare('SELECT id FROM ticket_events WHERE local_date = ? AND venue_key = ? ORDER BY id').pluck();
  for (const t of tickets) {
    const vk = t.venue_key?.trim();
    if (vk) for (const id of sameVenue.all(t.local_date, vk) as string[]) out.add(id);
  }
  const children = db.prepare('SELECT id FROM ticket_events WHERE merged_into_id = ? ORDER BY id').pluck();
  const list = [...out];
  for (let i = 0; i < list.length && list.length < 1000; i++) {
    for (const c of children.all(list[i]) as string[]) {
      if (!out.has(c)) {
        out.add(c);
        list.push(c);
      }
    }
  }
  return list;
}

/** Name words as intel/invites.ts folds them (diacritics, case, punctuation: "B." → "b"). */
function nameWords(full: string | null | undefined): string[] {
  return (full ?? '')
    .split(/\s+/)
    .map((w) => normalizeNamePart(w.replace(/[^\p{L}\p{N}'’-]+/gu, '')))
    .filter(Boolean);
}
/** "first last" (first and last word) when the last is more than an initial; null otherwise. */
const fullName = (full: string | null | undefined): { first: string; last: string } | null => {
  const w = nameWords(full);
  return w.length >= 2 && w[w.length - 1]!.length > 1 ? { first: w[0]!, last: w[w.length - 1]! } : null;
};

/** Everyone who may already be going to U (see the header): the guest check, widened with ticket counterparties. */
export interface GoingCheck {
  guests: GuestCheck;
  /**
   * Counterparties as a first name and last initial: unresolved ones named by a first name alone ("Ana", initial
   * null) or with a last initial ("Ana B."), and every full name ("Ana Quill", a resolved counterparty's names), so a
   * record known only by that first name can't slip past them.
   */
  partial: { first: string; initial: string | null }[];
}

export function goingCheck(db: DB, u: Pick<TicketedEvent, 'id' | 'eventId' | 'tickets'>, partifulIds: readonly string[] = partifulEventsOf(db, u)): GoingCheck {
  const checks = [
    guestCheck(db, { type: 'occasion', id: u.id, eventId: u.eventId }),
    ...partifulIds.filter((id) => id !== u.eventId).map((id) => guestCheck(db, { type: 'event', id, eventId: null })),
  ];
  const guests: GuestCheck = {
    ids: new Set(checks.flatMap((g) => [...g.ids])),
    keys: new Set(checks.flatMap((g) => [...g.keys])),
    names: checks.flatMap((g) => g.names),
    maybe: new Set(checks.flatMap((g) => [...g.maybe])),
  };
  const partial: GoingCheck['partial'] = [];
  const family = ticketFamily(db, u.tickets);
  if (!family.length) return { guests, partial };
  const parties = db
    .prepare(
      `SELECT tp.name, tp.email_key, pc.canonical_id AS person FROM ticket_parties tp LEFT JOIN person_canon pc ON pc.person_id = tp.person_id
       WHERE tp.ticket_event_id IN (SELECT value FROM json_each(@ids))
          OR tp.gmail_id IN (SELECT gmail_id FROM gmail_messages WHERE ticket_event_id IN (SELECT value FROM json_each(@ids)))`,
    )
    .all({ ids: JSON.stringify(family) }) as { name: string | null; email_key: string | null; person: string | null }[];
  const resolved = new Set<string>();
  // A full name matches full names (alreadyInvited); a record with only that first name has no last name to tell it
  // apart, so the name also goes in as first name + initial (isGoing).
  const named = (n: { first: string; last: string }) => {
    guests.names.push(n);
    partial.push({ first: n.first, initial: n.last.charAt(0) });
  };
  for (const p of parties) {
    if (p.person) resolved.add(p.person);
    const mail = p.email_key ? emailMatchKey(p.email_key) : null;
    if (mail) guests.keys.add(`mail:${mail}`);
    const full = fullName(p.name);
    if (full) named(full);
    else if (!p.person) {
      // Only a first name (and maybe an initial) to go on, even beside an email we can't place: in doubt, leave out.
      const w = nameWords(p.name);
      if (w[0]) partial.push({ first: w[0], initial: w.length >= 2 ? w[w.length - 1]!.charAt(0) : null });
    }
  }
  if (resolved.size) {
    const json = JSON.stringify([...resolved]);
    for (const id of resolved) guests.ids.add(id);
    const people = db
      .prepare(`SELECT p.display_name, p.first_name, p.last_name FROM people p JOIN person_canon pc ON pc.person_id = p.id WHERE pc.canonical_id IN (SELECT value FROM json_each(?))`)
      .all(json) as { display_name: string; first_name: string | null; last_name: string | null }[];
    for (const p of people) for (const n of [fullName(p.display_name), fullName(`${p.first_name ?? ''} ${p.last_name ?? ''}`)]) if (n) named(n);
    const maybe = db
      .prepare(
        `SELECT cb.canonical_id FROM match_candidates m JOIN person_canon ca ON ca.person_id = m.a_id JOIN person_canon cb ON cb.person_id = m.b_id
         WHERE m.status IN ('pending','possible_duplicate','held') AND ca.canonical_id IN (SELECT value FROM json_each(@ids))
         UNION
         SELECT ca.canonical_id FROM match_candidates m JOIN person_canon ca ON ca.person_id = m.a_id JOIN person_canon cb ON cb.person_id = m.b_id
         WHERE m.status IN ('pending','possible_duplicate','held') AND cb.canonical_id IN (SELECT value FROM json_each(@ids))`,
      )
      .pluck()
      .all({ ids: json }) as string[];
    for (const id of maybe) guests.maybe.add(id);
  }
  return { guests, partial };
}

/**
 * Whether `personId` (canonical) may already be going (see goingCheck). A partial name keeps out anyone whose first
 * name (or nickname) scores ≥ 0.9 against it and, with an initial, whose last name starts with it (or is unknown:
 * "Ana Quill" keeps out a record named just "Ana", never "Ana Birch").
 */
export function isGoing(db: DB, c: GoingCheck, personId: string): boolean {
  if (alreadyInvited(db, c.guests, personId)) return true;
  if (!c.partial.length) return false;
  const p = db.prepare('SELECT display_name, first_name, last_name, nickname FROM people WHERE id = ?').get(personId) as
    | { display_name: string; first_name: string | null; last_name: string | null; nickname: string | null }
    | undefined;
  if (!p) return false;
  const shown = nameWords(p.display_name);
  const firsts = [p.first_name, p.nickname, shown[0]].map((x) => nameWords(x)[0]).filter((x): x is string => !!x);
  const initials = new Set([nameWords(p.last_name).at(-1), shown.length >= 2 ? shown.at(-1) : undefined].filter((x): x is string => !!x).map((x) => x.charAt(0)));
  return c.partial.some(
    (f) => firsts.some((m) => firstNameScore(f.first, m) >= EVENT_INVITE.minFirstNameScore) && (f.initial === null || !initials.size || initials.has(f.initial)),
  );
}

// ---------------------------------------------------------------------------------------------- picks

export interface EventInvitePick {
  personId: string;
  /** The met-at link behind the pick and its target ('o:<occasion>' / 'e:<event>'). */
  linkId: string;
  metRef: string;
  sim: number;
  confidence: number;
  screenshot: boolean;
  score: number;
}

/** A met-at target as a happening (occasions resolved to their survivor); null when gone, sensitive or not past. */
function pastHappening(db: DB, t: HappeningRef, now: number): HappeningRef | null {
  if (t.type === 'event') {
    const at = db.prepare('SELECT starts_at FROM events WHERE id = ?').pluck().get(t.id) as number | null | undefined;
    return at !== undefined && at !== null && at < now ? t : null;
  }
  const id = survivorOccasion(db, t.id);
  if (!id) return null;
  const o = db.prepare('SELECT starts_at, sensitive FROM occasions WHERE id = ?').get(id) as { starts_at: number; sensitive: number } | undefined;
  return o && o.sensitive === 0 && o.starts_at < now ? { type: 'occasion', id } : null;
}

const refKey = (t: HappeningRef) => `${t.type === 'occasion' ? 'o' : 'e'}:${t.id}`;
const evidenceOf = (metRef: string) => (metRef.startsWith('o:') ? `occ:${metRef.slice(2)}` : `event:${metRef.slice(2)}`);

interface Ranked {
  personId: string;
  linkId: string;
  target: HappeningRef;
  sim: number;
  confidence: number;
  screenshot: boolean;
  score: number;
}

/** People met at a similar past happening, best first (tier A, then score), before the "already going" checks. */
function rankedPeople(
  db: DB,
  u: TicketedEvent,
  o: { now: number; links: ReturnType<typeof activeMetAtLinks>; shots: ReadonlySet<string>; idf: ReadonlyMap<string, number>; features: Map<string, EventFeatures | null> },
): Ranked[] {
  const uf = featuresOf(db, { type: 'occasion', id: u.id });
  if (!uf) return [];
  const self = selfPeople(db);
  const best = new Map<string, Ranked>();
  for (const l of o.links) {
    if (!(l.confidence >= EVENT_INVITE.minLinkConfidence)) continue;
    const personId = visibleCanonical(db, l.personId);
    if (!personId || self.has(personId)) continue;
    const target = pastHappening(db, l.target, o.now);
    if (!target) continue;
    // The same happening is never "similar" to itself.
    if ((target.type === 'occasion' && target.id === u.id) || (target.type === 'event' && target.id === u.eventId)) continue;
    const key = refKey(target);
    if (!o.features.has(key)) o.features.set(key, featuresOf(db, target));
    const mf = o.features.get(key);
    if (!mf) continue;
    const sim = similarity(mf, uf, o.idf);
    if (sim < EVENT_INVITE.minSim) continue;
    const screenshot = o.shots.has(personId) || o.shots.has(l.personId) || !!l.screenshot;
    if (!screenshot && (sim < EVENT_INVITE.tierBMinSim || l.confidence < EVENT_INVITE.tierBMinConfidence)) continue;
    const score = r3((screenshot ? 0.6 : 0.4) + 0.3 * sim + 0.1 * l.confidence);
    const cur = best.get(personId);
    if (!cur || score > cur.score || (score === cur.score && l.id < cur.linkId)) {
      best.set(personId, { personId, linkId: l.id, target, sim: r3(sim), confidence: r3(l.confidence), screenshot, score });
    }
  }
  return [...best.values()].sort((a, b) => Number(b.screenshot) - Number(a.screenshot) || b.score - a.score || (a.personId < b.personId ? -1 : 1));
}

/** Whom to bring to U: at most EVENT_INVITE.maxPeople, nobody who may already be going, muted or resting. */
export function eventInvitePicks(
  db: DB,
  u: TicketedEvent,
  o: {
    now: number;
    partifulIds?: readonly string[];
    links?: ReturnType<typeof activeMetAtLinks>;
    shots?: ReadonlySet<string>;
    idf?: ReadonlyMap<string, number>;
    features?: Map<string, EventFeatures | null>;
    limit?: number;
  },
): EventInvitePick[] {
  const links = o.links ?? activeMetAtLinks(db, { minConfidence: EVENT_INVITE.minLinkConfidence });
  if (!links.length) return [];
  const ranked = rankedPeople(db, u, {
    now: o.now,
    links,
    shots: o.shots ?? screenshotPeople(db),
    idf: o.idf ?? titleIdf(titleCorpus(db, o.now)),
    features: o.features ?? new Map(),
  });
  if (!ranked.length) return [];
  const going = goingCheck(db, u, o.partifulIds ?? partifulEventsOf(db, u));
  const out: EventInvitePick[] = [];
  for (const r of ranked) {
    if (out.length >= (o.limit ?? EVENT_INVITE.maxPeople)) break;
    const s = personState(db, r.personId);
    if (s.muted || s.mutedKinds.includes('event_invite') || (s.cooldownUntil !== null && s.cooldownUntil > o.now)) continue;
    if (isGoing(db, going, r.personId)) continue;
    out.push({ personId: r.personId, linkId: r.linkId, metRef: refKey(r.target), sim: r.sim, confidence: r.confidence, screenshot: r.screenshot, score: r.score });
  }
  return out;
}

/** Ticketed events starting in the window that event_invite may suggest for: never one he hosts (party_invite's). */
function inviteSubjects(db: DB, window: { startFrom: number; startTo: number }): TicketedEvent[] {
  const subjects = ticketedEvents(db, window);
  if (!subjects.length) return [];
  const hosted = hostedEvents(db, window);
  const hostedOcc = new Set(hosted.filter((e) => e.type === 'occasion').map((e) => e.id));
  const hostedEv = new Set(hosted.flatMap((e) => (e.type === 'event' ? [e.id] : e.eventId ? [e.eventId] : [])));
  return subjects.filter((u) => !hostedOcc.has(u.id) && !(u.eventId && hostedEv.has(u.eventId)));
}

/**
 * The Partiful events (row ids) behind the shows event_invite may suggest for from now through the last day out:
 * the 30-min guest-list refresh re-reads them (adapters/partiful refreshHostedGuests), since an item only trusts a
 * list read within the hour. None → [] (no calls).
 */
export function ticketPartifulEvents(db: DB, now: number): string[] {
  const subjects = inviteSubjects(db, { startFrom: now, startTo: now + (EVENT_INVITE.maxDaysOut + 1) * DAY });
  return [...new Set(subjects.flatMap((u) => partifulEventsOf(db, u)))].sort();
}

/** The nightly event_invite candidates (see the header). */
export function eventInviteCandidates(db: DB, now: number, timeZone: string): Candidate[] {
  const today = localDate(now, timeZone);
  const window = {
    startFrom: dayStart(addDays(today, EVENT_INVITE.minDaysOut), timeZone),
    startTo: dayStart(addDays(today, EVENT_INVITE.maxDaysOut + 1), timeZone),
  };
  const subjects = inviteSubjects(db, window);
  if (!subjects.length) return [];
  const links = activeMetAtLinks(db, { minConfidence: EVENT_INVITE.minLinkConfidence });
  if (!links.length) return [];
  const shots = screenshotPeople(db);
  const idf = titleIdf(titleCorpus(db, now));
  const features = new Map<string, EventFeatures | null>();
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const u of subjects) {
    const subjectKey = `tkt:${u.ticketId}`;
    if (seen.has(subjectKey)) continue;
    // A linked Partiful list not read in full within the hour could miss a guest.
    const partifulIds = partifulEventsOf(db, u);
    if (partifulIds.some((pe) => !guestListFresh(db, pe, now))) continue;
    const picks = eventInvitePicks(db, u, { now, partifulIds, links, shots, idf, features });
    if (!picks.length) continue;
    seen.add(subjectKey);
    const metRefs = picks.map((p) => p.metRef);
    out.push({
      kind: 'event_invite',
      personIds: picks.map((p) => p.personId),
      subjectKey,
      base: picks.some((p) => p.screenshot) ? EVENT_INVITE.baseScreenshot : EVENT_INVITE.base,
      evidenceIds: [`occ:${u.id}`, ...new Set(metRefs.map(evidenceOf))],
      expiresAt: u.startsAt,
      links: { occasionId: u.id, eventId: u.eventId },
      payload: {
        startsAt: u.startsAt,
        daysOut: daysBetween(today, localDate(u.startsAt, timeZone)),
        metRefs,
        metLinkIds: picks.map((p) => p.linkId),
        sims: picks.map((p) => p.sim),
        confs: picks.map((p) => p.confidence),
        screenshot: picks.map((p) => (p.screenshot ? 1 : 0)),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- delivery and feedback

interface MetRow {
  id: string;
  occasion_id: string | null;
  event_id: string | null;
  status: string;
}

const canonicalOf = (db: DB, id: string): string => (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(id) as string | undefined) ?? id;

/** Every met-at row of a canonical person's records (any status), active first, then the surest. */
function metRowsOf(db: DB, canonicalId: string): MetRow[] {
  return db
    .prepare(
      `SELECT id, occasion_id, event_id, status FROM person_met_at
       WHERE person_id IN (SELECT person_id FROM person_canon WHERE canonical_id = ?)
       ORDER BY status = 'active' DESC, confidence DESC, id`,
    )
    .all(canonicalId) as MetRow[];
}

/**
 * The person's own link behind an item and the item's ref for it: their entry in metLinkIds (in step with metRefs),
 * else their surest non-rejected link to one of the item's metRefs, matched across the occasion's merge chain and its
 * Partiful twin (intel/metAt/store.ts targetKeys), so a target merged since still resolves.
 */
function itemLinkOf(db: DB, personId: string, payload: Record<string, unknown>): { row: MetRow; ref: string } | null {
  const refs = strings(payload.metRefs);
  if (!refs.length) return null;
  const rows = metRowsOf(db, canonicalOf(db, personId));
  if (!rows.length) return null;
  const ids = strings(payload.metLinkIds);
  for (let i = 0; i < ids.length && i < refs.length; i++) {
    const row = rows.find((r) => r.id === ids[i]);
    if (row) return { row, ref: refs[i]! };
  }
  const want = refs.map((ref) => ({ ref, keys: refKeys(db, ref) }));
  for (const row of rows) {
    if (row.status === 'rejected') continue;
    const keys = targetKeys(db, row);
    const hit = want.find((w) => [...w.keys].some((k) => keys.has(k)));
    if (hit) return { row, ref: hit.ref };
  }
  return null;
}

/** Every key naming the happening an item ref names (the ref itself, its survivor's chain, its Partiful twin). */
function refKeys(db: DB, ref: string): Set<string> {
  const id = ref.slice(2);
  const keys = ref.startsWith('o:') ? targetKeys(db, { occasion_id: id, event_id: null }) : ref.startsWith('e:') ? targetKeys(db, { occasion_id: null, event_id: id }) : new Set<string>();
  return keys.add(ref);
}

/**
 * Before an event_invite item goes out (or shows on Today): `stale` when the whole item should go — the occasion is
 * gone, no longer active, sensitive, holds no 'holding' ticket any more, or a linked Partiful list isn't freshly
 * read — and otherwise `drop`: the item's people who may have joined U since, or (given the item's payload) whose
 * met-at link behind the item the owner has marked wrong since. They drop out of the item.
 */
export function eventInviteStale(
  db: DB,
  s: { occasionId: string | null; eventId: string | null; personIds: readonly string[]; payload?: Record<string, unknown> },
  now: number,
): { stale: boolean; drop: Set<string> } {
  const stale = { stale: true, drop: new Set<string>() };
  const id = s.occasionId ? survivorOccasion(db, s.occasionId) : null;
  if (!id) return stale;
  const o = db.prepare('SELECT status, sensitive, event_id FROM occasions WHERE id = ?').get(id) as { status: string; sensitive: number; event_id: string | null } | undefined;
  if (!o || o.status !== 'active' || o.sensitive === 1) return stale;
  const tickets = ticketEventsOf(db, id);
  if (!tickets.some((t) => t.status === 'holding')) return stale;
  const u = { id, eventId: o.event_id, tickets };
  const partifulIds = partifulEventsOf(db, u);
  if (partifulIds.some((pe) => !guestListFresh(db, pe, now))) return stale;
  const check = goingCheck(db, u, partifulIds);
  const wrong = (p: string) => !!s.payload && itemLinkOf(db, p, s.payload)?.row.status === 'rejected';
  return { stale: false, drop: new Set(s.personIds.filter((p) => isGoing(db, check, canonicalOf(db, p)) || wrong(p))) };
}

/**
 * The people an event_invite item shows now (its Today card): its people less those eventInviteStale drops. An item
 * that is stale as a whole (or left with nobody) isn't shown any more: its stored people, so nothing narrows.
 */
export function eventInviteShown(
  db: DB,
  s: { occasionId: string | null; eventId: string | null; personIds: readonly string[]; payload?: Record<string, unknown> },
  now: number,
): string[] {
  const st = eventInviteStale(db, s, now);
  const left = s.personIds.filter((p) => !st.drop.has(p));
  return st.stale || !left.length ? [...s.personIds] : left;
}

/**
 * The met-at links a "Wrong" on an event_invite item would reject: only when the item names exactly one person, that
 * person's not-yet-rejected links (any of their records) to the happening behind the item — their link in
 * metLinkIds, or their link to the payload's metRefs — across its merge chain and Partiful twin. [] otherwise.
 */
export function eventInviteLinkIds(db: DB, r: { personIds: readonly string[]; payload: Record<string, unknown> }): string[] {
  if (r.personIds.length !== 1) return [];
  const l = itemLinkOf(db, r.personIds[0]!, r.payload);
  if (!l) return [];
  const happening = new Set([...refKeys(db, l.ref), ...targetKeys(db, l.row)]);
  return metRowsOf(db, canonicalOf(db, r.personIds[0]!))
    .filter((m) => m.status !== 'rejected' && [...targetKeys(db, m)].some((k) => happening.has(k)))
    .map((m) => m.id)
    .sort();
}

/**
 * "Wrong" on an event_invite item: rejects eventInviteLinkIds through intel/metAt/store.ts — journaled in `runId`,
 * sticky (the nightly met-at run never re-creates them), undoable. Returns how many were rejected and the journal
 * batches written (for the feedback's undo).
 */
export function rejectEventInviteLinks(
  db: DB,
  r: { personIds: readonly string[]; payload: Record<string, unknown> },
  o: { runId: string; now: number },
): { rejected: number; batchIds: string[] } {
  const ids = eventInviteLinkIds(db, r);
  if (!ids.length) return { rejected: 0, batchIds: [] };
  const batches = db.prepare('SELECT id FROM change_batches WHERE run_id = ? ORDER BY created_at, id').pluck();
  const before = new Set(batches.all(o.runId) as string[]);
  const rejected = rejectMetAtLinks(db, ids, { runId: o.runId, actor: 'user', now: o.now });
  return { rejected, batchIds: (batches.all(o.runId) as string[]).filter((b) => !before.has(b)) };
}

// ---------------------------------------------------------------------------------------------- copy

/**
 * The item's ref ('o:<id>' / 'e:<id>') for where this person was met, or null when the item doesn't say or the owner
 * has since marked that link wrong (copy then says "a similar event").
 */
export function metRefOf(db: DB, personId: string, payload: Record<string, unknown>): string | null {
  const l = itemLinkOf(db, personId, payload);
  return l && l.row.status !== 'rejected' ? l.ref : null;
}

/** Title and start of a met-at target for copy; null when gone, untitled or sensitive (never named then). */
export function happeningOf(db: DB, metRef: string): { title: string; startsAt: number | null } | null {
  const id = metRef.slice(2);
  if (metRef.startsWith('e:')) {
    const e = db.prepare('SELECT title, starts_at FROM events WHERE id = ?').get(id) as { title: string | null; starts_at: number | null } | undefined;
    return e?.title?.trim() ? { title: e.title, startsAt: e.starts_at } : null;
  }
  if (!metRef.startsWith('o:')) return null;
  const occ = survivorOccasion(db, id);
  const o = occ ? (db.prepare('SELECT title, starts_at, sensitive FROM occasions WHERE id = ?').get(occ) as { title: string | null; starts_at: number; sensitive: number } | undefined) : undefined;
  return o && o.sensitive === 0 && o.title?.trim() ? { title: o.title, startsAt: o.starts_at } : null;
}
