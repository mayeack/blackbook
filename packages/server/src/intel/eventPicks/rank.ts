/**
 * Scoring and choosing event picks (design docs/design/event-picks.md §5).
 *
 *   taste    how alike the event is to what he went to: intel/similarity.ts sim() against every happening in the
 *            profile, the mean of the three best (each × its recency weight / the heaviest weight), so one strong
 *            match (a performer he has seen) counts and a pile of weak ones doesn't;
 *   kind     the share of his going-out that is this kind of event (club nights 45% …), scaled so the top kind = 1;
 *   learned  what his answers to earlier picks taught: a Beta(1 + yes, 1 + no) per feature value (category, each
 *            genre, venue, each performer, and where it came from: the web, a newsletter or his Recurring Events
 *            calendar) over picked events — went (a ticket email, calendar entry or RSVP, or he said so) +1 yes,
 *            tapped the link without going +0.5 yes, "not for me" +1 no, the night passed untouched +0.25 no (but
 *            nothing when he had other plans that night: outcome 'busy') — one Thompson draw per value, averaged
 *            (no history = 0.5);
 *   link     an event's own ticket page 1, resale 0.6, a listing page 0.2.
 *
 *   score = 0.4·taste + 0.25·kind + 0.25·learned + 0.1·link
 *
 * Choosing (choosePerDay; owner 2026-10-28: "Have 3-5 events per day where it looks like I am free"): for each free
 * day, best score first, up to events.max_picks that day (less the Recurring Events listings already on it), at most
 * PICK.perKind of one kind while others are left, events with a ticket (or resale) link first; one with only a listing
 * page only to reach PICK.minPerDay. With probability PICK.wildcardEpsilon one slot of the week goes to a 🎲 wildcard:
 * the best remaining event of a kind he rarely goes to (share < 15%), so the picks can learn beyond what he already
 * does. Deterministic for a given rng.
 */
import { features, similarity, type EventFeatures, type TicketCategory } from '../similarity';
import type { LinkKind } from './links';
import type { TasteProfile } from './profile';

export const PICK = {
  weights: { taste: 0.4, kind: 0.25, learned: 0.25, link: 0.1 },
  linkScore: { ticket: 1, resale: 0.6, listing: 0.2 } as Readonly<Record<LinkKind, number>>,
  /** A free day gets at least this many when there are enough (listing pages fill up to it). */
  minPerDay: 3,
  /** Of one kind in a day while other kinds are left. */
  perKind: 2,
  wildcardEpsilon: 0.2,
  /** A wildcard's kind is one he rarely goes to. */
  wildcardMaxShare: 0.15,
  outcome: { going: 1, clicked: 0.5, notForMe: 1, passed: 0.25 },
} as const;

export interface Candidate {
  /** Stable within a run (the pick row id). */
  id: string;
  date: string;
  category: TicketCategory;
  performers: string[];
  genres: string[];
  venue: string;
  venueKey: string;
  title: string;
  linkKind: LinkKind | null;
  /** Where it came from (default 'web'). */
  source?: PickSource;
}

export type PickSource = 'web' | 'newsletter' | 'calendar';

export interface ScoreParts {
  taste: number;
  kind: number;
  learned: number;
  link: number;
  score: number;
}

/** Past picks with an answer, for learning. */
export interface PickOutcome {
  category: string;
  genres: string[];
  performers: string[];
  venueKey: string;
  status: 'going' | 'not_for_me' | 'passed' | 'picked';
  clicks: number;
  source?: PickSource;
  /** 'busy' = the night passed while he had other plans (teaches nothing). */
  outcomeSource?: string | null;
}

export type Rng = () => number;

/** Beta counts per feature value ("c:club", "g:techno", "v:<venue key>", "p:<performer key>", "s:newsletter"). */
export type Learned = Map<string, { yes: number; no: number }>;

export const featureKeys = (f: Pick<EventFeatures, 'category' | 'genres' | 'performers' | 'venueKey'>, source?: PickSource): string[] => [
  ...(f.category ? [`c:${f.category}`] : []),
  ...f.genres.map((g) => `g:${g}`),
  ...(f.venueKey ? [`v:${f.venueKey}`] : []),
  ...f.performers.map((p) => `p:${p}`),
  ...(source ? [`s:${source}`] : []),
];

export function learnFrom(outcomes: readonly PickOutcome[]): Learned {
  const m: Learned = new Map();
  for (const o of outcomes) {
    let yes = 0;
    let no = 0;
    if (o.status === 'going') yes = PICK.outcome.going;
    else if (o.status === 'not_for_me') no = PICK.outcome.notForMe;
    else if (o.clicks > 0) yes = PICK.outcome.clicked;
    else if (o.status === 'passed' && o.outcomeSource !== 'busy') no = PICK.outcome.passed;
    if (!yes && !no) continue;
    const f = features({ category: o.category, genres: o.genres, performers: o.performers, venueKey: o.venueKey });
    for (const k of featureKeys(f, o.source ?? 'web')) {
      const cur = m.get(k) ?? { yes: 0, no: 0 };
      cur.yes += yes;
      cur.no += no;
      m.set(k, cur);
    }
  }
  return m;
}

