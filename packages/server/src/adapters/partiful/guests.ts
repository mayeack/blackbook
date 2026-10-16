/**
 * Partiful guest lists → partiful_user identities (identity/external.ts, §1.4 status) + event_attendees rows.
 * event_attendees is journaled: one 'attendee' batch per event and pass, so a sync is undoable per event or per
 * run; an undone row is tombstoned 'rejected' and re-ingest leaves it alone. Rows other sources own (legacy,
 * calendar inference) are never touched.
 * Which lists are read (PLAN: "only for events that are new, changed, or within ±14 days"): events within the
 * window (re-read at most twice a day), events whose content hash moved since their list was read, and events
 * never read, newest first: upcoming ones, then a capped trickle of past ones (the first backfill of ~300 past
 * events spreads over several nights). Hidden lists (showGuestList=false unless I host) and canceled events are
 * never requested.
 * §1.4 for guests: a guest list is a roster, so a guest stays roster_only unless the relationship qualifies on
 * its own (a guest of an event I host, the host of an event I go to, whoever invited me, a plus-one tie with me)
 * or they co-attended ≥2 events of ≤40 going with me.
 * Large lists (more than LARGE_GUEST_LIST guests, not mine: public events reach thousands) add only people already
 * known as Partiful users plus the qualifying ones; strangers there are counted, never created.
 * A guest record that embeds its user's profile (`user.socials`) gets the Instagram link right here, so no
 * getUsers call is spent on it.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attachExternalIdentity, personOfIdentity } from '../../identity/external';
import { withBatch, type Row } from '../../journal/batch';
import { MAX_CO_ATTEND_PEOPLE } from './edges';
import { showGuestListOf, storedEvents, type StoredEvent } from './events';
import { attendanceWeight, mapGuestStatus, type ParsedGuest } from './schemas';
import { markProfile, notePartifulUser, type IgLink, type RunScope } from './scope';
import { linkInstagram } from './users';

const DAY = 86_400_000;
/** "Small" event for §1.4 promotion (mirrors the co_group >40-members cut-off). */
export const SMALL_EVENT_GOING = 40;
const ATTENDING = new Set(['going', 'approved', 'maybe', 'checked_in', 'attended']);
/** Above this many guests (and not my event) only known or qualifying people are added. */
export const LARGE_GUEST_LIST = MAX_CO_ATTEND_PEOPLE;

export interface GuestLimits {
  /** ± days around now in which lists are re-read every run. */
  windowDays: number;
  /** Never-read past events per run (trickled backfill). */
  backfillEventsPerRun: number;
  /** All guest lists per run. */
  guestEventsPerRun: number;
}

export const DEFAULT_GUEST_LIMITS: GuestLimits = { windowDays: 14, backfillEventsPerRun: 40, guestEventsPerRun: 60 };

export interface GuestPlan {
  due: StoredEvent[];
  /** Lists not requested this run, with the state to record (only when it changed). */
  quiet: { ev: StoredEvent; status: 'hidden' | 'skipped' }[];
  /** Never-read lists left for later runs. */
  backfillPending: number;
}

const isCanceled = (e: StoredEvent) => e.ev.canceled || /cancel/i.test(e.status ?? '');

