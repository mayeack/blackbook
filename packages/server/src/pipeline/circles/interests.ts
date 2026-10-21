/**
 * Interest circles (intelligence §5 "Circles → Interests"): people who share a hobby or interest the extraction found
 * (facts of type interest / activity_pref, tentative or confirmed, not sensitive, not retracted: NamingContext.interests).
 * One auto circle per interest held by MIN_SIZE–MAX_SIZE eligible people, named after the interest ("Skiing",
 * deterministic, no LLM). The circle carries the signature `interest:<value_norm>`, which is how the weekly pass finds
 * it again as people come and go (not by Jaccard). Interests too long for a chip name (over 3 words) are skipped.
 */
import { MAX_SIZE, MIN_SIZE, type Community } from './detect';
import { cleanTitle, interestName, type NamingContext } from './naming';

export const INTEREST_SIGNATURE_PREFIX = 'interest:';

export interface InterestGroup {
  norm: string;
  /** `interest:<norm>` (circles.signature) */
  signature: string;
  name: string;
  description: string;
  community: Community;
}

export function interestGroups(ctx: Pick<NamingContext, 'interests' | 'redact'>, eligible: ReadonlySet<string>): InterestGroup[] {
  const by = new Map<string, { value: string; members: string[] }>();
  for (const [person, held] of ctx.interests) {
    if (!eligible.has(person)) continue;
    for (const [norm, value] of held) {
      const cur = by.get(norm);
      if (!cur) by.set(norm, { value, members: [person] });
      else {
        cur.members.push(person);
        if (value < cur.value) cur.value = value;
      }
    }
  }
  const out: InterestGroup[] = [];
  for (const [norm, g] of [...by].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (g.members.length < MIN_SIZE || g.members.length > MAX_SIZE) continue;
    const name = interestName(ctx, g.value);
    if (!name) continue;
    const core = [...g.members].sort();
    out.push({
      norm,
      signature: `${INTEREST_SIGNATURE_PREFIX}${norm}`,
      name,
      description: `People into ${cleanTitle(ctx, g.value)}`,
      community: { core, scores: new Map(core.map((p) => [p, 1])), near: new Map() },
    });
  }
  return out;
}
