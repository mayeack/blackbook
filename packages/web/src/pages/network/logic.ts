/**
 * Network graph helpers (pure; unit-tested): URL ⇄ filters ⇄ API query, node/edge styling, label rules, seeding
 * positions so the layout starts from circle clusters, and search.
 */
import type { NetworkCircle, NetworkEdge, NetworkGraph, NetworkNode, NetworkWindow } from '@yb/shared';

export interface NetworkFilters {
  circle: string | null;
  /** Edge evidence types to keep (empty = all). */
  types: string[];
  minStrength: number;
  window: NetworkWindow;
  includeMe: boolean;
}

export const DEFAULT_FILTERS: NetworkFilters = { circle: null, types: [], minStrength: 0.15, window: '1y', includeMe: false };

export const STRENGTH_STEPS = [0.15, 0.25, 0.4, 0.6, 0.75] as const;
export const WINDOWS: { value: NetworkWindow; label: string }[] = [
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'all', label: 'All time' },
];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** URL (`?circle=&types=a,b&min=0.4&win=90d&me=1`) → filters; anything malformed falls back to the default. */
export function parseFilters(p: URLSearchParams): NetworkFilters {
  const min = Number(p.get('min'));
  const win = p.get('win');
  return {
    circle: p.get('circle') || null,
    types: (p.get('types') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[a-z_]{1,40}$/.test(s)),
    minStrength: p.has('min') && Number.isFinite(min) ? clamp01(min) : DEFAULT_FILTERS.minStrength,
    window: win === '90d' || win === '1y' || win === 'all' ? win : DEFAULT_FILTERS.window,
    includeMe: p.get('me') === '1',
  };
}

/** Filters → URL params (defaults omitted so a plain /network stays clean). */
export function filtersToParams(f: NetworkFilters, base?: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
  set('circle', f.circle);
  set('types', f.types.length ? [...f.types].sort().join(',') : null);
  set('min', f.minStrength === DEFAULT_FILTERS.minStrength ? null : String(f.minStrength));
  set('win', f.window === DEFAULT_FILTERS.window ? null : f.window);
  set('me', f.includeMe ? '1' : null);
  return p;
}

/** Filters → the /network query string. */
export function networkQuery(f: NetworkFilters, limit = 1500): string {
  const p = new URLSearchParams();
  if (f.circle) p.set('circle', f.circle);
  if (f.types.length) p.set('types', [...f.types].sort().join(','));
  p.set('minStrength', String(f.minStrength));
  p.set('window', f.window);
  if (f.includeMe) p.set('includeMe', '1');
  p.set('limit', String(limit));
  return `?${p.toString()}`;
}

// ---------------------------------------------------------------------------------------------- styling

/** Fallback circle palette (light enough for dark mode, dark enough for light): used when a circle has no color. */
export const CIRCLE_PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#86bcb6', '#d37295', '#a0cbe8'];

const HEX = /^#[0-9a-f]{6}$/i;

/** circle id → color (its own, else a stable palette slot by list order). */
export function circleColors(circles: readonly NetworkCircle[]): Map<string, string> {
  const out = new Map<string, string>();
  circles.forEach((c, i) => out.set(c.id, c.color && HEX.test(c.color) ? c.color : CIRCLE_PALETTE[i % CIRCLE_PALETTE.length]!));
  return out;
}

/** Edge colors by dominant evidence type. */
const EDGE_COLORS: Record<string, string> = {
  co_group: '#5b8def',
  group_reply: '#5b8def',
  co_attend: '#a06ad9',
  invited_by: '#d9669b',
  plus_one: '#d9669b',
  co_host: '#d9669b',
  met_via: '#3fae9a',
  mentioned_together: '#8f8b80',
  label: '#d9a62a',
  tie: '#d9a62a',
};
export const edgeColor = (type: string | null) => (type && EDGE_COLORS[type]) || '#8f8b80';

/** Node radius (px at default zoom) from tie strength to me T (0–100). */
export const nodeSize = (t: number | null) => 3 + 11 * Math.sqrt(clamp01((t ?? 0) / 100));

/**
 * Renderer settings. nodeSize/edgeSize are pixels: sigma v4 defaults to sizing items in graph units
 * (itemSizesReference 'positions'), which turns a small graph into overlapping blobs and a big one into specks,
 * so sizes are pinned to the screen (and grow gently with zoom).
 */
export const SIGMA_SETTINGS = {
  renderEdgeLabels: false,
  labelDensity: 0.9,
  labelGridCellSize: 90,
  labelRenderedSizeThreshold: 0,
  minCameraRatio: 0.04,
  maxCameraRatio: 4,
  hideEdgesOnMove: false,
  allowInvalidContainer: true,
  itemSizesReference: 'screen' as const,
  zoomToSizeRatioFunction: Math.sqrt,
};
/** Edge thickness from pair strength (0–1). */
export const edgeSize = (s: number) => 0.4 + 2.6 * clamp01(s);

/**
 * Degree at or above which a node is "high degree" and keeps its label when zoomed out: the top ~8% of nodes, at
 * least degree 3 (small graphs label everyone with a few connections).
 */
export function labelDegreeCutoff(nodes: readonly Pick<NetworkNode, 'degree'>[]): number {
  if (!nodes.length) return Infinity;
  const degrees = nodes.map((n) => n.degree).sort((a, b) => b - a);
  if (nodes.length <= 40) return Math.max(1, Math.min(3, degrees[0] ?? 1));
  const idx = Math.max(0, Math.floor(nodes.length * 0.08) - 1);
  return Math.max(3, degrees[idx] ?? 3);
}

