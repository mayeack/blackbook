/**
 * Met-at inputs, read per canonical person (person_canon):
 *
 *   candidates     people who may get a link: canonical, kind 'person', active / provisional / roster-only (a
 *                  roster-only person is brought forward when linked), never hidden, merged, service, suppressed
 *                  or the owner (identity/self.ts).
 *   signals        when the owner newly connected with them, the earliest of each kind, trusted only:
 *                    contact_screenshot  a linked contact_screenshots row (taken_at); never an IG profile showing
 *                                        ≥ 5k followers (found.followers);
 *                    contact_added       the person's earliest address-book card (created_at = the collector's
 *                                        ZCREATIONDATE, else first_seen_at), present, with a given or family name,
 *                                        not part of a bulk (≥ 5 creation times within 2 min, judged over every
 *                                        card) and, without created_at, not first seen in the very first dump;
 *                    instagram_follow    the earliest 'following' follow (never follower-only), not in a burst of
 *                                        ≥ 10 follows within 30 min;
 *                    instagram_dm        the first message of the person's earliest direct Instagram chat, when its
 *                                        first message is the real one — the thread is DYI-matched (full history),
 *                                        or the chat was born while watched (Beeper history complete, row created
 *                                        ≤ 1 d after the first message) — and the owner wrote in its first session
 *                                        (DYI exports include unanswered message requests, so that applies to both).
 *   known since    the earliest evidence the owner already knew them (a person is "known before" E when it is
 *                  earlier than E.start − 12 h): 1:1 conversations and dm/call/meeting/text_log/manual/legacy
 *                  interactions, group sessions in groups of ≤ 50, counted attendance at one of the owner's occasions
 *                  (not excluded or cancelled) or a Partiful event he went to, of ≤ 50 counted people, a legacy-origin
 *                  record, any of the signal sources above (trusted or not:
 *                  every card, every following follow, every screenshot), a ticket transfer counterparty, a group
 *                  chat of ≤ 12 members, and an open match_candidates partner's own history (the guestCheck "maybe"
 *                  rule).
 * Reads only; nothing is logged.
 */
import type { DB } from '../../db/connection';
import { selfPeople } from '../../identity/self';
import { COUNTED } from '../../pipeline/occasions/signals';
import { DEFAULT_SESSION_RULES, SESSION_KINDS } from '../../pipeline/sessionize';
import { burstIndexes, MET_AT, personLabels, type PersonLabels, type SignalKind } from './score';

export interface Candidate {
  id: string;
  status: 'active' | 'provisional' | 'roster_only';
  displayName: string;
  labels: PersonLabels;
}

export interface Signal {
  kind: SignalKind;
  t: number;
}

export interface SignalStats {
  screenshots: number;
  screenshots_followers: number;
  cards: number;
  cards_bulk: number;
  cards_first_dump: number;
  cards_unnamed: number;
  follows: number;
  follows_burst: number;
  dms: number;
  dms_untrusted: number;
}

export interface MetAtInputs {
  candidates: Map<string, Candidate>;
  signals: Map<string, Signal[]>;
  /** Canonical person → earliest "already knew them" time (−∞ for legacy records). Absent = no evidence. */
  knownSince: Map<string, number>;
  stats: SignalStats;
}

const KIND_LIST = SESSION_KINDS.map((k) => `'${k}'`).join(',');
const COUNTED_LIST = `'going','attended','approved','checked_in','host'`;
const GROUP_SIZE = (alias: string) =>
  `coalesce(${alias}.member_count, (SELECT count(*) FROM conversation_members x WHERE x.conversation_id = ${alias}.id))`;

const lower = (m: Map<string, number>, id: string, t: number | null | undefined) => {
  if (t === null || t === undefined || Number.isNaN(t) || t === Number.POSITIVE_INFINITY) return;
  const cur = m.get(id);
  if (cur === undefined || t < cur) m.set(id, t);
};