/** Chooses this run's guest lists (see the header). */
export function planGuestFetches(db: DB, now: number, limits: GuestLimits = DEFAULT_GUEST_LIMITS): GuestPlan {
  const window = limits.windowDays * DAY;
  const plan: GuestPlan = { due: [], quiet: [], backfillPending: 0 };
  const inWindow: StoredEvent[] = [];
  const changed: StoredEvent[] = [];
  const neverUpcoming: StoredEvent[] = [];
  const neverPast: StoredEvent[] = [];
  for (const e of storedEvents(db)) {
    const hidden = showGuestListOf(e.visibility) === false && e.myRole !== 'host';
    const quiet = isCanceled(e) ? 'skipped' : hidden ? 'hidden' : null;
    if (quiet) {
      if (e.guestsStatus !== quiet || e.guestsHash !== e.contentHash) plan.quiet.push({ ev: e, status: quiet });
      continue;
    }
    const near = e.startsAt !== null && Math.abs(e.startsAt - now) <= window;
    // A list hidden or skipped earlier counts as unread once the event changed (e.g. the host showed it).
    const wasQuiet = (e.guestsStatus === 'hidden' || e.guestsStatus === 'skipped') && e.guestsHash !== e.contentHash;
    if (e.guestsFetchedAt === null || wasQuiet) {
      // A date-less ("TBD") event is still being planned: it ranks with the upcoming ones.
      if (near || e.startsAt === null || e.startsAt > now) neverUpcoming.push(e);
      else neverPast.push(e);
    } else if (near && e.guestsFetchedAt < now - DAY / 2) inWindow.push(e);
    else if (e.guestsHash !== e.contentHash) changed.push(e);
  }
  inWindow.sort((a, b) => Math.abs(a.startsAt! - now) - Math.abs(b.startsAt! - now));
  neverUpcoming.sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity));
  neverPast.sort((a, b) => (b.startsAt ?? -Infinity) - (a.startsAt ?? -Infinity));
  const backfill = neverPast.slice(0, limits.backfillEventsPerRun);
  plan.due = [...inWindow, ...changed, ...neverUpcoming, ...backfill].slice(0, limits.guestEventsPerRun);
  const dueIds = new Set(plan.due.map((e) => e.rowId));
  plan.backfillPending = [...neverUpcoming, ...neverPast].filter((e) => !dueIds.has(e.rowId)).length;
  return plan;
}

export function markGuestState(
  db: DB,
  e: StoredEvent,
  now: number,
  status: 'ok' | 'hidden' | 'partial' | 'error' | 'skipped',
  o: { seen?: number | null; goingCount?: number | null; fetched?: boolean } = {},
): void {
  db.prepare(
    `UPDATE partiful_event_sync SET guests_status = @status, guests_hash = @hash,
       guests_fetched_at = CASE WHEN @fetched THEN @now ELSE guests_fetched_at END,
       guests_seen = coalesce(@seen, guests_seen), going_count = max(coalesce(going_count, 0), coalesce(@going, 0)), updated_at = @now
     WHERE event_id = @sid`,
  ).run({ status, hash: e.contentHash, fetched: o.fetched ? 1 : 0, now, seen: o.seen ?? null, going: o.goingCount ?? null, sid: e.ev.id });
}

export interface GuestApplyStats {
  guests: number;
  without_user: number;
  unknown_statuses: number;
  attendees_new: number;
  attendees_updated: number;
  attendees_kept: number;
  /** Strangers on a large list, not added. */
  guests_skipped_large: number;
  /** Profiles (with socials) embedded in guest records. */
  embedded_profiles: number;
  ig_handles: number;
  ig_linked: number;
  ig_attached: number;
  ig_incompatible: number;
}

interface Entry {
  userId: string;
  guestId: string | null;
  name: string | null;
  status: string;
  role: 'host' | 'co_host' | 'guest' | 'plus_one';
  rsvpAt: number | null;
  invitedByUser: string | null;
  anchorUser: string | null;
  instagram: string | null;
  hasProfile: boolean;
}

interface AttendeeRow {
  id: string;
  status: string;
  source: string;
  role: string | null;
  identity_id: string | null;
  invited_by_person_id: string | null;
  plus_one_of_person_id: string | null;
  rsvp_at: number | null;
}

const PERSON_OK = `SELECT 1 FROM people WHERE id = ? AND kind IN ('person','me') AND status NOT IN ('service','suppressed')`;

