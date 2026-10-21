/**
 * Pure helpers for the person page, the Connections tab and the pair page (unit-tested; no React here).
 */
import type { EdgeTier, EvidenceRef, FactType, FactView, OpenLoop, SparkPoint, TieState, TieStats } from '@yb/shared';
import type { PersonDetail } from '../../api/types';
import { relativeDay } from '../../lib/format';
import { stateLabel } from '../../lib/labels';

// ---------------------------------------------------------------------------------------------- tabs

export type PersonTab = 'overview' | 'timeline' | 'connections';

/** `?tab=` wins; a cited message (`?m=`) opens the timeline. */
export function personTab(params: URLSearchParams): PersonTab {
  const t = params.get('tab');
  if (t === 'timeline' || t === 'connections' || t === 'overview') return t;
  return params.has('m') ? 'timeline' : 'overview';
}

// ---------------------------------------------------------------------------------------------- header

const TIE_STATES = new Set<string>(['strong', 'steady', 'cooling', 'fading', 'dormant', 'new']);

/** The base person's stats in TieStats form, for when /ties isn't available (no sparkline or reciprocity). */
export function tiesFromPerson(p: Pick<PersonDetail, 'id' | 'stats' | 'closeness'>): TieStats | null {
  const s = p.stats;
  if (!s) return null;
  const state = s.state && TIE_STATES.has(s.state) ? (s.state as TieState) : null;
  return {
    personId: p.id,
    state,
    label: s.state ? stateLabel(s.state) : null,
    tieStrength: s.tieStrength,
    historicalStrength: null,
    closeness: p.closeness,
    expectedGapD: s.expectedGapD,
    silenceD: s.silenceD,
    fadingRatio: null,
    momentum: null,
    reciprocity: null,
    iStartShare: null,
    contactDays365: null,
    lastAt: s.lastAt,
    fadingSuppressed: s.fadingSuppressed,
    sparkline: [],
    computedAt: null,
  };
}

/** "usually every ~9d · last 41d ago" (either half may be missing). */
export function cadenceLine(t: Pick<TieStats, 'expectedGapD' | 'lastAt'> | null | undefined, now = Date.now()): string | null {
  if (!t) return null;
  const parts: string[] = [];
  if (t.expectedGapD != null && t.expectedGapD > 0) parts.push(`usually every ~${Math.max(1, Math.round(t.expectedGapD))}d`);
  if (t.lastAt != null) parts.push(`last ${relativeDay(t.lastAt, now)}`);
  return parts.length ? parts.join(' · ') : null;
}

/** "you start 82% of conversations" when there's enough to say it (null otherwise). */
export function initiativeLine(t: Pick<TieStats, 'iStartShare' | 'contactDays365'> | null | undefined): string | null {
  if (!t || t.iStartShare == null || (t.contactDays365 ?? 0) < 4) return null;
  const pct = Math.round(t.iStartShare * 100);
  if (pct >= 60) return `you start ${pct}% of conversations`;
  if (pct <= 40) return `they start ${100 - pct}% of conversations`;
  return 'you each start about half the conversations';
}

/** The ring around the avatar: T in 0–100 as a stroke dash over the circle's circumference. */
export function ringDash(t: number | null | undefined, radius: number): { length: number; gap: number; fraction: number } {
  const c = 2 * Math.PI * radius;
  const fraction = t == null || !Number.isFinite(t) ? 0 : Math.min(1, Math.max(0, t / 100));
  return { length: c * fraction, gap: c * (1 - fraction), fraction };
}

/** CSS custom property name for a state's color (green / amber / red / gray). */
export function stateColorVar(state: TieState | string | null | undefined): string {
  switch (state) {
    case 'strong':
    case 'steady':
      return 'var(--state-strong)';
    case 'cooling':
      return 'var(--state-cooling)';
    case 'fading':
      return 'var(--state-fading)';
    case 'new':
      return 'var(--accent)';
    default:
      return 'var(--state-dormant)';
  }
}

/**
 * SVG polyline points for the weekly tie-strength sparkline, oldest left. The y range is 0–100 (T), so a flat
 * strong line sits high and a flat weak one low. Fewer than two points draws nothing.
 */
export function sparklineCoords(points: readonly SparkPoint[], width: number, height: number, pad = 2): [number, number][] {
  if (points.length < 2) return [];
  const xs = width - 2 * pad;
  const ys = height - 2 * pad;
  return points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * xs;
    const t = Math.min(100, Math.max(0, Number.isFinite(p.t) ? p.t : 0));
    const y = pad + (1 - t / 100) * ys;
    return [round1(x), round1(y)];
  });
}

