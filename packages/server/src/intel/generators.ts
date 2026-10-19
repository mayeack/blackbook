/**
 * The intel module's candidate generators (registered through pipeline/suggestions/registry.ts; contracts in
 * pipeline/suggestions/types.ts). Pure readers, run by the nightly suggestions stage after the 'intel' job:
 *
 *   pre_event_brief   today's social events with ≥ 2 known attendees (events.ts)
 *   event_followup    the morning after an event you went to: new / gone-quiet people, the host (events.ts)
 *   party_invite      a party / event you host 2–14 days out: whom to invite, Party invites people first (invites.ts)
 *   travel_overlap    trips in 2–10 days with people there, and visitors coming to your city (travel.ts)
 *   intro             the best eligible intro pairs (intros.ts; setting intros.enabled)
 *   🎲 intro_pair     a mid-score intro pair (intros.ts)
 */
import type { CandidateGenerator, WildcardSource } from '../pipeline/suggestions/types';
import { followupCandidates, preEventCandidates } from './events';
import { introCandidates, midScorePair } from './intros';
import { partyInviteCandidates } from './invites';
import { tripCandidates, visitorCandidates } from './travel';

export const preEventBriefGenerator: CandidateGenerator = {
  kind: 'pre_event_brief',
  generate: (ctx) => preEventCandidates(ctx.db, ctx.now, ctx.timeZone),
};

export const eventFollowupGenerator: CandidateGenerator = {
  kind: 'event_followup',
  generate: (ctx) => followupCandidates(ctx.db, ctx.now, ctx.timeZone),
};

export const partyInviteGenerator: CandidateGenerator = {
  kind: 'party_invite',
  generate: (ctx) => partyInviteCandidates(ctx.db, ctx.now, ctx.timeZone),
};

export const travelOverlapGenerator: CandidateGenerator = {
  kind: 'travel_overlap',
  generate: (ctx) => [...tripCandidates(ctx.db, ctx.now, ctx.timeZone), ...visitorCandidates(ctx.db, ctx.now, ctx.timeZone)],
};

export const introGenerator: CandidateGenerator = {
  kind: 'intro',
  generate: (ctx) => (ctx.settings['intros.enabled'] ? introCandidates(ctx.db) : []),
};

export const introPairWildcard: WildcardSource = {
  generator: 'intro_pair',
  generate: (ctx, rng) => (ctx.settings['intros.enabled'] ? midScorePair(ctx.db, rng) : []),
};

export const generators: CandidateGenerator[] = [preEventBriefGenerator, eventFollowupGenerator, partyInviteGenerator, travelOverlapGenerator, introGenerator];

export const wildcardSources: WildcardSource[] = [introPairWildcard];
