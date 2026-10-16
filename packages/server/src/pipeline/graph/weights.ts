/**
 * Edge weights (intelligence §2). Every edge_evidence row contributes w = w_raw × its type's time rule; the pair's
 * W = Σ w (per-type caps applied), strength = 1 − e^(−W/2), tiers close ≥ 0.75 / know ≥ 0.40 / acquainted ≥ 0.15 /
 * faint below (kept, hidden from the graph by default).
 *
 *   co_group            w_raw already carries group activity, pairwise posting and recency (evidence.ts)
 *   group_reply         0.1 per reply/mention inside a group, last 365 days only, cap 1.0
 *   co_attend           × e^(−age/365)
 *   invited_by, plus_one, co_host   × 0.5^(age/730)
 *   met_via             2.0, no decay (legacy "met via", from edge_labels)
 *   mentioned_together  0.3 per message naming both, half-life 365 days, cap 1.5
 *   label               relation labels (edge_labels): partner/spouse 5, sibling/parent_child/family_other 4,
 *                       roommate 3, coworker/classmate 1.5, friend 1, other 0.5, ex 0; × confidence, cap 5
 * Roster-only people (hidden group members) weigh ×0.25 on every edge.
 */
const DAY = 86_400_000;

export type EdgeTierName = 'close' | 'know' | 'acquainted' | 'faint';

export const strengthOf = (w: number): number => 1 - Math.exp(-Math.max(0, w) / 2);

export function tierOf(strength: number): EdgeTierName {
  return strength >= 0.75 ? 'close' : strength >= 0.4 ? 'know' : strength >= 0.15 ? 'acquainted' : 'faint';
}

/** Graph-derived types this module writes into edge_evidence (Partiful and occasions write the others). */
export const DERIVED_TYPES = ['co_group', 'group_reply', 'mentioned_together'] as const;

export const TYPE_CAPS: Readonly<Record<string, number>> = { group_reply: 1.0, mentioned_together: 1.5, label: 5 };

export const ROSTER_FACTOR = 0.25;

/** One evidence row's contribution before caps. */
export function contribution(type: string, wRaw: number, at: number | null, now: number): number {
  const age = at === null ? 0 : Math.max(0, (now - at) / DAY);
  switch (type) {
    case 'co_group':
    case 'met_via':
      return wRaw;
    case 'group_reply':
      return age <= 365 ? wRaw : 0;
    case 'co_attend':
      return wRaw * Math.exp(-age / 365);
    case 'invited_by':
    case 'plus_one':
    case 'co_host':
      return wRaw * 0.5 ** (age / 730);
    case 'mentioned_together':
      return wRaw * 0.5 ** (age / 365);
    default:
      return wRaw * 0.5 ** (age / 365);
  }
}

/** Relation label families (extraction §4.4 enum) and their weights. */
export const LABEL_WEIGHTS: Readonly<Record<string, number>> = {
  partner: 5,
  spouse: 5,
  sibling: 4,
  parent_child: 4,
  family_other: 4,
  roommate: 3,
  coworker: 1.5,
  classmate: 1.5,
  friend: 1,
  other: 0.5,
  ex: 0,
};

/** Labels that make a circle edge (family / partner / roommate). */
export const CLOSE_LABELS: ReadonlySet<string> = new Set(['partner', 'spouse', 'sibling', 'parent_child', 'family_other', 'roommate']);

const SYNONYMS: Readonly<Record<string, string>> = {
  wife: 'spouse',
  husband: 'spouse',
  married: 'spouse',
  girlfriend: 'partner',
  boyfriend: 'partner',
  fiance: 'partner',
  fiancee: 'partner',
  significant_other: 'partner',
  dating: 'partner',
  sister: 'sibling',
  brother: 'sibling',
  twin: 'sibling',
  half_sister: 'sibling',
  half_brother: 'sibling',
  step_sister: 'sibling',
  step_brother: 'sibling',
  parent: 'parent_child',
  mother: 'parent_child',
  father: 'parent_child',
  mom: 'parent_child',
  dad: 'parent_child',
  son: 'parent_child',
  daughter: 'parent_child',
  child: 'parent_child',
  family: 'family_other',
  relative: 'family_other',
  cousin: 'family_other',
  aunt: 'family_other',
  uncle: 'family_other',
  niece: 'family_other',
  nephew: 'family_other',
  grandparent: 'family_other',
  grandmother: 'family_other',
  grandfather: 'family_other',
  grandma: 'family_other',
  grandpa: 'family_other',
  in_law: 'family_other',
  housemate: 'roommate',
  flatmate: 'roommate',
  colleague: 'coworker',
  co_worker: 'coworker',
  teammate: 'coworker',
  boss: 'coworker',
  manager: 'coworker',
  schoolmate: 'classmate',
  best_friend: 'friend',
  close_friend: 'friend',
  bff: 'friend',
  ex_partner: 'ex',
  ex_girlfriend: 'ex',
  ex_boyfriend: 'ex',
  ex_wife: 'ex',
  ex_husband: 'ex',
  former_partner: 'ex',
};

/** Normalizes an edge_labels.label (LLM enum or a legacy free-form label) to a family. */
export function labelFamily(label: string): string {
  const k = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\s-]+/g, '_');
  if (k in LABEL_WEIGHTS) return k;
  if (SYNONYMS[k]) return SYNONYMS[k]!;
  if (/_in_law$/.test(k)) return 'family_other';
  if (/^ex_/.test(k)) return 'ex';
  return 'other';
}

/**
 * A sticky "wrong" on a pair's evidence: an edge_labels row with label `evidence:<type>` (`evidence:*` = every
 * type) and status 'active' (the block is in force; undo tombstones it to 'rejected'). The aggregation drops blocked
 * evidence for the canonical pair, whichever direction. These rows are never relation labels.
 */
export const EVIDENCE_BLOCK_PREFIX = 'evidence:';
export const evidenceBlockLabel = (type: string | '*') => `${EVIDENCE_BLOCK_PREFIX}${type}`;