export const sparklinePoints = (points: readonly SparkPoint[], width: number, height: number, pad = 2): string =>
  sparklineCoords(points, width, height, pad)
    .map(([x, y]) => `${x},${y}`)
    .join(' ');

const round1 = (n: number) => Math.round(n * 10) / 10;

/** "Closeness 7 of 10" (1 acquaintance … 10 closest). */
export const closenessText = (c: number): string => `Closeness ${c} of 10`;

/** "Strong · closeness 7 of 10" for the ring's accessible name. */
export function ringLabel(t: Pick<TieStats, 'label' | 'tieStrength' | 'closeness'> | null | undefined): string {
  if (!t) return 'No tie strength yet';
  return t.label ? `${t.label} · ${closenessText(t.closeness).toLowerCase()}` : closenessText(t.closeness);
}

// ---------------------------------------------------------------------------------------------- open loops

export function loopSubtitle(l: Pick<OpenLoop, 'type' | 'since' | 'due' | 'owner' | 'likely' | 'detail'>, now = Date.now()): string {
  const parts: string[] = [];
  if (l.type === 'reply_debt') parts.push(`${l.likely ? 'Likely owe a reply' : 'You owe a reply'} · asked ${relativeDay(l.since, now)}`);
  else parts.push(`${l.owner === 'them' ? 'They promised' : l.owner === 'both' ? 'You both said' : 'You promised'} ${relativeDay(l.since, now)}`);
  if (l.due && l.due.precision !== 'none' && (l.due.end ?? l.due.start) != null) {
    const at = (l.due.precision === 'range' ? l.due.end : l.due.start) ?? l.due.start ?? l.due.end!;
    parts.push(at < now ? `was due ${relativeDay(at, now)}` : `due ${relativeDay(at, now)}`);
  }
  if (l.detail) parts.push(l.detail);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------- facts

/** Places holds place names only ("Los Angeles, CA"); a trip is a plan in its own words, so it has its own group. */
export type FactGroup = 'Interests' | 'Work & school' | 'Places' | 'Trips' | 'Life' | 'Other';

const FACT_GROUPS: Record<FactType, FactGroup> = {
  interest: 'Interests',
  activity_pref: 'Interests',
  food_drink: 'Interests',
  preference: 'Interests',
  job: 'Work & school',
  employer: 'Work & school',
  role: 'Work & school',
  school: 'Work & school',
  education: 'Work & school',
  home_location: 'Places',
  location_current: 'Places',
  location_next: 'Places',
  hometown: 'Places',
  travel_plan: 'Trips',
  address: 'Places',
  relationship_status: 'Life',
  family: 'Life',
  pet: 'Life',
  other: 'Other',
};

const GROUP_ORDER: FactGroup[] = ['Interests', 'Work & school', 'Places', 'Trips', 'Life', 'Other'];

const FACT_TYPE_LABELS: Partial<Record<FactType, string>> = {
  activity_pref: 'Likes to',
  food_drink: 'Food & drink',
  job: 'Job',
  employer: 'Works at',
  role: 'Role',
  school: 'School',
  education: 'Studied',
  home_location: 'Lives in',
  location_current: 'Currently in',
  location_next: 'Heading to',
  hometown: 'From',
  travel_plan: 'Trip',
  address: 'Address',
  relationship_status: 'Relationship',
  family: 'Family',
  pet: 'Pet',
};

/** A short prefix for a fact chip ("Lives in", "Works at"); interests and "other" have none. */
export const factPrefix = (t: FactType): string | null => FACT_TYPE_LABELS[t] ?? null;

/** Facts grouped for display, groups in a fixed order, most supported first within a group. */
export function groupFacts(facts: readonly FactView[]): { group: FactGroup; facts: FactView[] }[] {
  const by = new Map<FactGroup, FactView[]>();
  for (const f of facts) {
    const g = FACT_GROUPS[f.type] ?? 'Other';
    const list = by.get(g) ?? [];
    list.push(f);
    by.set(g, list);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({
    group: g,
    facts: by.get(g)!.sort((a, b) => b.support - a.support || b.confidence - a.confidence || a.value.localeCompare(b.value)),
  }));
}

/** "Tentative" for facts the agent isn't sure about yet (shown dashed). */
export const isTentative = (f: Pick<FactView, 'status'>) => f.status === 'tentative' || f.status === 'candidate';

// ---------------------------------------------------------------------------------------------- evidence

/** "iMessage · Oct 3" style label, falling back to the kind. */
export function evidenceLabel(e: Pick<EvidenceRef, 'label' | 'kind' | 'at'>, now = Date.now()): string {
  if (e.label) return e.label;
  const kind = e.kind === 'message' ? 'Message' : e.kind === 'event' || e.kind === 'occasion' ? 'Event' : e.kind[0]!.toUpperCase() + e.kind.slice(1);
  return e.at != null ? `${kind} · ${relativeDay(e.at, now)}` : kind;
}

/**
 * The in-app link for a piece of evidence. Messages get the timestamp as a hint (`at=`) so the timeline can jump
 * to the right conversation without scanning; only relative app paths are allowed.
 */
export function evidenceHref(e: Pick<EvidenceRef, 'href' | 'at' | 'kind'>): string | null {
  if (!e.href || !e.href.startsWith('/') || e.href.startsWith('//')) return null;
  if (e.kind === 'message' && e.at != null && /[?&]m=/.test(e.href) && !/[?&]at=/.test(e.href)) return `${e.href}&at=${e.at}`;
  return e.href;
}

// ---------------------------------------------------------------------------------------------- connections

const TIER_LABELS: Record<EdgeTier, string> = { close: 'Close', know: 'Know each other', acquainted: 'Acquainted', faint: 'Faint' };
export const tierLabel = (t: EdgeTier) => TIER_LABELS[t] ?? t;

const RELATION_LABELS: Record<string, string> = {
  partner: 'Partner',
  spouse: 'Spouse',
  sibling: 'Sibling',
  parent_child: 'Parent / child',
  family_other: 'Family',
  roommate: 'Roommate',
  coworker: 'Coworker',
  classmate: 'Classmate',
  friend: 'Friend',
  other: 'Related',
};
export const relationLabel = (l: string) => RELATION_LABELS[l] ?? l.replace(/_/g, ' ');

const EDGE_TYPE_LABELS: Record<string, string> = {
  co_group: 'Group chats',
  group_reply: 'Group replies',
  co_attend: 'Events together',
  invited_by: 'Invites',
  plus_one: 'Plus-one',
  co_host: 'Co-hosts',
  met_via: 'Met via',
  mentioned_together: 'Mentioned together',
  label: 'Relationship',
  tie: 'Your ties',
};
export const edgeTypeLabel = (t: string) => EDGE_TYPE_LABELS[t] ?? t.replace(/_/g, ' ');

export interface EgoNode {
  id: string;
  x: number;
  y: number;
  r: number;
  center: boolean;
}

/**
 * A radial ego graph in a `size`×`size` box: the person in the middle, neighbors on a ring ordered by strength
 * (closer = stronger), so the strongest sit nearest. Deterministic (no layout iterations), at most `max` neighbors.
 */
export function egoLayout(
  centerId: string,
  neighbors: readonly { id: string; strength: number }[],
  size: number,
  max = 16,
): EgoNode[] {
  const c = size / 2;
  const out: EgoNode[] = [{ id: centerId, x: c, y: c, r: Math.max(8, size * 0.07), center: true }];
  const shown = [...neighbors].sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : 1)).slice(0, max);
  const n = shown.length;
  const outer = size / 2 - Math.max(10, size * 0.07);
  const inner = outer * 0.45;
  shown.forEach((nb, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    const s = Math.min(1, Math.max(0, nb.strength));
    const dist = outer - (outer - inner) * s;
    out.push({ id: nb.id, x: round1(c + dist * Math.cos(angle)), y: round1(c + dist * Math.sin(angle)), r: round1(4 + 5 * s), center: false });
  });
  return out;
}

/** Web route of the pair page. */
export const pairPath = (a: string, b: string) => `/p/${encodeURIComponent(a)}/with/${encodeURIComponent(b)}`;

export const strengthPct = (s: number) => `${Math.round(Math.min(1, Math.max(0, s)) * 100)}%`;

/** Semicircle gauge arc (0–1) as an SVG path from the left end to the value point, center (cx, cy), radius r. */
export function gaugeArc(value: number, cx: number, cy: number, r: number): string {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const angle = Math.PI * (1 - v);
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${round1(x)} ${round1(y)}`;
}