// ---------------------------------------------------------------------------------------------- people

export function loadCandidates(db: DB): Map<string, Candidate> {
  const self = selfPeople(db);
  const rows = db
    .prepare(
      `SELECT id, status, display_name, first_name, last_name FROM people
       WHERE merged_into_id IS NULL AND kind = 'person' AND status IN ('active','provisional','roster_only') AND is_hidden = 0`,
    )
    .all() as { id: string; status: Candidate['status']; display_name: string; first_name: string | null; last_name: string | null }[];
  const handles = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `SELECT pc.canonical_id AS pid, i.key FROM identities i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE i.kind = 'instagram_username' AND i.status <> 'detached'`,
    )
    .all() as { pid: string; key: string }[]) {
    const l = handles.get(r.pid) ?? [];
    l.push(r.key);
    handles.set(r.pid, l);
  }
  const out = new Map<string, Candidate>();
  for (const r of rows) {
    if (self.has(r.id)) continue;
    const full = [r.first_name, r.last_name].filter(Boolean).join(' ');
    out.set(r.id, { id: r.id, status: r.status, displayName: r.display_name, labels: personLabels([r.display_name, full], handles.get(r.id) ?? []) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- signals

interface CardRow {
  pid: string | null;
  created_at: number | null;
  first_seen_at: number;
  removed_at: number | null;
  fields: string;
}

const named = (fields: string): boolean => {
  try {
    const f = JSON.parse(fields) as { given?: unknown; family?: unknown };
    return (typeof f.given === 'string' && f.given.trim() !== '') || (typeof f.family === 'string' && f.family.trim() !== '');
  } catch {
    return false;
  }
};

/** Whether the owner wrote in the chat's first session (DM session rules: a > 2 h gap or 12 h span ends it). */
function ownerInFirstSession(db: DB, conversationId: string): boolean {
  const rows = db
    .prepare(`SELECT sent_at, is_from_me FROM messages WHERE conversation_id = ? AND kind IN (${KIND_LIST}) ORDER BY sent_at, id LIMIT ?`)
    .all(conversationId, DEFAULT_SESSION_RULES.maxMessages) as { sent_at: number; is_from_me: number }[];
  if (!rows.length) return false;
  const start = rows[0]!.sent_at;
  let prev = start;
  for (const r of rows) {
    if (r.sent_at - prev > DEFAULT_SESSION_RULES.dmGapMs || r.sent_at - start > DEFAULT_SESSION_RULES.maxSpanMs) break;
    if (r.is_from_me === 1) return true;
    prev = r.sent_at;
  }
  return false;
}

/** Trusted signals of every candidate, plus the evidence each source gives for "known since". */
export function loadSignals(
  db: DB,
  candidates: ReadonlyMap<string, Candidate>,
): { signals: Map<string, Signal[]>; evidence: Map<string, number>; stats: SignalStats } {
  const stats: SignalStats = {
    screenshots: 0,
    screenshots_followers: 0,
    cards: 0,
    cards_bulk: 0,
    cards_first_dump: 0,
    cards_unnamed: 0,
    follows: 0,
    follows_burst: 0,
    dms: 0,
    dms_untrusted: 0,
  };
  const evidence = new Map<string, number>();
  const earliest = new Map<string, Map<SignalKind, number>>();
  const put = (pid: string, kind: SignalKind, t: number) => {
    const m = earliest.get(pid) ?? new Map<SignalKind, number>();
    const cur = m.get(kind);
    if (cur === undefined || t < cur) m.set(kind, t);
    earliest.set(pid, m);
  };

  // Screenshots.
  for (const s of db
    .prepare(
      `SELECT pc.canonical_id AS pid, s.taken_at AS t, CAST(coalesce(json_extract(s.found, '$.followers'), 0) AS REAL) AS followers
       FROM contact_screenshots s JOIN person_canon pc ON pc.person_id = s.person_id
       WHERE s.status = 'linked' AND s.taken_at IS NOT NULL`,
    )
    .all() as { pid: string; t: number; followers: number }[]) {
    if (s.followers >= MET_AT.maxFollowers) {
      stats.screenshots_followers++;
      continue;
    }
    lower(evidence, s.pid, s.t);
    if (candidates.has(s.pid)) put(s.pid, 'contact_screenshot', s.t);
  }

  // Address-book cards: bulks are judged over every card (a setup day's import is one bulk whoever it holds).
  const cards = db
    .prepare(
      `SELECT pc.canonical_id AS pid, c.created_at, c.first_seen_at, c.removed_at, c.fields
       FROM addressbook_cards c LEFT JOIN identities i ON i.id = c.identity_id LEFT JOIN person_canon pc ON pc.person_id = i.person_id`,
    )
    .all() as CardRow[];
  if (cards.length) {
    const eff = cards.map((c) => c.created_at ?? c.first_seen_at);
    const bulk = burstIndexes(eff, MET_AT.bulkCount, MET_AT.bulkWindowMs);
    const firstPass = cards.reduce((m, c) => Math.min(m, c.first_seen_at), Number.POSITIVE_INFINITY);
    // The person's earliest card decides: trusted → the signal; else they were simply known from then on.
    const first = new Map<string, number>();
    cards.forEach((c, i) => {
      if (!c.pid) return;
      lower(evidence, c.pid, Math.min(c.created_at ?? c.first_seen_at, c.first_seen_at));
      const cur = first.get(c.pid);
      if (cur === undefined || eff[i]! < eff[cur]!) first.set(c.pid, i);
    });
    for (const [pid, i] of first) {
      if (!candidates.has(pid)) continue;
      const c = cards[i]!;
      if (c.removed_at !== null) continue;
      if (bulk.has(i)) stats.cards_bulk++;
      else if (c.created_at === null && c.first_seen_at <= firstPass + MET_AT.firstDumpMs) stats.cards_first_dump++;
      else if (!named(c.fields)) stats.cards_unnamed++;
      else put(pid, 'contact_added', eff[i]!);
    }
  }

  // Instagram follows (owner → them). Bursts are judged over every 'following' row.
  const follows = db
    .prepare(
      `SELECT pc.canonical_id AS pid, f.followed_at AS t
       FROM instagram_follows f LEFT JOIN identities i ON i.id = f.identity_id AND i.status <> 'detached'
       LEFT JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE f.direction = 'following' AND f.followed_at IS NOT NULL`,
    )
    .all() as { pid: string | null; t: number }[];
  const burst = burstIndexes(follows.map((f) => f.t), MET_AT.burstCount, MET_AT.burstWindowMs);
  const firstFollow = new Map<string, number>();
  follows.forEach((f, i) => {
    if (!f.pid) return;
    lower(evidence, f.pid, f.t);
    const cur = firstFollow.get(f.pid);
    if (cur === undefined || f.t < follows[cur]!.t) firstFollow.set(f.pid, i);
  });
  for (const [pid, i] of firstFollow) {
    if (!candidates.has(pid)) continue;
    if (burst.has(i)) stats.follows_burst++;
    else put(pid, 'instagram_follow', follows[i]!.t);
  }

  // Instagram DMs: one other person per direct chat; the person's earliest chat decides.
  const self = selfPeople(db);
  const convs = db
    .prepare(
      `SELECT c.id, c.source, c.created_at,
              coalesce((SELECT min(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.kind IN (${KIND_LIST})), c.first_message_at) AS first_at,
              EXISTS (SELECT 1 FROM ig_dyi_threads d WHERE d.conversation_id = c.id) AS dyi,
              coalesce((SELECT json_extract(sc.meta, '$.complete') FROM source_cursors sc WHERE sc.source = 'instagram' AND sc.scope = c.source_conv_id), 0) AS complete
       FROM conversations c WHERE c.kind = 'direct' AND c.source IN ('instagram','instagram_dyi')`,
    )
    .all() as { id: string; source: string; created_at: number; first_at: number | null; dyi: number; complete: number }[];
  const others = db
    .prepare(
      `SELECT pc.canonical_id FROM conversation_members m JOIN identities i ON i.id = m.identity_id JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE m.conversation_id = ? AND i.status <> 'detached'
       UNION
       SELECT pc.canonical_id FROM messages g JOIN identities i ON i.id = g.sender_identity_id JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE g.conversation_id = ? AND g.is_from_me = 0 AND i.status <> 'detached'`,
    )
    .pluck();
  const firstDm = new Map<string, { t: number; trusted: boolean }>();
  for (const c of convs) {
    if (c.first_at === null) continue;
    const people = (others.all(c.id, c.id) as string[]).filter((p) => !self.has(p));
    if (people.length !== 1) continue;
    const pid = people[0]!;
    lower(evidence, pid, c.first_at);
    const watched = c.source === 'instagram' && c.complete === 1 && c.created_at - c.first_at <= MET_AT.bornWatchedMs;
    const cur = firstDm.get(pid);
    if (cur && cur.t <= c.first_at) continue;
    const trusted = (c.dyi === 1 || watched) && ownerInFirstSession(db, c.id);
    firstDm.set(pid, { t: c.first_at, trusted });
  }
  for (const [pid, d] of firstDm) {
    if (!candidates.has(pid)) continue;
    if (d.trusted) put(pid, 'instagram_dm', d.t);
    else stats.dms_untrusted++;
  }

  const signals = new Map<string, Signal[]>();
  for (const [pid, m] of earliest) {
    const list = [...m].map(([kind, t]) => ({ kind, t })).sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : 1));
    signals.set(pid, list);
    for (const s of list) {
      if (s.kind === 'contact_screenshot') stats.screenshots++;
      else if (s.kind === 'contact_added') stats.cards++;
      else if (s.kind === 'instagram_follow') stats.follows++;
      else stats.dms++;
    }
  }
  return { signals, evidence, stats };
}

// ---------------------------------------------------------------------------------------------- known since

/**
 * Canonical person → the earliest time the owner demonstrably knew them (see the module header). `evidence` is the
 * signal sources' own evidence (loadSignals).
 */
export function knownSince(db: DB, evidence: ReadonlyMap<string, number>): Map<string, number> {
  const own = new Map<string, number>(evidence);
  const take = (sql: string) => {
    for (const r of db.prepare(sql).all() as { pid: string; t: number | null }[]) lower(own, r.pid, r.t);
  };
  // Interactions (never 'event'/'occasion': attendance is judged below, with its size rule).
  take(
    `SELECT pc.canonical_id AS pid, min(i.started_at) AS t
     FROM interactions i JOIN person_canon pc ON pc.person_id = i.person_id LEFT JOIN conversations c ON c.id = i.conversation_id
     WHERE i.retracted_at IS NULL
       AND (i.kind IN ('dm_session','call','meeting','text_log','manual','legacy_text')
            OR (i.kind = 'group_session' AND c.id IS NOT NULL AND ${GROUP_SIZE('c')} <= ${MET_AT.maxGroupSession}))
     GROUP BY pc.canonical_id`,
  );
  // 1:1 conversations of any source (iMessage, WhatsApp, Instagram), whether or not sessions were derived yet.
  take(
    `SELECT pc.canonical_id AS pid,
            min(coalesce(c.first_message_at, (SELECT min(g.sent_at) FROM messages g WHERE g.conversation_id = c.id AND g.kind IN (${KIND_LIST})))) AS t
     FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
     JOIN identities i ON i.id = m.identity_id JOIN person_canon pc ON pc.person_id = i.person_id
     WHERE c.kind = 'direct' AND i.status <> 'detached'
     GROUP BY pc.canonical_id`,
  );
  // Small group chats (≤ 12): the member row predates the cutoff.
  take(
    `SELECT pc.canonical_id AS pid, min(coalesce(m.joined_at, m.first_seen_at)) AS t
     FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
     JOIN identities i ON i.id = m.identity_id JOIN person_canon pc ON pc.person_id = i.person_id
     WHERE c.kind = 'group' AND i.status <> 'detached' AND ${GROUP_SIZE('c')} <= ${MET_AT.maxCoMemberGroup}
     GROUP BY pc.canonical_id`,
  );
  // Counted attendance at an owner-attended occasion or Partiful event of ≤ 50 counted people.
  take(
    `WITH sizes AS (
       SELECT coalesce('o:' || occasion_id, 'e:' || event_id) AS k, count(DISTINCT person_id) AS n FROM event_attendees
       WHERE lower(status) IN (${COUNTED_LIST}) AND confidence >= ${COUNTED} GROUP BY 1
     )
     SELECT pc.canonical_id AS pid, min(coalesce(o.starts_at, e.starts_at)) AS t
     FROM event_attendees a JOIN person_canon pc ON pc.person_id = a.person_id
     JOIN sizes s ON s.k = coalesce('o:' || a.occasion_id, 'e:' || a.event_id)
     LEFT JOIN occasions o ON o.id = a.occasion_id LEFT JOIN events e ON e.id = a.event_id
     WHERE lower(a.status) IN (${COUNTED_LIST}) AND a.confidence >= ${COUNTED} AND s.n <= ${MET_AT.maxAttendance}
       AND ((o.id IS NOT NULL AND o.status NOT IN ('excluded','cancelled'))
         OR (e.id IS NOT NULL AND (lower(coalesce(e.my_rsvp, '')) IN ('going','approved','checked_in','attended')
                                   OR lower(coalesce(e.my_role, '')) IN ('host','co_host','cohost'))
             AND lower(coalesce(e.status, '')) NOT LIKE '%cancel%'))
     GROUP BY pc.canonical_id`,
  );
  // A ticket transfer counterparty: known from that email on.
  take(
    `SELECT pc.canonical_id AS pid, min(coalesce(g.internal_at, te.starts_at, tp.created_at)) AS t
     FROM ticket_parties tp JOIN person_canon pc ON pc.person_id = tp.person_id
     LEFT JOIN gmail_messages g ON g.gmail_id = tp.gmail_id LEFT JOIN ticket_events te ON te.id = tp.ticket_event_id
     WHERE tp.person_id IS NOT NULL
     GROUP BY pc.canonical_id`,
  );
  // Legacy records: known since forever.
  for (const pid of db
    .prepare(
      `SELECT DISTINCT pc.canonical_id FROM people p JOIN person_canon pc ON pc.person_id = p.id WHERE p.origin = 'legacy' OR p.legacy_pk IS NOT NULL`,
    )
    .pluck()
    .all() as string[]) {
    own.set(pid, Number.NEGATIVE_INFINITY);
  }
  // An open possible-duplicate partner's history counts as theirs.
  const out = new Map(own);
  for (const r of db
    .prepare(
      `SELECT ca.canonical_id AS a, cb.canonical_id AS b FROM match_candidates m
       JOIN person_canon ca ON ca.person_id = m.a_id JOIN person_canon cb ON cb.person_id = m.b_id
       WHERE m.status IN ('pending','possible_duplicate','held') AND ca.canonical_id <> cb.canonical_id`,
    )
    .all() as { a: string; b: string }[]) {
    lower(out, r.a, own.get(r.b));
    lower(out, r.b, own.get(r.a));
  }
  return out;
}

export function loadInputs(db: DB): MetAtInputs {
  const candidates = loadCandidates(db);
  const { signals, evidence, stats } = loadSignals(db, candidates);
  return { candidates, signals, knownSince: knownSince(db, evidence), stats };
}