/** Camera ratio above which we're "zoomed out" (sigma: ratio 1 = fit, >1 = further out, <1 = closer). */
export const ZOOMED_OUT_RATIO = 0.55;

export type LabelMode = 'visible' | 'auto' | 'hidden';

/** Labels only for high-degree nodes when zoomed out; everyone (density-limited) when zoomed in; always for focus. */
export function labelMode(o: { degree: number; cutoff: number; zoomedOut: boolean; focused: boolean; neighborOfFocus: boolean }): LabelMode {
  if (o.focused) return 'visible';
  if (o.neighborOfFocus) return 'auto';
  if (o.zoomedOut) return o.degree >= o.cutoff ? 'auto' : 'hidden';
  return 'auto';
}

export const isZoomedOut = (ratio: number) => ratio > ZOOMED_OUT_RATIO;

// ---------------------------------------------------------------------------------------------- layout seeding

/** Small deterministic hash → [0, 1). */
export function hash01(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface Pos {
  x: number;
  y: number;
}

/**
 * Starting positions: known positions are kept (so a filter change doesn't scramble the map); new nodes start
 * around their primary circle's center (circles on a big ring), or near an already-placed neighbor, else on an
 * outer ring. Deterministic for a given input.
 */
export function seedPositions(
  nodes: readonly Pick<NetworkNode, 'id' | 'primaryCircleId'>[],
  edges: readonly Pick<NetworkEdge, 'a' | 'b'>[],
  circleOrder: readonly string[],
  previous: ReadonlyMap<string, Pos> = new Map(),
): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const n = Math.max(1, nodes.length);
  const spread = Math.sqrt(n) * 10;
  const centers = new Map<string, Pos>();
  circleOrder.forEach((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, circleOrder.length);
    centers.set(id, { x: Math.cos(a) * spread, y: Math.sin(a) * spread });
  });
  const neighbors = new Map<string, string[]>();
  for (const e of edges) {
    (neighbors.get(e.a) ?? neighbors.set(e.a, []).get(e.a)!).push(e.b);
    (neighbors.get(e.b) ?? neighbors.set(e.b, []).get(e.b)!).push(e.a);
  }
  for (const node of nodes) {
    const prev = previous.get(node.id);
    if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) out.set(node.id, { x: prev.x, y: prev.y });
  }
  const jitter = (id: string, r: number): Pos => {
    const a = hash01(id, 1) * 2 * Math.PI;
    const d = Math.sqrt(hash01(id, 2)) * r;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  };
  for (const node of nodes) {
    if (out.has(node.id)) continue;
    const center = node.primaryCircleId ? centers.get(node.primaryCircleId) : undefined;
    const placedNb = (neighbors.get(node.id) ?? []).map((id) => out.get(id)).find((p): p is Pos => !!p);
    const base = center ?? placedNb;
    const j = jitter(node.id, base ? spread * 0.35 : spread * 0.25);
    if (base) out.set(node.id, { x: base.x + j.x, y: base.y + j.y });
    else {
      const a = hash01(node.id, 3) * 2 * Math.PI;
      out.set(node.id, { x: Math.cos(a) * spread * 1.6 + j.x, y: Math.sin(a) * spread * 1.6 + j.y });
    }
  }
  return out;
}

/** FA2 iterations for a graph of this size (bigger graphs get fewer per node, the worker runs them in chunks). */
export const layoutIterations = (order: number) => (order <= 50 ? 400 : order <= 300 ? 300 : order <= 1000 ? 200 : 120);

// ---------------------------------------------------------------------------------------------- search

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();

/** Nodes whose label matches (word-prefix matches first, then substring), best connected first. */
export function searchNodes(nodes: readonly NetworkNode[], q: string, limit = 8): NetworkNode[] {
  const s = norm(q.trim());
  if (!s) return [];
  const scored: { n: NetworkNode; score: number }[] = [];
  for (const n of nodes) {
    if (n.isMe) continue;
    const label = norm(n.label);
    if (!label.includes(s)) continue;
    const prefix = label.startsWith(s) ? 2 : label.split(/\s+/).some((w) => w.startsWith(s)) ? 1 : 0;
    scored.push({ n, score: prefix });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.n.degree - a.n.degree || a.n.label.localeCompare(b.n.label))
    .slice(0, limit)
    .map((x) => x.n);
}

/** Neighbor ids of a node in the current edge set. */
export function neighborIds(edges: readonly Pick<NetworkEdge, 'a' | 'b'>[], id: string): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.a === id) out.add(e.b);
    else if (e.b === id) out.add(e.a);
  }
  return out;
}

/** Strongest connections of a node (for the bottom sheet). */
export function topNeighbors(g: Pick<NetworkGraph, 'nodes' | 'edges'>, id: string, limit = 5): { node: NetworkNode; strength: number }[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges
    .filter((e) => e.a === id || e.b === id)
    .map((e) => ({ node: byId.get(e.a === id ? e.b : e.a)!, strength: e.strength }))
    .filter((x) => x.node && !x.node.isMe)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

/** Readable edge-type chip labels. */
const TYPE_LABELS: Record<string, string> = {
  co_group: 'Group chats',
  group_reply: 'Group replies',
  co_attend: 'Events',
  invited_by: 'Invites',
  plus_one: 'Plus-ones',
  co_host: 'Co-hosts',
  met_via: 'Met via',
  mentioned_together: 'Mentions',
  label: 'Relationships',
  tie: 'Your ties',
};
export const edgeTypeChip = (t: string) => TYPE_LABELS[t] ?? t.replace(/_/g, ' ');
