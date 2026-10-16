/**
 * Daily touch units (intelligence §3): for person p and local day d, U_p(d) = min(2.0, Σ components):
 *
 *   1:1 messages both directions that day ......................... 1.0   ('dm')
 *   1:1 messages one way that day ................................. 0.6   ('dm')
 *   co-active group session (both posted) n ≤ 6 / 7–15 / > 15 ..... 0.30 / 0.15 / 0.05   ('grp', the day's best)
 *   they posted in a group session where I didn't ................. 0.05  ('grp')
 *   tapback-only day (a 1:1 reaction, no 1:1 message that day) .... 0.1   ('tap')
 *   Partiful co-attendance / calendar occasion together ........... 1.5   ('evt'; interactions.units)
 *   log: interaction / meeting / manual entry ..................... 1.5   ('log')
 *   call .......................................................... 1.2   ('call')
 *   unmatched legacy text ......................................... 0.6   ('dm')
 * Interactions are read through person_canon (merges are pointers), retracted ones skipped. n is the group's
 * size without the owner.
 */
import type { TouchDay } from './stats';

export interface InteractionRow {
  kind: string;
  conversation_id: string | null;
  started_at: number;
  ended_at: number | null;
  msgs_from_me: number;
  msgs_from_them: number;
  initiated_by_me: number | null;
  units: number | null;
}

export type Components = Partial<Record<'dm' | 'grp' | 'tap' | 'evt' | 'log' | 'call', number>>;

export interface ComputedTouchDay extends TouchDay {
  components: Components;
}

const MAX_UNITS = 2.0;
const EVENT_KINDS: Record<string, { comp: 'evt' | 'log' | 'call' | 'dm'; units: number }> = {
  event: { comp: 'evt', units: 1.5 },
  occasion: { comp: 'evt', units: 1.5 },
  meeting: { comp: 'log', units: 1.5 },
  manual: { comp: 'log', units: 1.5 },
  text_log: { comp: 'log', units: 1.5 },
  call: { comp: 'call', units: 1.2 },
  legacy_text: { comp: 'dm', units: 0.6 },
};

export function groupSessionUnits(n: number | undefined, coActive: boolean): number {
  if (!coActive) return 0.05;
  const size = n ?? 99;
  return size <= 6 ? 0.3 : size <= 15 ? 0.15 : 0.05;
}

interface DayAcc {
  me: number;
  them: number;
  legacyDm: number;
  grp: number;
  evt: number;
  log: number;
  call: number;
  tap: boolean;
  lastAt: number;
  lastIn: number | null;
  lastOut: number | null;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface TouchSummary {
  days: ComputedTouchDay[];
  sessions365: { total: number; mine: number };
  hasMessageHistory: boolean;
}

/**
 * Builds one person's touch days. `reactionTimes`: timestamps of 1:1 tapbacks (either side) in their direct chats.
 */
export function touchDays(
  rows: readonly InteractionRow[],
  o: { dayOf: (ms: number) => number; groupSize: (conversationId: string) => number | undefined; reactionTimes?: readonly number[]; now: number },
): TouchSummary {
  const acc = new Map<number, DayAcc>();
  const get = (day: number): DayAcc => {
    let a = acc.get(day);
    if (!a) acc.set(day, (a = { me: 0, them: 0, legacyDm: 0, grp: 0, evt: 0, log: 0, call: 0, tap: false, lastAt: 0, lastIn: null, lastOut: null }));
    return a;
  };
  const sessions365 = { total: 0, mine: 0 };
  let hasMessageHistory = false;
  const yearAgo = o.now - 365 * 86_400_000;

  for (const r of rows) {
    if (r.started_at > o.now) continue;
    const at = Math.min(r.ended_at ?? r.started_at, o.now);
    const a = get(o.dayOf(r.started_at));
    if (r.kind === 'dm_session') {
      hasMessageHistory = true;
      a.me += r.msgs_from_me;
      a.them += r.msgs_from_them;
      if (r.msgs_from_them > 0) a.lastIn = Math.max(a.lastIn ?? 0, at);
      if (r.msgs_from_me > 0) a.lastOut = Math.max(a.lastOut ?? 0, at);
      if (r.started_at >= yearAgo && r.initiated_by_me !== null) {
        sessions365.total++;
        if (r.initiated_by_me === 1) sessions365.mine++;
      }
    } else if (r.kind === 'group_session') {
      hasMessageHistory = true;
      if (r.msgs_from_them <= 0) continue;
      const u = groupSessionUnits(r.conversation_id ? o.groupSize(r.conversation_id) : undefined, r.msgs_from_me > 0);
      a.grp = Math.max(a.grp, u);
    } else {
      const k = EVENT_KINDS[r.kind];
      if (!k) continue;
      const units = r.units ?? k.units;
      if (k.comp === 'dm') a.legacyDm = Math.max(a.legacyDm, units);
      else a[k.comp] += units;
    }
    a.lastAt = Math.max(a.lastAt, at);
  }
  for (const t of o.reactionTimes ?? []) {
    if (t > o.now) continue;
    const a = get(o.dayOf(t));
    a.tap = true;
    a.lastAt = Math.max(a.lastAt, t);
  }

  const days: ComputedTouchDay[] = [];
  for (const [day, a] of acc) {
    const components: Components = {};
    const dmUnits = a.me > 0 && a.them > 0 ? 1.0 : a.me > 0 || a.them > 0 ? 0.6 : 0;
    const dm = Math.max(dmUnits, a.legacyDm);
    if (dm) components.dm = dm;
    if (a.grp) components.grp = a.grp;
    if (a.evt) components.evt = r4(a.evt);
    if (a.log) components.log = r4(a.log);
    if (a.call) components.call = r4(a.call);
    if (a.tap && !dm) components.tap = 0.1;
    const total = Object.values(components).reduce((s, v) => s + (v ?? 0), 0);
    if (total <= 0) continue;
    days.push({
      day,
      units: r4(Math.min(MAX_UNITS, total)),
      components,
      dm: dm > 0,
      lastAt: a.lastAt,
      lastIn: a.lastIn,
      lastOut: a.lastOut,
    });
  }
  days.sort((x, y) => x.day - y.day);
  return { days, sessions365, hasMessageHistory };
}
