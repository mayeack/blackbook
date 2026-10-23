/**
 * What the digest is made of: the day's `digests` row and its ranked `digest_items` → `suggestions`, written by the
 * suggestions stage (pipeline/suggestions, 07:16). The composer only reads them; it never ranks.
 *
 * `SelectDigestItems` is the seam: the default reads the rows; a ranker that exposes its own selector can be passed
 * instead (compose / delivery / routes all take `select`). Items whose people are no longer visible (hidden,
 * merged away, roster-only since the ranker ran) are dropped here, so nothing hidden ever reaches a text; so is a
 * "Who to invite" item whose Partiful guest list went stale or that now names someone already invited
 * (intel/invites.ts partyInviteStale), so a duplicate invite never goes out, and an "Invite to a show" item whose
 * tickets are no longer held (or whose Partiful list went stale) loses the whole item, while people who joined the
 * event since, or whose met-at link the owner has marked wrong since, drop out of it (intel/eventInvites.ts
 * eventInviteStale); in a digest read it carries template copy for the people left, which compose.ts shows once
 * its stored copy names someone who dropped out. With `now`, `more`'s item by id gets the same checks.
 */
import {
  SUGGESTION_KINDS,
  WILDCARD_GENERATORS,
  type DigestAction,
  type EvidenceKind,
  type EvidenceRef,
  type PersonChip,
  type SuggestionKind,
  type SuggestionStatus,
  type SuggestionTarget,
  type TieState,
  type WildcardGenerator,
} from '@yb/shared';
import type { DB } from '../db/connection';
import { ownerNames } from '../identity/ownerNames';
import { eventInviteStale } from '../intel/eventInvites';
import { partyInviteStale } from '../intel/invites';
import { settingTimeZone } from '../settings/registry';
import { templateCopy, type ItemCopy } from './template';
import { briefNames } from './text';

export interface DigestRow {
  id: string;
  local_date: string;
  run_id: string | null;
  status: 'composing' | 'ready' | 'sent' | 'fallback_sent' | 'skipped' | 'failed';
  rng_seed: number | null;
  item_cap: number | null;
  imessage_text: string | null;
  web_body: string | null;
  composed_at: number | null;
  sent_at: number | null;
  outbound_id: string | null;
  push_sent_at: number | null;
  llm_usage: string | null;
  skip_reason: string | null;
  composer: 'llm' | 'template' | null;
  imessage_status: string | null;
  push_status: string | null;
  notice_outbound_id: string | null;
  delivery_checked_at: number | null;
}

export interface ItemLinks {
  eventId: string | null;
  occasionId: string | null;
  circleId: string | null;
  commitmentId: string | null;
  replyDebtId: string | null;
  tripId: string | null;
  relatedPersonId: string | null;
}

export interface PersonInfo {
  id: string;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  displayName: string;
  state: TieState | null;
  isPriority: boolean;
}

export interface SelectedItem {
  suggestionId: string;
  ordinal: number;
  kind: SuggestionKind;
  isWildcard: boolean;
  wildcardGenerator: WildcardGenerator | null;
  /** Canonical, visible people (primary first). */
  people: PersonInfo[];
  links: ItemLinks;
  /** Template inputs from the generator (numbers / ids). */
  payload: Record<string, unknown>;
  /** Citation ids ('m:8812', 'F…', 'occ:…', 'event:…', 'K…', 'conv:…'). */
  evidenceIds: string[];
  sensitive: boolean;
  timeCritical: boolean;
  expiresAt: number | null;
  status: SuggestionStatus;
  snoozedUntil: number | null;
  deliveredAt: number | null;
  score: number;
  /** Copy already stored on the suggestion (a previous compose, or the generator's own). */
  title: string | null;
  body: string | null;
  openers: string[];
  /**
   * "Invite to a show" items in a digest read: template copy for the people the item shows now, for when its stored
   * composition named someone who has dropped out since (compose.ts storedComposition).
   */
  currentCopy?: ItemCopy;
}

