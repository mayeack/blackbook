/**
 * THE candidate-generator registry: every CandidateGenerator and 🎲 WildcardSource, gathered from the module
 * that owns each signal. The suggestions stage (pipeline/suggestions/) runs exactly these; add a generator by
 * exporting it from your own module's `generators.ts`, never here.
 *
 *   pipeline/ties/generators.ts         fading, cooling, dormant          + wildcard dormant_close
 *   pipeline/obligations/generators.ts  reply_debt, commitment_due
 *   intel/generators.ts                 pre_event_brief, event_followup, party_invite, event_invite, travel_overlap, intro
 *                                       + wildcard intro_pair
 *   pipeline/circles/generators.ts      circle_neglect                    + wildcard circle_checkin
 *   pipeline/suggestions/generators.ts  memory + wildcards unseen_kind, memory; DEFAULT generators for fading,
 *                                       cooling, dormant, reply_debt, commitment_due, circle_neglect and the
 *                                       dormant_close / circle_checkin wildcards
 *
 * One generator per kind and one source per wildcard generator: the signal owner's module wins (it is listed
 * first), the suggestions module's default fills any kind nobody else ships.
 */
import { generators as circleGenerators, wildcardSources as circleWildcards } from '../circles/generators';
import { generators as intelGenerators, wildcardSources as intelWildcards } from '../../intel/generators';
import { generators as obligationGenerators, wildcardSources as obligationWildcards } from '../obligations/generators';
import { generators as tieGenerators, wildcardSources as tieWildcards } from '../ties/generators';
import { generators as suggestionGenerators, wildcardSources as suggestionWildcards } from './generators';
import type { CandidateGenerator, WildcardSource } from './types';

function firstPer<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function allGenerators(): CandidateGenerator[] {
  return firstPer([...obligationGenerators, ...intelGenerators, ...tieGenerators, ...circleGenerators, ...suggestionGenerators], (g) => g.kind);
}

export function allWildcardSources(): WildcardSource[] {
  return firstPer([...tieWildcards, ...intelWildcards, ...circleWildcards, ...obligationWildcards, ...suggestionWildcards], (s) => s.generator);
}