/** A Beta(a, b) draw (Marsaglia–Tsang gamma ratio); a, b ≥ 1 here. */
export function betaSample(a: number, b: number, rng: Rng): number {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

function gammaSample(k: number, rng: Rng): number {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) {
    let x: number;
    let v: number;
    do {
      // Box–Muller normal
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

export function candidateFeatures(c: Candidate): EventFeatures {
  return features({ category: c.category, performers: c.performers, genres: c.genres, venue: c.venue, venueKey: c.venueKey, titles: [c.title] });
}

export function scoreCandidate(c: Candidate, profile: TasteProfile, learned: Learned, rng: Rng, idf?: ReadonlyMap<string, number>): ScoreParts {
  const f = candidateFeatures(c);
  const maxW = profile.happenings.reduce((m, h) => Math.max(m, h.weight), 0);
  const sims = maxW > 0 ? profile.happenings.map((h) => similarity(f, h.features, idf) * (h.weight / maxW)).sort((a, b) => b - a) : [];
  const best = sims.slice(0, 3);
  const taste = best.length ? best.reduce((a, b) => a + b, 0) / 3 : 0;
  const topShare = Math.max(0, ...profile.categoryShare.values());
  const kind = topShare > 0 ? (profile.categoryShare.get(c.category) ?? 0) / topShare : 0.5;
  const keys = featureKeys(f, c.source ?? 'web');
  const draws = keys.map((k) => {
    const n = learned.get(k);
    return n ? betaSample(1 + n.yes, 1 + n.no, rng) : 0.5;
  });
  const learnedScore = draws.length ? draws.reduce((a, b) => a + b, 0) / draws.length : 0.5;
  const link = c.linkKind ? PICK.linkScore[c.linkKind] : 0;
  const w = PICK.weights;
  const score = w.taste * taste + w.kind * kind + w.learned * learnedScore + w.link * link;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { taste: r3(taste), kind: r3(kind), learned: r3(learnedScore), link: r3(link), score: r3(score) };
}

export interface Scored<C extends Candidate = Candidate> {
  c: C;
  parts: ScoreParts;
}

export interface Chosen<C extends Candidate = Candidate> extends Scored<C> {
  wildcard: boolean;
}

const buyable = (c: Candidate) => c.linkKind === 'ticket' || c.linkKind === 'resale';

/**
 * Each free day's picks (see the header), in send order (by date, then score). `taken` = slots a day already has
 * (its Recurring Events listings).
 */
export function choosePerDay<C extends Candidate>(
  scored: readonly Scored<C>[],
  perDay: number,
  profile: TasteProfile,
  rng: Rng,
  taken: ReadonlyMap<string, number> = new Map(),
): Chosen<C>[] {
  const byScore = [...scored].sort((a, b) => b.parts.score - a.parts.score || a.c.date.localeCompare(b.c.date) || a.c.id.localeCompare(b.c.id));
  const dates = [...new Set(byScore.map((s) => s.c.date))].sort();
  const chosen: Chosen<C>[] = [];
  for (const date of dates) {
    const already = taken.get(date) ?? 0;
    const room = perDay - already;
    if (room <= 0) continue;
    const pool = byScore.filter((s) => s.c.date === date);
    const day: Chosen<C>[] = [];
    const take = (ok: (c: C) => boolean, strict: boolean, upTo: number) => {
      for (const s of pool) {
        if (day.length >= upTo) return;
        if (!ok(s.c) || day.some((x) => x.c.id === s.c.id)) continue;
        if (strict && day.filter((x) => x.c.category === s.c.category).length >= PICK.perKind) continue;
        day.push({ ...s, wildcard: false });
      }
    };
    take(buyable, true, room);
    take(buyable, false, room);
    // A listing page only to reach the day's minimum.
    const floor = Math.min(room, Math.max(0, PICK.minPerDay - already));
    take((c) => c.linkKind !== null, true, floor);
    take((c) => c.linkKind !== null, false, floor);
    chosen.push(...day);
  }
  if (rng() < PICK.wildcardEpsilon) {
    const rare = byScore.find(
      (s) =>
        !chosen.some((x) => x.c.id === s.c.id) &&
        s.c.linkKind !== null &&
        s.c.category !== 'other' &&
        (profile.categoryShare.get(s.c.category) ?? 0) < PICK.wildcardMaxShare &&
        perDay - (taken.get(s.c.date) ?? 0) > 0,
    );
    if (rare) {
      const sameDay = chosen.filter((x) => x.c.date === rare.c.date);
      if (sameDay.length + (taken.get(rare.c.date) ?? 0) >= perDay) {
        const weakest = sameDay.reduce((a, b) => (b.parts.score < a.parts.score ? b : a));
        chosen.splice(chosen.indexOf(weakest), 1);
      }
      chosen.push({ ...rare, wildcard: true });
    }
  }
  return chosen.sort((a, b) => a.c.date.localeCompare(b.c.date) || b.parts.score - a.parts.score);
}

/** A seeded PRNG (mulberry32), so a run's draws are reproducible from its seed. */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