/** Writes one event's guest list (identities + one attendee batch) in a transaction. */
export function applyGuestList(s: RunScope, e: StoredEvent, guests: readonly ParsedGuest[], status: 'ok' | 'partial' = 'ok'): GuestApplyStats {
  const { db, ctx, now, uid } = s;
  const stats: GuestApplyStats = {
    guests: guests.length,
    without_user: 0,
    unknown_statuses: 0,
    attendees_new: 0,
    attendees_updated: 0,
    attendees_kept: 0,
    guests_skipped_large: 0,
    embedded_profiles: 0,
    ig_handles: 0,
    ig_linked: 0,
    ig_attached: 0,
    ig_incompatible: 0,
  };
  return tx(db, () => {
    const owners = e.ev.ownerIds;
    const iHost = e.myRole === 'host' || owners.includes(uid);
    const mine = guests.find((g) => g.userId === uid) ?? null;
    let myRsvp = e.myRsvp;
    if (mine?.status) {
      const m = mapGuestStatus(mine.status).status;
      if (m !== myRsvp) {
        db.prepare('UPDATE events SET my_rsvp = ?, updated_at = ? WHERE id = ?').run(m, now, e.rowId);
        myRsvp = m;
      }
    }
    const myGuestId = mine?.guestId ?? e.ev.myGuest?.guestId ?? null;
    const myInviter = mine?.invitedBy ?? e.ev.myGuest?.invitedBy ?? null;
    const myAnchor = mine?.anchorGuestId ?? e.ev.myGuest?.anchorGuestId ?? null;
    const iAttend = iHost || ATTENDING.has(myRsvp ?? '');

    const userOfGuest = new Map<string, string>();
    for (const g of guests) if (g.guestId && g.userId) userOfGuest.set(g.guestId, g.userId);
    const resolveUser = (ref: string | null) => (ref ? (userOfGuest.get(ref) ?? ref) : null);

    const entries = new Map<string, Entry>();
    for (const g of guests) {
      if (!g.userId) {
        stats.without_user++;
        continue;
      }
      if (g.userId === uid) continue;
      const m = mapGuestStatus(g.status);
      if (!m.known) stats.unknown_statuses++;
      const ownerAt = owners.indexOf(g.userId);
      const entry: Entry = {
        userId: g.userId,
        guestId: g.guestId,
        name: g.name,
        status: m.status,
        role: ownerAt === 0 ? 'host' : ownerAt > 0 ? 'co_host' : g.anchorGuestId ? 'plus_one' : 'guest',
        rsvpAt: g.rsvpAt,
        invitedByUser: resolveUser(g.invitedBy),
        anchorUser: g.anchorGuestId ? (userOfGuest.get(g.anchorGuestId) ?? null) : null,
        instagram: g.instagram,
        hasProfile: g.hasProfile,
      };
      const prev = entries.get(g.userId);
      if (!prev || attendanceWeight(entry.status) > attendanceWeight(prev.status)) entries.set(g.userId, entry);
    }
    // Hosts are on the event even when the list doesn't show them.
    owners.forEach((o, i) => {
      if (o !== uid && !entries.has(o)) {
        entries.set(o, {
          userId: o,
          guestId: null,
          name: null,
          status: 'host',
          role: i === 0 ? 'host' : 'co_host',
          rsvpAt: null,
          invitedByUser: null,
          anchorUser: null,
          instagram: null,
          hasProfile: false,
        });
      }
    });
    const going = [...entries.values()].filter((x) => attendanceWeight(x.status) === 1).length + (iAttend ? 1 : 0);
    const goingCount = Math.max(e.goingCount ?? 0, going);
    const small = goingCount <= SMALL_EVENT_GOING;
    const large = !iHost && entries.size > LARGE_GUEST_LIST;

    const findIdentity = db.prepare(`SELECT id FROM identities WHERE kind = 'partiful_user' AND key = ?`).pluck();
    const coAttended = db
      .prepare(
        `SELECT count(DISTINCT a.event_id) FROM event_attendees a
         JOIN events ev ON ev.id = a.event_id
         LEFT JOIN partiful_event_sync ps ON ps.event_id = ev.source_event_id
         WHERE a.identity_id = @identity AND a.source = 'partiful' AND a.event_id <> @event
           AND a.status IN ('going','approved','maybe','checked_in','attended','host')
           AND (ev.my_role = 'host' OR ev.my_rsvp IN ('going','approved','maybe','checked_in','attended'))
           AND coalesce(ps.going_count, 0) <= ${SMALL_EVENT_GOING}`,
      )
      .pluck();
    const personOk = db.prepare(PERSON_OK);

    const personByUser = new Map<string, string>();
    if (s.mePersonId) personByUser.set(uid, s.mePersonId);
    const identityByUser = new Map<string, string>();
    for (const x of entries.values()) {
      const existing = findIdentity.get(x.userId) as string | undefined;
      const isHostRole = x.role === 'host' || x.role === 'co_host';
      const theyAttend = ATTENDING.has(x.status) || x.status === 'host';
      const qualifies =
        iHost || // my own guest list: people I (or my co-hosts) invited
        (isHostRole && iAttend) ||
        myInviter === x.userId ||
        (myGuestId !== null && x.anchorUser === uid) ||
        (myAnchor !== null && myAnchor === x.guestId);
      if (large && !existing && !qualifies) {
        stats.guests_skipped_large++;
        continue;
      }
      const groups = (existing ? (coAttended.get({ identity: existing, event: e.rowId }) as number) : 0) + (iAttend && theyAttend && small ? 1 : 0);
      const at = Math.min(now, x.rsvpAt ?? e.startsAt ?? now);
      const identityId = attachExternalIdentity(ctx, { kind: 'partiful_user', key: x.userId, displayName: x.name, at, signals: { qualifies, groups } });
      if (!identityId) continue;
      notePartifulUser(db, x.userId, identityId, now);
      if (x.hasProfile) {
        stats.embedded_profiles++;
        let link: IgLink | null = null;
        if (x.instagram) {
          stats.ig_handles++;
          link = linkInstagram(s, identityId, { id: x.userId, name: x.name, instagram: x.instagram });
          if (link === 'linked') stats.ig_linked++;
          else if (link === 'attached') stats.ig_attached++;
          else if (link === 'incompatible') stats.ig_incompatible++;
        }
        markProfile(db, x.userId, now, { hasInstagram: !!x.instagram, link });
      }
      const personId = personOfIdentity(db, identityId);
      if (!personId || personOk.get(personId) === undefined) continue;
      personByUser.set(x.userId, personId);
      identityByUser.set(x.userId, identityId);
    }
    const personOfUser = (u: string | null): string | null => {
      if (!u) return null;
      const known = personByUser.get(u);
      if (known) return known;
      const id = findIdentity.get(u) as string | undefined;
      return id ? personOfIdentity(db, id) : null;
    };

    // Plan the attendee writes (one row per pre-canon person; the stronger status wins a collision).
    const planned = new Map<string, Row>();
    for (const x of entries.values()) {
      const personId = personByUser.get(x.userId);
      if (!personId || personId === s.mePersonId) continue;
      const row: Row = {
        event_id: e.rowId,
        person_id: personId,
        identity_id: identityByUser.get(x.userId) ?? null,
        status: x.status,
        role: x.role,
        invited_by_person_id: personOfUser(x.invitedByUser),
        plus_one_of_person_id: personOfUser(x.anchorUser),
        rsvp_at: x.rsvpAt,
      };
      const prev = planned.get(personId);
      if (!prev || attendanceWeight(x.status) > attendanceWeight(String(prev.status))) planned.set(personId, row);
    }
    const getRow = db.prepare(
      `SELECT id, status, source, role, identity_id, invited_by_person_id, plus_one_of_person_id, rsvp_at FROM event_attendees
       WHERE event_id = ? AND person_id = ?`,
    );
    const inserts: Row[] = [];
    const updates: { id: string; patch: Row }[] = [];
    for (const row of planned.values()) {
      const cur = getRow.get(e.rowId, row.person_id) as AttendeeRow | undefined;
      if (!cur) {
        inserts.push({ id: uuidv7(now), ...row, source: 'partiful', confidence: 1, run_id: ctx.runId() });
        continue;
      }
      // Undone ('rejected') rows and rows another source owns stay as they are.
      if (cur.source !== 'partiful' || cur.status === 'rejected') {
        stats.attendees_kept++;
        continue;
      }
      const patch: Row = {};
      for (const k of ['status', 'role', 'identity_id'] as const) if (row[k] !== null && row[k] !== cur[k]) patch[k] = row[k];
      for (const k of ['invited_by_person_id', 'plus_one_of_person_id', 'rsvp_at'] as const) {
        if (row[k] !== null && row[k] !== undefined && row[k] !== cur[k]) patch[k] = row[k];
      }
      if (Object.keys(patch).length) updates.push({ id: cur.id, patch });
    }
    if (inserts.length || updates.length) {
      const what = [inserts.length ? `${inserts.length} added` : '', updates.length ? `${updates.length} updated` : ''].filter(Boolean).join(', ');
      withBatch(
        db,
        { runId: ctx.runId(), kind: 'attendee', title: `Partiful guest list of “${e.title ?? 'an event'}”: ${what}`, actor: ctx.actor ?? 'agent' },
        (t) => {
          for (const r of inserts) t.insert('event_attendees', r);
          for (const u of updates) t.update('event_attendees', { id: u.id }, u.patch);
        },
        { now },
      );
    }
    stats.attendees_new += inserts.length;
    stats.attendees_updated += updates.length;
    markGuestState(db, e, now, status, { seen: guests.length, goingCount, fetched: true });
    return stats;
  });
}
