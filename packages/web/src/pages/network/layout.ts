/**
 * ForceAtlas2 layout, run in chunks. Shared by the layout web worker (layout.worker.ts) and the main-thread
 * fallback; pure enough to unit-test in node.
 *
 * LinLog mode keeps friend groups as separate clusters instead of one hairball; the last chunk then pushes apart
 * any two people closer than their dots plus a small gap, measured in screen pixels at the "fit" zoom (the
 * canvas size comes with the input), so everyone is a separate, tappable dot.
 *
 * Why our own worker and not graphology-layout-forceatlas2/worker: that supervisor spawns its worker from a
 * blob: URL, which the app's CSP (`worker-src 'self'`) blocks. A same-origin module worker needs no CSP change.
 */
import Graph from 'graphology';
import forceAtlas2, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2';

export interface LayoutInput {
  /** Node order defines the order of the positions array; size is the dot radius in screen pixels. */
  nodes: { id: string; x: number; y: number; size: number }[];
  edges: { a: string; b: string; weight: number }[];
  /** Canvas size in pixels (default 760×760). */
  viewport?: { width: number; height: number };
}

/** main → worker */
export type LayoutRequest = { type: 'start'; job: number; input: LayoutInput; iterations: number } | { type: 'stop' };

/** worker → main: positions as [x0, y0, x1, y1, …] in input node order. */
export interface LayoutProgress {
  type: 'positions';
  job: number;
  positions: Float32Array;
  done: boolean;
}

/** Iterations per chunk: small enough that a stop message (or the UI on the fallback path) is handled promptly. */
export const CHUNK = 20;

/**
 * Minimum on-screen gap between two dots (px), sigma's stage padding, and the canvas size when none is given.
 * Dots are spaced for a canvas of at least MIN_VIEWPORT a side: packing a few hundred people into a phone-sized
 * square would erase the clusters, so a phone keeps the desktop map's shape and a light pinch-zoom separates the
 * dots (distances grow with the zoom, dot sizes only with its square root).
 */
export const DOT_GAP = 3;
const STAGE_PADDING = 30;
const DEFAULT_VIEWPORT = { width: 760, height: 760 };
export const MIN_VIEWPORT = 600;
const SEPARATE_ROUNDS = 80;

export function layoutSettings(order: number): ForceAtlas2Settings {
  return {
    ...forceAtlas2.inferSettings(order),
    barnesHutOptimize: order > 400,
    linLogMode: true,
    edgeWeightInfluence: 1,
    adjustSizes: false,
  };
}

/**
 * Pushes overlapping dots apart in place until every pair is at least r1 + r2 + gap pixels apart at the zoom that
 * fits the whole layout in the viewport (sigma's fit: same scale on both axes, padding on every side). Spreading
 * the layout shrinks that scale, so the target distance is re-measured every round. Pairs come from a grid, so a
 * round is about linear in the number of dots.
 */
export function separateDots(
  xs: Float64Array,
  ys: Float64Array,
  radii: readonly number[],
  viewport: { width: number; height: number },
  gap = DOT_GAP,
  rounds = SEPARATE_ROUNDS,
): void {
  const n = xs.length;
  if (n < 2) return;
  const maxR = Math.max(...radii);
  const w = Math.max(1, viewport.width - 2 * STAGE_PADDING);
  const h = Math.max(1, viewport.height - 2 * STAGE_PADDING);
  for (let round = 0; round < rounds; round++) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, xs[i]!);
      maxX = Math.max(maxX, xs[i]!);
      minY = Math.min(minY, ys[i]!);
      maxY = Math.max(maxY, ys[i]!);
    }
    // px per layout unit
    const scale = Math.min(w / Math.max(1e-9, maxX - minX), h / Math.max(1e-9, maxY - minY));
    const cell = (2 * maxR + gap) / scale;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(xs[i]! / cell)},${Math.floor(ys[i]! / cell)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xs[i]! / cell);
      const cy = Math.floor(ys[i]! / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i) continue;
            const min = (radii[i]! + radii[j]! + gap) / scale;
            let vx = xs[j]! - xs[i]!;
            let vy = ys[j]! - ys[i]!;
            const d = Math.hypot(vx, vy);
            if (d >= min) continue;
            if (d < 1e-9) {
              // Same spot: split along a direction fixed by the pair, so the result is deterministic.
              const a = ((i * 7919 + j * 104729) % 360) * (Math.PI / 180);
              vx = Math.cos(a);
              vy = Math.sin(a);
            } else {
              vx /= d;
              vy /= d;
            }
            const push = ((min - d) / 2) * 1.02;
            xs[i] = xs[i]! - vx * push;
            ys[i] = ys[i]! - vy * push;
            xs[j] = xs[j]! + vx * push;
            ys[j] = ys[j]! + vy * push;
            moved = true;
          }
        }
      }
    }
    if (!moved) return;
  }
}

export class LayoutRunner {
  private readonly graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  private readonly ids: string[];
  private readonly settings: ForceAtlas2Settings;
  private readonly viewport: { width: number; height: number };

  constructor(input: LayoutInput) {
    this.ids = input.nodes.map((n) => n.id);
    for (const n of input.nodes) {
      if (this.graph.hasNode(n.id)) continue;
      this.graph.addNode(n.id, { x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0, size: n.size });
    }
    for (const e of input.edges) {
      if (e.a === e.b || !this.graph.hasNode(e.a) || !this.graph.hasNode(e.b)) continue;
      this.graph.mergeEdge(e.a, e.b, { weight: Math.max(0.01, e.weight) });
    }
    this.settings = layoutSettings(this.graph.order);
    const v = input.viewport && input.viewport.width > 0 && input.viewport.height > 0 ? input.viewport : DEFAULT_VIEWPORT;
    this.viewport = { width: Math.max(MIN_VIEWPORT, v.width), height: Math.max(MIN_VIEWPORT, v.height) };
  }

  get order(): number {
    return this.graph.order;
  }

  /** Runs `iterations` FA2 iterations (the `last` chunk then separates overlapping dots) and returns the positions. */
  step(iterations: number, last = false): Float32Array {
    if (this.graph.order > 1 && iterations > 0) forceAtlas2.assign(this.graph, { iterations, settings: this.settings, getEdgeWeight: 'weight' });
    if (last) this.separate();
    return this.positions();
  }

  private separate(): void {
    const nodes = this.graph.nodes();
    const xs = new Float64Array(nodes.length);
    const ys = new Float64Array(nodes.length);
    const radii: number[] = [];
    nodes.forEach((id, i) => {
      const a = this.graph.getNodeAttributes(id);
      xs[i] = Number.isFinite(a.x) ? a.x : 0;
      ys[i] = Number.isFinite(a.y) ? a.y : 0;
      radii.push(Number.isFinite(a.size) ? a.size : 3);
    });
    separateDots(xs, ys, radii, this.viewport);
    nodes.forEach((id, i) => this.graph.mergeNodeAttributes(id, { x: xs[i], y: ys[i] }));
  }

  positions(): Float32Array {
    const out = new Float32Array(this.ids.length * 2);
    this.ids.forEach((id, i) => {
      const a = this.graph.hasNode(id) ? this.graph.getNodeAttributes(id) : { x: 0, y: 0 };
      out[2 * i] = Number.isFinite(a.x) ? a.x : 0;
      out[2 * i + 1] = Number.isFinite(a.y) ? a.y : 0;
    });
    return out;
  }
}
