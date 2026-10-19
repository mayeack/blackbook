/**
 * Implicit reward attribution (job 'rewards', hourly; PLAN "Rewards"):
 *   - acted = 1: an outbound message from me (1:1, or a small group ≤7 with them), a call, an occasion/meeting
 *     together, or a `log:` entry with one of the item's people, after delivery and within the kind's window
 *     (72 h for reply debt / commitments / pre-event, 7 days otherwise); for a party invite, also one of its people
 *     joining the hosted event's guest list (a Partiful invite never shows up as a message);
 *   - counterfactual guard: if I was already messaging them in the 24 h before delivery, the action gets no credit
 *     (the item still closes as done, the learner learns nothing);
 *   - ignored = 0 at weight 0.5 when the window ends with no action and no other outcome (an opened item keeps its
 *     0.3), and the person's ignore streak grows (cooldown 7 d × 2^n, cap 90 d); acting resets it.
 * The window starts at a real impression of this showing: the iMessage send, the push, or the first time the web
 * served the card (GET /today records a 'seen' feedback row; an open / why / draft counts too). An item nobody saw
 * (the digest is off by default and Today wasn't opened) teaches nothing: once its window would have closed it goes
 * back to the pool undecided (status 'candidate'), with no outcome and no ignore streak.
 * Circle-level items count an action with any member. Only this ranker's tables are written (no journal).
 */
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { nullLogger, type Logger } from '../../ops/logger';
import { readSetting } from '../../settings/registry';
import { uuidv7 } from '@yb/shared';
import { occasionChain } from '../occasions/build';
import { ATTENDING } from './gen/common';
import { armsFor, effectiveOutcome, recordIgnore, recordOutcome, resetIgnores, type ArmRef } from './learner';
import { PeopleCache } from './people';
import { personIdsOf, type SuggestionRow } from './store';
import { KIND_POLICY, LEARNER, REWARDS } from './types';

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Groups up to this many members (me included) count as "with them". */
const SMALL_GROUP = 7;

export interface Action {
  at: number;
  via: 'message' | 'interaction' | 'attendance' | 'guest_list';
}

/** Conversations where a message from me reaches the person: 1:1, or a small group they're in. */
function reachConversations(db: DB, persons: readonly string[]): string[] {
  if (!persons.length) return [];
  return db
    .prepare(
      `SELECT DISTINCT c.id FROM identities i
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN conversation_members cm ON cm.identity_id = i.id
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?))
         AND (c.kind = 'direct' OR (c.kind = 'group' AND coalesce(c.member_count, 99) <= ${SMALL_GROUP}))`,
    )
    .pluck()
    .all(JSON.stringify(persons)) as string[];
}

function firstOutbound(db: DB, convs: readonly string[], from: number, to: number, inclusiveFrom: boolean): number | null {
  if (!convs.length) return null;
  return (
    (db
      .prepare(
        `SELECT min(sent_at) FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND is_from_me = 1 AND is_bot = 0
           AND kind IN ('text','attachment','link','poll','sticker') AND sent_at ${inclusiveFrom ? '>=' : '>'} ? AND sent_at <= ?`,
      )
      .pluck()
      .get(JSON.stringify(convs), from, to) as number | null) ?? null
  );
}

/** The first thing I did with any of `persons` in (from, to]. */
export function firstAction(db: DB, persons: readonly string[], from: number, to: number): Action | null {
  if (!persons.length || to <= from) return null;
  const json = JSON.stringify(persons);
  const options: Action[] = [];
  const msg = firstOutbound(db, reachConversations(db, persons), from, to, false);
  if (msg !== null) options.push({ at: msg, via: 'message' });
  const at = `(CASE WHEN i.kind IN ('manual','text_log') THEN i.created_at ELSE i.started_at END)`;
  const inter = db
    .prepare(
      `SELECT min(${at}) FROM interactions i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) AND i.retracted_at IS NULL
         AND i.kind IN ('call','meeting','occasion','event','manual','text_log') AND ${at} > ? AND ${at} <= ?`,
    )
    .pluck()
    .get(json, from, to) as number | null;
  if (inter !== null) options.push({ at: inter, via: 'interaction' });
  const occ = db
    .prepare(
      `SELECT min(o.starts_at) FROM event_attendees a JOIN occasions o ON o.id = a.occasion_id
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) AND a.status IN ${ATTENDING} AND a.confidence >= 0.75
         AND o.merged_into_id IS NULL AND o.status = 'active' AND o.starts_at > ? AND o.starts_at <= ?`,
    )
    .pluck()
    .get(json, from, to) as number | null;
  if (occ !== null) options.push({ at: occ, via: 'attendance' });
  return options.sort((a, b) => a.at - b.at)[0] ?? null;
}

