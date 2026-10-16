/**
 * ForceAtlas2 layout, run in chunks. Shared by the layout web worker (layout.worker.ts) and the main-thread
 * fallback; pure enough to unit-test in node.
 *
 * Why our own worker and not graphology-layout-forceatlas2/worker: that supervisor spawns its worker from a
 * blob: URL, which the app's CSP (`worker-src 'self'`) blocks. A same-origin module worker needs no CSP change.
 */
import Graph from 'graphology';
import forceAtlas2, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2';

export interface LayoutInput {
  /** Node order defines the order of the positions array. */
  nodes: { id: string; x: number; y: number; size: number }[];
  edges: { a: string; b: string; weight: number }[];
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

export function layoutSettings(order: number): ForceAtlas2Settings {
  return {
    ...forceAtlas2.inferSettings(order),
    barnesHutOptimize: order > 400,
    edgeWeightInfluence: 1,
    adjustSizes: false,
  };
}

export class LayoutRunner {
  private readonly graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  private readonly ids: string[];
  private readonly settings: ForceAtlas2Settings;

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
  }

  get order(): number {
    return this.graph.order;
  }

  /** Runs `iterations` FA2 iterations and returns the positions (input node order). */
  step(iterations: number): Float32Array {
    if (this.graph.order > 1 && iterations > 0) forceAtlas2.assign(this.graph, { iterations, settings: this.settings, getEdgeWeight: 'weight' });
    return this.positions();
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