export interface DigestSelection {
  digest: DigestRow;
  items: SelectedItem[];
  /** Items the ranker picked whose people are no longer visible (not shown anywhere). */
  droppedHidden: number;
  /**
   * "Who to invite" items dropped because their guest list went stale or someone on them is invited by now; "Invite
   * to a show" items whose tickets are gone or whose people have all joined the event.
   */
  droppedStale?: number;
}

export type SelectDigestItems = (db: DB, o: { localDate: string; now: number }) => DigestSelection | null;

interface SuggestionRow {
  id: string;
  ordinal: number;
  kind: string;
  wildcard_generator: string | null;
  person_id: string | null;
  related_person_id: string | null;
  event_id: string | null;
  occasion_id: string | null;
  circle_id: string | null;
  commitment_id: string | null;
  reply_debt_id: string | null;
  trip_id: string | null;
  score: number;
  signals: string;
  title: string | null;
  body: string | null;
  openers: string | null;
  sensitive: number;
  is_wildcard: number;
  /** 013_suggestions columns (tolerated when absent). */
  person_ids?: string | null;
  evidence_ids?: string | null;
  time_critical?: number | null;
  status: SuggestionStatus;
  snoozed_until: number | null;
  expires_at: number | null;
  delivered_at: number | null;
}

/** Legacy kind names in the suggestions CHECK list → the shared enum. */
const KIND_ALIASES: Record<string, SuggestionKind> = {
  pre_event: 'pre_event_brief',
  travel: 'travel_overlap',
  circle: 'circle_neglect',
};