/** party_invite: the first time one of `persons` joined the hosted event's guest list (any live status) in (from, to]. */
export function guestListAction(db: DB, r: Pick<SuggestionRow, 'occasion_id' | 'event_id'>, persons: readonly string[], from: number, to: number): Action | null {
  if (!persons.length || to <= from || (!r.occasion_id && !r.event_id)) return null;
  const at = db
    .prepare(
      `SELECT min(a.created_at) FROM event_attendees a JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(@persons))
         AND (a.occasion_id IN (SELECT value FROM json_each(@chain)) OR (@event IS NOT NULL AND a.event_id = @event))
         AND a.status NOT IN ('rejected','withdrawn') AND a.created_at > @from AND a.created_at <= @to`,
    )
    .pluck()
    .get({ persons: JSON.stringify(persons), chain: JSON.stringify(r.occasion_id ? occasionChain(db, r.occasion_id) : []), event: r.event_id, from, to }) as number | null;
  return at === null ? null : { at, via: 'guest_list' };
}

/** Counterfactual guard: I was already messaging them in [from, to). */
export function wasActive(db: DB, persons: readonly string[], from: number, to: number): boolean {
  const convs = reachConversations(db, persons);
  if (!convs.length) return false;
  const v = db
    .prepare(
      `SELECT 1 FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND is_from_me = 1 AND is_bot = 0
         AND kind IN ('text','attachment','link','poll','sticker') AND sent_at >= ? AND sent_at < ? LIMIT 1`,
    )
    .pluck()
    .get(JSON.stringify(convs), from, to);
  return !!v;
}

interface PendingRow extends SuggestionRow {
  digest_sent_at: number | null;
  digest_push_sent_at?: number | null;
  /** First web impression (seen / open / why / draft feedback) since the latest selection. */
  web_seen_at?: number | null;
}

/** Feedback actions that prove the owner saw the card. */
export const IMPRESSION_ACTIONS = ['seen', 'open', 'why', 'draft'] as const;

/**
 * When the item reached the owner this showing: the iMessage send, the push, or the first web impression; null
 * when nobody has seen it. A time from before the latest selection belongs to an earlier showing and is ignored.
 */
