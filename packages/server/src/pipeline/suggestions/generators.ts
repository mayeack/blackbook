/**
 * Candidate generators shipped by the suggestions module (registered through ./registry.ts; contracts in
 * ./types.ts). Generators are pure readers over the tables the other passes own:
 *
 *   fading, cooling, dormant      person_stats (ties pass)               gen/cadence.ts
 *   reply_debt, commitment_due    reply_debts / commitments (obligations) gen/obligations.ts
 *   circle_neglect                circles + occasions/events/group chats  gen/circles.ts
 *   memory                        "on this day" a year ago                gen/memory.ts
 *
 *   🎲 wildcards: dormant_close (cadence), unseen_kind (gen/unseen.ts), memory, circle_checkin (circles).
 *
 * The registry keeps ONE generator per kind (and per wildcard generator): a module that owns the signal and ships
 * its own generator (pipeline/ties, pipeline/obligations, pipeline/circles, intel) takes precedence; these are the
 * defaults when it doesn't.
 */
import { circleCheckinWildcard, circleNeglectGenerator } from './gen/circles';
import { coolingGenerator, dormantCloseWildcard, dormantGenerator, fadingGenerator } from './gen/cadence';
import { memoryGenerator, memoryWildcard } from './gen/memory';
import { commitmentGenerator, replyDebtGenerator } from './gen/obligations';
import { unseenKindWildcard } from './gen/unseen';
import type { CandidateGenerator, WildcardSource } from './types';

export const generators: CandidateGenerator[] = [
  replyDebtGenerator,
  commitmentGenerator,
  fadingGenerator,
  coolingGenerator,
  dormantGenerator,
  circleNeglectGenerator,
  memoryGenerator,
];

export const wildcardSources: WildcardSource[] = [dormantCloseWildcard, unseenKindWildcard, memoryWildcard, circleCheckinWildcard];