export function normalizeKind(k: string): SuggestionKind | null {
  if ((SUGGESTION_KINDS as readonly string[]).includes(k)) return k as SuggestionKind;
  return KIND_ALIASES[k] ?? null;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * suggestions.signals as the suggestions stage stores it. Tolerant of both shapes: `{payload, evidenceIds,
 * timeCritical, …}` or the generator payload itself (with evidence under `evidenceIds` / `evidence_ids`).
 */
export function parseSignals(raw: string | null): { payload: Record<string, unknown>; evidenceIds: string[]; timeCritical: boolean } {
  const s = asObject(parseJson(raw));
  const payload = Object.keys(asObject(s.payload)).length ? asObject(s.payload) : s;
  const evidenceIds = [...new Set([...strings(s.evidenceIds), ...strings(s.evidence_ids), ...strings(s.evidence), ...strings(payload.evidenceIds)])];
  const timeCritical = s.timeCritical === true || s.time_critical === true || payload.timeCritical === true;
  return { payload, evidenceIds, timeCritical };
}

export function getDigestRow(db: DB, localDate: string): DigestRow | null {
  return (db.prepare('SELECT * FROM digests WHERE local_date = ?').get(localDate) as DigestRow | undefined) ?? null;
}

/** Visible canonical people by id (input ids may be merged-away: they resolve through person_canon). */
export function peopleInfo(db: DB, ids: string[]): Map<string, PersonInfo> {
  const out = new Map<string, PersonInfo>();
  const canon = db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck();
  const get = db.prepare(
    `SELECT v.id, v.first_name, v.last_name, v.nickname, v.display_name, v.is_priority, s.state
     FROM person_visible v LEFT JOIN person_stats s ON s.person_id = v.id WHERE v.id = ?`,
  );
  for (const id of ids) {
    const cid = (canon.get(id) as string | undefined) ?? id;
    const r = get.get(cid) as
      | { id: string; first_name: string | null; last_name: string | null; nickname: string | null; display_name: string; is_priority: number; state: TieState | null }
      | undefined;
    if (r)
      out.set(id, {
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        nickname: r.nickname,
        displayName: r.display_name,
        state: r.state ?? null,
        isPriority: r.is_priority === 1,
      });
  }
  return out;
}

/** The default selector: today's digest row and its items, in ordinal order. Null when the ranker wrote no row. */
export const readDigestSelection: SelectDigestItems = (db, { localDate, now }) => {
  const digest = getDigestRow(db, localDate);
  if (!digest) return null;
  const rows = db
    .prepare(
      `SELECT di.ordinal, s.* FROM digest_items di JOIN suggestions s ON s.id = di.suggestion_id
       WHERE di.digest_id = ? ORDER BY di.ordinal`,
    )
    .all(digest.id) as SuggestionRow[];
  const sel = toSelectedItems(db, rows, now);
  // People drop out of an invite to a show as they join it: copy for those it shows now, named as compose would.
  const invites = sel.items.filter((i) => i.kind === 'event_invite');
  if (invites.length) {
    const ctx = { db, now, timeZone: settingTimeZone(db), names: briefNames(sel.items.flatMap((i) => i.people), ownerNames(db)) };
    for (const i of invites) i.currentCopy = templateCopy(i, ctx);
  }
  return { digest, ...sel };
};

/**
 * One suggestion as a digest item with the given ordinal (e.g. the next one `more` texts), or null if hidden. With
 * `now` (anything about to be shown), the same invite checks as the brief: null when stale, joined people left out.
 */
export function selectedItemById(db: DB, suggestionId: string, ordinal: number, now?: number): SelectedItem | null {
  const row = db.prepare('SELECT ? AS ordinal, s.* FROM suggestions s WHERE s.id = ?').get(ordinal, suggestionId) as SuggestionRow | undefined;
  return row ? (toSelectedItems(db, [row], now).items[0] ?? null) : null;
}

/** `now` (digest reads) also re-checks "Who to invite" / "Invite to a show" items against their guest list (see the header). */
function toSelectedItems(db: DB, rows: SuggestionRow[], now?: number): { items: SelectedItem[]; droppedHidden: number; droppedStale: number } {
  const personIdsOf = (r: SuggestionRow): string[] => {
    const listed = strings(parseJson(r.person_ids ?? null));
    const ids = listed.length ? listed : [r.person_id, r.related_person_id].filter((x): x is string => !!x);
    if (r.related_person_id && !ids.includes(r.related_person_id)) ids.push(r.related_person_id);
    return [...new Set(ids)];
  };
  const ids = [...new Set(rows.flatMap(personIdsOf))];
  const people = peopleInfo(db, ids);
  const items: SelectedItem[] = [];
  let droppedHidden = 0;
  let droppedStale = 0;
  for (const r of rows) {
    const kind = normalizeKind(r.kind);
    if (!kind) continue;
    let personIds = personIdsOf(r);
    if (now !== undefined && kind === 'event_invite') {
      // Gone from the tickets (or a stale Partiful list): the whole item; someone who joined since (or whose met-at
      // link the owner has marked wrong since): just them.
      const st = eventInviteStale(db, { occasionId: r.occasion_id, eventId: r.event_id, personIds, payload: parseSignals(r.signals).payload }, now);
      const left = personIds.filter((id) => !st.drop.has(id));
      if (st.stale || !left.length) {
        droppedStale++;
        continue;
      }
      personIds = left;
    }
    // The people the item is about must all be visible (both for an intro); extra attendees just drop out.
    const required = personIds.slice(0, kind === 'intro' ? 2 : 1);
    if (required.some((id) => !people.get(id))) {
      droppedHidden++;
      continue;
    }
    if (now !== undefined && kind === 'party_invite' && partyInviteStale(db, { occasionId: r.occasion_id, eventId: r.event_id, personIds }, now)) {
      droppedStale++;
      continue;
    }
    const ppl = personIds.map((id) => people.get(id)).filter((p): p is PersonInfo => !!p);
    const sig = parseSignals(r.signals);
    const gen = r.wildcard_generator && (WILDCARD_GENERATORS as readonly string[]).includes(r.wildcard_generator) ? (r.wildcard_generator as WildcardGenerator) : null;
    items.push({
      suggestionId: r.id,
      ordinal: r.ordinal,
      kind,
      isWildcard: r.is_wildcard === 1,
      wildcardGenerator: gen,
      people: [...new Map(ppl.map((p) => [p.id, p])).values()],
      links: {
        eventId: r.event_id,
        occasionId: r.occasion_id,
        circleId: r.circle_id,
        commitmentId: r.commitment_id,
        replyDebtId: r.reply_debt_id,
        tripId: r.trip_id,
        relatedPersonId: r.related_person_id,
      },
      payload: sig.payload,
      evidenceIds: [...new Set([...strings(parseJson(r.evidence_ids ?? null)), ...sig.evidenceIds])],
      sensitive: r.sensitive === 1,
      timeCritical: r.time_critical === 1 || sig.timeCritical,
      expiresAt: r.expires_at,
      status: r.status,
      snoozedUntil: r.snoozed_until,
      deliveredAt: r.delivered_at,
      score: r.score,
      title: r.title,
      body: r.body,
      openers: strings(parseJson(r.openers)),
    });
  }
  return { items, droppedHidden, droppedStale };
}

// ---------------------------------------------------------------------------------------------- DTO pieces

export const DIGEST_ACTIONS: DigestAction[] = ['done', 'snooze', 'skip', 'wrong', 'why', 'draft', 'mute'];

export const toChip = (p: PersonInfo): PersonChip => ({ id: p.id, displayName: p.displayName, firstName: p.firstName, state: p.state });

/** Where tapping the card goes. */
export function targetOf(item: Pick<SelectedItem, 'kind' | 'people' | 'links'>): SuggestionTarget | null {
  const [a, b] = item.people;
  if (item.kind === 'intro' && a && b) return { type: 'pair', id: a.id, otherId: b.id, href: `/p/${a.id}/with/${b.id}` };
  if (
    (item.kind === 'pre_event_brief' || item.kind === 'event_followup' || item.kind === 'party_invite' || item.kind === 'event_invite' || item.kind === 'memory') &&
    (item.links.occasionId || item.links.eventId)
  ) {
    const id = (item.links.occasionId ?? item.links.eventId)!;
    return { type: 'event', id, otherId: null, href: `/e/${id}` };
  }
  if (item.kind === 'circle_neglect' && item.links.circleId) return { type: 'circle', id: item.links.circleId, otherId: null, href: `/c/${item.links.circleId}` };
  if (item.kind === 'travel_overlap' && item.links.tripId && !a) return { type: 'trip', id: item.links.tripId, otherId: null, href: '/trips' };
  if (a) return { type: 'person', id: a.id, otherId: null, href: `/p/${a.id}` };
  if (item.links.circleId) return { type: 'circle', id: item.links.circleId, otherId: null, href: `/c/${item.links.circleId}` };
  return null;
}

/** Citation ids → EvidenceRef (no quotes: the web loads them per evidence item). Unknown shapes are skipped. */
export function evidenceRefs(db: DB, ids: string[], primaryPersonId: string | null): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  const msg = db.prepare('SELECT sent_at, source FROM messages WHERE id = ?');
  for (const ref of ids.slice(0, 12)) {
    let kind: EvidenceKind | null = null;
    let at: number | null = null;
    let source: string | null = null;
    let href: string | null = null;
    const m = /^m:(\d{1,15})$/.exec(ref);
    if (m) {
      kind = 'message';
      const r = msg.get(Number(m[1])) as { sent_at: number; source: string } | undefined;
      at = r?.sent_at ?? null;
      source = r?.source ?? null;
      href = primaryPersonId ? `/p/${primaryPersonId}?m=${m[1]}` : null;
    } else if (/^F[0-9A-Za-z-]{1,40}$/.test(ref)) {
      kind = 'fact';
      href = primaryPersonId ? `/p/${primaryPersonId}` : null;
    } else if (/^occ:[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'occasion';
      href = `/e/${ref.slice(4)}`;
    } else if (/^(?:event|E):?[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'event';
    } else if (/^K[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'commitment';
      href = primaryPersonId ? `/p/${primaryPersonId}` : null;
    } else if (/^(?:debt|D):?[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'reply_debt';
      href = primaryPersonId ? `/p/${primaryPersonId}` : null;
    } else if (/^conv:[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'conversation';
    } else if (/^P[0-9a-f-]{36}$/i.test(ref)) {
      kind = 'person';
      href = `/p/${ref.slice(1)}`;
    }
    if (kind) out.push({ kind, ref, label: null, at, quote: null, source, href });
  }
  return out;
}