export function shownAt(r: Pick<PendingRow, 'delivered_at' | 'digest_sent_at' | 'selected_at'> & Partial<Pick<PendingRow, 'digest_push_sent_at' | 'web_seen_at'>>): number | null {
  const fresh = (t: number | null | undefined) => (t != null && (r.selected_at === null || t >= r.selected_at) ? t : null);
  const times = [fresh(r.delivered_at), fresh(r.digest_sent_at), fresh(r.digest_push_sent_at), fresh(r.web_seen_at)].filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

/**
 * Records that the web showed these cards (one 'seen' feedback row per suggestion per showing; repeat views of the
 * same showing write nothing). Only selected / delivered rows count.
 */
export function recordImpressions(db: DB, suggestionIds: readonly string[], o: { now: number; channel: 'web' | 'push' | 'imessage' }): number {
  if (!suggestionIds.length) return 0;
  let n = 0;
  const row = db.prepare(`SELECT status, selected_at FROM suggestions WHERE id = ?`);
  const seen = db.prepare(`SELECT 1 FROM feedback WHERE suggestion_id = ? AND action = 'seen' AND created_at >= ? LIMIT 1`).pluck();
  const ins = db.prepare(
    `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, created_at) VALUES (?, ?, 'suggestion', ?, 'seen', NULL, ?, ?)`,
  );
  tx(db, () => {
    for (const id of new Set(suggestionIds)) {
      const r = row.get(id) as { status: string; selected_at: number | null } | undefined;
      if (!r || (r.status !== 'selected' && r.status !== 'delivered')) continue;
      if (seen.get(id, r.selected_at ?? 0)) continue;
      ins.run(uuidv7(o.now), id, id, o.channel, o.now);
      n++;
    }
  });
  return n;
}

/** The arms an outcome of this row trains (stored at ranking; recomputed for items that were never ranked). */
export function armsOfRow(db: DB, r: SuggestionRow, people = new PeopleCache(db)): ArmRef[] {
  if (r.learned_factors) {
    try {
      const arms = (JSON.parse(r.learned_factors) as { arms?: ArmRef[] }).arms;
      if (Array.isArray(arms) && arms.length) return arms;
    } catch {
      /* recompute */
    }
  }
  const ids = personIdsOf(r);
  const primary = ids[0] ? people.get(ids[0]) : null;
  return armsFor(r.kind, primary, r.is_wildcard ? r.wildcard_generator : null, r.circle_id);
}

function circleMembers(db: DB, circleId: string): string[] {
  return db
    .prepare(
      `SELECT DISTINCT pv.id FROM circle_members cm JOIN person_canon pc ON pc.person_id = cm.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id WHERE cm.circle_id = ? AND cm.excluded = 0`,
    )
    .pluck()
    .all(circleId) as string[];
}

export interface RewardsResult {
  stats: { checked: number; acted: number; counterfactual: number; ignored: number; open: number; unseen: number };
}

export async function attributeRewards(db: DB, o: { now?: number; log?: Logger; signal?: AbortSignal; limit?: number } = {}): Promise<RewardsResult> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const stats = { checked: 0, acted: 0, counterfactual: 0, ignored: 0, open: 0, unseen: 0 };
  const baseDays = readSetting(db, 'agent.ignore_cooldown_days');
  const rows = db
    .prepare(
      `SELECT s.*, d.sent_at AS digest_sent_at, d.push_sent_at AS digest_push_sent_at,
              (SELECT min(f.created_at) FROM feedback f WHERE f.suggestion_id = s.id AND f.created_at >= s.selected_at
                 AND f.action IN (SELECT value FROM json_each(@impressions))) AS web_seen_at
       FROM suggestions s LEFT JOIN digests d ON d.id = s.digest_id
       WHERE s.selected_at IS NOT NULL AND s.decided_at IS NULL ORDER BY s.selected_at, s.id LIMIT @limit`,
    )
    .all({ impressions: JSON.stringify(IMPRESSION_ACTIONS), limit: o.limit ?? 5000 }) as PendingRow[];
  const people = new PeopleCache(db);
  for (const r of rows) {
    if (o.signal?.aborted) break;
    stats.checked++;
    if (stats.checked % 50 === 0) await yieldToLoop();
    if (['done', 'dismissed', 'wrong'].includes(r.status)) {
      // explicit feedback already decided it
      db.prepare('UPDATE suggestions SET decided_at = ? WHERE id = ?').run(r.acted_at ?? now, r.id);
      continue;
    }
    // Snoozed items resurface later (their showing was decided neutrally); anything else not shown is not ours.
    if (r.status !== 'selected' && r.status !== 'delivered') continue;
    const start = shownAt(r);
    if (start === null) {
      // Never surfaced: once its window would have closed, it goes back to the pool without teaching anything.
      if (r.selected_at !== null && now >= r.selected_at + KIND_POLICY[r.kind].actWindowMs) {
        db.prepare(`UPDATE suggestions SET status = 'candidate', decided_at = ?, updated_at = ? WHERE id = ? AND status IN ('selected','delivered')`).run(now, now, r.id);
        stats.unseen++;
      }
      continue;
    }
    if (start > now) continue;
    const end = start + KIND_POLICY[r.kind].actWindowMs;
    const persons = personIdsOf(r).length ? personIdsOf(r) : r.circle_id ? circleMembers(db, r.circle_id) : [];
    const act =
      [firstAction(db, persons, start, Math.min(now, end)), r.kind === 'party_invite' ? guestListAction(db, r, persons, start, Math.min(now, end)) : null]
        .filter((a): a is Action => a !== null)
        .sort((a, b) => a.at - b.at)[0] ?? null;
    if (act) {
      const guarded = wasActive(db, persons, start - LEARNER.counterfactualMs, start);
      tx(db, () => {
        if (!guarded) {
          recordOutcome(db, { suggestionId: r.id, ...REWARDS.acted, arms: armsOfRow(db, r, people), now });
          db.prepare(
            `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, created_at)
             VALUES (?, ?, 'suggestion', ?, 'acted', ?, 'system', ?)`,
          ).run(uuidv7(now), r.id, r.id, JSON.stringify({ via: act.via, at: act.at }), now);
        }
        const details = { ...(r.rank_details ? (JSON.parse(r.rank_details) as object) : {}), credit: guarded ? 'counterfactual' : 'implicit', actedVia: act.via };
        db.prepare(`UPDATE suggestions SET status = 'done', acted_at = ?, decided_at = ?, rank_details = ?, updated_at = ? WHERE id = ?`).run(
          act.at,
          now,
          JSON.stringify(details),
          now,
          r.id,
        );
        for (const p of personIdsOf(r)) resetIgnores(db, p, now);
      });
      if (guarded) stats.counterfactual++;
      else stats.acted++;
      continue;
    }
    if (now < end) continue;
    tx(db, () => {
      const existing = effectiveOutcome(db, r.id);
      if (!existing) {
        recordOutcome(db, { suggestionId: r.id, ...REWARDS.ignored, arms: armsOfRow(db, r, people), now });
        const primary = personIdsOf(r)[0];
        if (primary) recordIgnore(db, primary, now, baseDays);
        stats.ignored++;
      } else stats.open++;
      db.prepare(`UPDATE suggestions SET status = 'ignored', decided_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
    });
  }
  if (stats.checked) log.info('suggestions.rewards', { job: 'rewards', counts: stats });
  return { stats };
}
