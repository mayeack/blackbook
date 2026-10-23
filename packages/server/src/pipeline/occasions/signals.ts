/**
 * Deterministic attendee scoring (PLAN "Calendar attendee inference" step 4, before the LLM adjudication). Every
 * piece of evidence is a typed signal with a weight in [0, 1]; per type the strongest instance counts, and the
 * types combine as a noisy-OR: score = 1 − Π(1 − w). One signal alone never reaches COUNTED unless it is direct
 * (an accepted invite, a Partiful GOING, a name in the title that resolves cleanly), and one message signal alone
 * never reaches POSSIBLE: from messages only, two independent kinds make a "possible", three an attendee.
 *   ≥ 0.75  attendee: counted in ties (an 'occasion' interaction, 1.5 units) and co_attend edges
 *   ≥ 0.50  possible: stored and shown, not counted
 */
export type SignalType =
  | 'explicit'
  | 'explicit_name'
  | 'title_name'
  | 'notes_name'
  | 'pair_name'
  | 'ticket_holder'
  | 'partiful_going'
  | 'partiful_maybe'
  | 'partiful_host'
  | 'group_nickname'
  | 'mention_dm'
  | 'mention_group'
  | 'date_dm'
  | 'tickets_dm'
  | 'logistics_dm'
  | 'logistics_group'
  | 'after_dm'
  | 'after_group'
  | 'photos_dm'
  | 'group_discussed';

export const COUNTED = 0.75;
export const POSSIBLE = 0.5;
/** Unnamed companions beyond the ticket count are capped just under COUNTED. */
export const CAPPED = 0.74;
/** At most this many message-only companions per occasion are kept as possible/attendee rows. */
export const MAX_UNNAMED = 6;
export const BELOW_POSSIBLE = 0.49;

/** Base weights; name signals are multiplied by how cleanly the name resolved. */
export const WEIGHTS = {
  explicitAccepted: 0.95,
  explicitTentative: 0.7,
  explicitInvited: 0.6,
  explicitName: 0.6,
  titleName: 0.85,
  notesName: 0.75,
  pairName: 0.7,
  ticketHolder: 0.85,
  partifulGoing: 0.9,
  partifulMaybe: 0.55,
  partifulHost: 0.9,
  /** "Dinner w/ the Climbing Crew": every member of a group of ≤ 6 is possible; larger groups weaker. */
  groupNickname: 0.55,
  groupNicknameLarge: 0.45,
  mentionDm: 0.45,
  mentionGroup: 0.3,
  dateDm: 0.3,
  dateKeywordDm: 0.45,
  ticketsDm: 0.15,
  logisticsDm: 0.45,
  logisticsGroup: 0.25,
  afterDm: 0.45,
  afterGroup: 0.25,
  photosDm: 0.2,
  groupDiscussed: 0.2,
} as const;

export interface Signal {
  type: SignalType;
  weight: number;
  /** Evidence message ids (messages.id), at most a handful per signal. */
  m?: number[];
  /** Non-message evidence: 'cal:<calendar event id>', 'event:<id>', 'conv:<id>', 'circle:<id>'. */
  ref?: string;
}

/** Signals that name the person (title, notes, invite, Partiful): they are not "unnamed companions". */
export const NAMED: ReadonlySet<SignalType> = new Set([
  'explicit',
  'explicit_name',
  'title_name',
  'notes_name',
  'pair_name',
  'ticket_holder',
  'partiful_going',
  'partiful_maybe',
  'partiful_host',
]);

const MAX_IDS = 5;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Strongest instance per type (message ids unioned, capped), sorted by type for stable storage. */
export function mergeSignals(signals: readonly Signal[]): Signal[] {
  const by = new Map<SignalType, Signal>();
  for (const s of signals) {
    const cur = by.get(s.type);
    if (!cur) {
      by.set(s.type, {
        type: s.type,
        weight: r3(s.weight),
        ...(s.m ? { m: [...new Set(s.m)].sort((a, b) => a - b).slice(0, MAX_IDS) } : {}),
        ...(s.ref ? { ref: s.ref } : {}),
      });
      continue;
    }
    const ids = [...new Set([...(cur.m ?? []), ...(s.m ?? [])])].sort((a, b) => a - b).slice(0, MAX_IDS);
    const stronger = s.weight > cur.weight ? s : cur;
    by.set(s.type, { type: s.type, weight: r3(Math.max(s.weight, cur.weight)), ...(ids.length ? { m: ids } : {}), ...(stronger.ref ? { ref: stronger.ref } : {}) });
  }
  return [...by.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

export function combine(signals: readonly Signal[]): number {
  let miss = 1;
  for (const s of mergeSignals(signals)) miss *= 1 - Math.min(1, Math.max(0, s.weight));
  return Math.round((1 - miss) * 100) / 100;
}

export const isNamed = (signals: readonly Signal[]): boolean => signals.some((s) => NAMED.has(s.type));

/** Every message id cited by the signals. */
export const evidenceIds = (signals: readonly Signal[]): number[] => [...new Set(signals.flatMap((s) => s.m ?? []))].sort((a, b) => a - b);
