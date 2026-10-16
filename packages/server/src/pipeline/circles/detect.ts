/**
 * Community detection for auto circles (intelligence §5 "Circles", PLAN "Circles and intros"):
 *   graph       visible people; an edge where co_group + co_attend + family/partner/roommate labels give
 *               strength_c = 1 − e^(−W_c/2) ≥ 0.2 (no mention-only or coworker edges)
 *   detection   one seeded Louvain run (graphology-communities-louvain, resolution 1.0); communities over 60 are
 *               re-run on their subgraph at γ = 1.5; sizes 3–60 are kept
 *   membership  core = the community; soft = anyone else with ≥ 40% of their circle-graph weight inside it. A
 *               member's score is the share of their weight that goes into the circle.
 * Deterministic for a given graph: nodes and edges are added in sorted order and the RNG is seeded.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { PairAgg } from '../graph/aggregate';
import { strengthOf } from '../graph/weights';

export const MIN_EDGE_STRENGTH = 0.2;
export const MIN_SIZE = 3;
export const MAX_SIZE = 60;
export const SOFT_SHARE = 0.4;
/** Below SOFT_SHARE but at least this: "Suggested additions". */
export const NEAR_SHARE = 0.25;
const SPLIT_RESOLUTION = 1.5;
export const DETECT_SEED = 20_261_014;

/** mulberry32: a small seeded PRNG in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Circle-graph weight of an aggregated pair. */
export function circleWeight(p: PairAgg): number {
  return (p.byType.co_group?.w ?? 0) + (p.byType.co_attend?.w ?? 0) + Math.min(5, p.closeLabelW);
}

export interface CircleGraph {
  /** node → neighbor → strength_c */
  adj: Map<string, Map<string, number>>;
}

export function buildCircleGraph(pairs: Iterable<PairAgg>, visible: ReadonlySet<string>): CircleGraph {
  const adj = new Map<string, Map<string, number>>();
  const link = (x: string, y: string, w: number) => {
    let m = adj.get(x);
    if (!m) adj.set(x, (m = new Map()));
    m.set(y, w);
  };
  for (const p of pairs) {
    if (!visible.has(p.a) || !visible.has(p.b)) continue;
    const s = strengthOf(circleWeight(p));
    if (s < MIN_EDGE_STRENGTH) continue;
    link(p.a, p.b, s);
    link(p.b, p.a, s);
  }
  return { adj };
}

function toGraphology(g: CircleGraph, nodes: readonly string[]): Graph {
  const graph = new Graph({ type: 'undirected' });
  const inSet = new Set(nodes);
  for (const n of nodes) graph.addNode(n);
  for (const n of nodes) {
    const nb = g.adj.get(n);
    if (!nb) continue;
    for (const [m, w] of [...nb].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (n < m && inSet.has(m)) graph.addUndirectedEdge(n, m, { weight: w });
    }
  }
  return graph;
}

function partition(g: CircleGraph, nodes: readonly string[], resolution: number, rng: () => number): { groups: string[][]; modularity: number } {
  const graph = toGraphology(g, nodes);
  if (graph.size === 0) return { groups: [], modularity: 0 };
  const out = louvain.detailed(graph, { resolution, rng, getEdgeWeight: 'weight' });
  const byCommunity = new Map<number, string[]>();
  for (const n of [...nodes].sort()) {
    if (graph.degree(n) === 0) continue;
    const c = out.communities[n]!;
    let list = byCommunity.get(c);
    if (!list) byCommunity.set(c, (list = []));
    list.push(n);
  }
  return { groups: [...byCommunity.values()], modularity: out.modularity };
}

export interface Community {
  /** Sorted core member ids. */
  core: string[];
  /** Every member (core + soft) → share of their circle-graph weight inside the community. */
  scores: Map<string, number>;
  /** Not members, but NEAR_SHARE ≤ share < SOFT_SHARE. */
  near: Map<string, number>;
}

export interface Detection {
  communities: Community[];
  modularity: number;
  nodes: number;
  edges: number;
}

export function detectCommunities(g: CircleGraph, seed = DETECT_SEED): Detection {
  const rng = seededRng(seed);
  const nodes = [...g.adj.keys()].sort();
  let edges = 0;
  for (const nb of g.adj.values()) edges += nb.size;
  edges /= 2;
  const first = partition(g, nodes, 1.0, rng);
  const groups: string[][] = [];
  for (const c of first.groups) {
    if (c.length <= MAX_SIZE) {
      groups.push(c);
      continue;
    }
    for (const sub of partition(g, c, SPLIT_RESOLUTION, rng).groups) if (sub.length <= MAX_SIZE) groups.push(sub);
  }
  const kept = groups.filter((c) => c.length >= MIN_SIZE).map((c) => [...c].sort());
  kept.sort((x, y) => (x[0]! < y[0]! ? -1 : 1));

  // shares: weight into each community / total weight
  const total = new Map<string, number>();
  for (const [n, nb] of g.adj) total.set(n, [...nb.values()].reduce((s, w) => s + w, 0));
  const communities: Community[] = kept.map((core) => {
    const set = new Set(core);
    const into = new Map<string, number>();
    for (const m of core) {
      for (const [n, w] of g.adj.get(m) ?? []) if (n !== m) into.set(n, (into.get(n) ?? 0) + w);
    }
    const scores = new Map<string, number>();
    const near = new Map<string, number>();
    for (const [n, w] of into) {
      const share = Math.round((w / (total.get(n) || 1)) * 1000) / 1000;
      if (set.has(n)) scores.set(n, share);
      else if (share >= SOFT_SHARE) scores.set(n, share);
      else if (share >= NEAR_SHARE) near.set(n, share);
    }
    for (const m of core) if (!scores.has(m)) scores.set(m, 0);
    return { core, scores, near };
  });
  return { communities, modularity: first.modularity, nodes: nodes.length, edges };
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Greedy one-to-one matching of new sets to old ones by descending Jaccard (≥ threshold). */
export function greedyMatch<K>(fresh: readonly ReadonlySet<string>[], old: readonly { key: K; members: ReadonlySet<string> }[], threshold: number): Map<number, { key: K; jaccard: number }> {
  const cands: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < fresh.length; i++) {
    for (let j = 0; j < old.length; j++) {
      const s = jaccard(fresh[i]!, old[j]!.members);
      if (s >= threshold) cands.push({ i, j, s });
    }
  }
  cands.sort((x, y) => y.s - x.s || x.i - y.i || x.j - y.j);
  const out = new Map<number, { key: K; jaccard: number }>();
  const used = new Set<number>();
  for (const c of cands) {
    if (out.has(c.i) || used.has(c.j)) continue;
    out.set(c.i, { key: old[c.j]!.key, jaccard: c.s });
    used.add(c.j);
  }
  return out;
}
