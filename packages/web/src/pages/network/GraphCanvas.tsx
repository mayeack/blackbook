import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import type { NetworkGraph } from '@yb/shared';
import { LayoutClient } from './layoutClient';
import {
  circleColors,
  edgeColor,
  edgeSize,
  labelDegreeCutoff,
  labelMode,
  layoutIterations,
  neighborIds,
  nodeSize,
  isZoomedOut,
  seedPositions,
  SIGMA_SETTINGS,
  type Pos,
} from './logic';

interface NodeAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  degree: number;
  isMe: boolean;
}
interface EdgeAttrs {
  size: number;
  color: string;
  weight: number;
}

interface Theme {
  label: string;
  dim: string;
  dimEdge: string;
  me: string;
  none: string;
  backdrop: string;
  accent: string;
}

function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    label: v('--text-primary', '#12110d'),
    dim: v('--surface-hover', '#ece9e0'),
    dimEdge: v('--border', 'rgba(18,17,13,0.12)'),
    me: v('--accent', '#d9a62a'),
    none: v('--state-dormant', '#8a877e'),
    backdrop: v('--surface-raised', '#ffffff'),
    accent: v('--accent', '#d9a62a'),
  };
}

export interface GraphCanvasHandle {
  focus: (id: string) => void;
}

/**
 * The sigma (WebGL) canvas. One Sigma instance for the component's life; data changes rebuild the graphology
 * graph in place, keep known positions, and re-run ForceAtlas2 in the worker. Selection dims everything but the
 * node and its neighbors; labels follow the zoom (high-degree only when zoomed out).
 */
export function GraphCanvas({
  data,
  selected,
  onSelect,
  focusRequest,
  onFailed,
}: {
  data: NetworkGraph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Bumping the nonce re-focuses the camera on `id`. */
  focusRequest: { id: string; nonce: number } | null;
  onFailed: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const graphRef = useRef<Graph<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutRef = useRef<LayoutClient | null>(null);
  const positions = useRef(new Map<string, Pos>());
  const state = useRef({ selected: null as string | null, neighbors: new Set<string>(), cutoff: Infinity, zoomedOut: true, theme: null as Theme | null });
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [settling, setSettling] = useState(false);
  const firstFit = useRef(true);

  // Mount: graph + renderer + layout worker.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const graph = new Graph<NodeAttrs, EdgeAttrs>({ type: 'undirected', multi: false, allowSelfLoops: false });
    state.current.theme = readTheme();
    let sigma: Sigma<NodeAttrs, EdgeAttrs>;
    try {
      sigma = new Sigma<NodeAttrs, EdgeAttrs>(graph, el, {
        settings: SIGMA_SETTINGS,
        nodeReducer: (node, _data, attrs) => {
          const s = state.current;
          const t = s.theme!;
          const sel = s.selected;
          const focused = sel === node;
          const nb = sel !== null && s.neighbors.has(node);
          const dimmed = sel !== null && !focused && !nb;
          const mode = labelMode({ degree: attrs.degree, cutoff: s.cutoff, zoomedOut: s.zoomedOut, focused, neighborOfFocus: nb });
          return {
            color: dimmed ? t.dim : attrs.color,
            size: focused ? attrs.size * 1.35 : attrs.size,
            label: dimmed ? '' : attrs.label,
            labelVisibility: dimmed ? 'hidden' : mode,
            labelColor: t.label,
            zIndex: focused ? 3 : nb ? 2 : dimmed ? 0 : 1,
            backdropColor: t.backdrop,
            backdropShadowColor: 'rgba(0,0,0,0.35)',
            cursor: 'pointer',
          };
        },
        edgeReducer: (edge, _data, attrs) => {
          const s = state.current;
          if (s.selected === null) return { color: attrs.color, size: attrs.size };
          const g = graphRef.current;
          const touches = !!g && g.hasEdge(edge) && (g.source(edge) === s.selected || g.target(edge) === s.selected);
          return touches ? { color: attrs.color, size: attrs.size * 1.6, zIndex: 2 } : { color: s.theme!.dimEdge, size: Math.max(0.3, attrs.size * 0.5), zIndex: 0 };
        },
      });
    } catch {
      onFailed();
      return;
    }
    graphRef.current = graph;
    sigmaRef.current = sigma;
    layoutRef.current = new LayoutClient();

    sigma.on('clickNode', ({ node }) => onSelectRef.current(node));
    sigma.on('clickStage', () => onSelectRef.current(null));

    const camera = sigma.getCamera();
    const onCamera = (st: { ratio: number }) => {
      const out = isZoomedOut(st.ratio);
      if (out !== state.current.zoomedOut) {
        state.current.zoomedOut = out;
        sigma.refresh();
      }
    };
    camera.on('updated', onCamera);

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onScheme = () => {
      state.current.theme = readTheme();
      sigma.refresh();
    };
    media?.addEventListener?.('change', onScheme);

    return () => {
      media?.removeEventListener?.('change', onScheme);
      camera.removeListener('updated', onCamera);
      layoutRef.current?.dispose();
      layoutRef.current = null;
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
    // Mount-only: onFailed is read once (a failed renderer never comes back).
  }, []);

  // Data: rebuild nodes/edges, seed positions, start the layout.
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    const layout = layoutRef.current;
    if (!graph || !sigma || !layout) return;
    const theme = state.current.theme ?? readTheme();
    const colors = circleColors(data.circles);
    const seeded = seedPositions(
      data.nodes,
      data.edges,
      data.circles.map((c) => c.id),
      positions.current,
    );
    graph.clear();
    for (const n of data.nodes) {
      const p = seeded.get(n.id) ?? { x: 0, y: 0 };
      graph.addNode(n.id, {
        x: p.x,
        y: p.y,
        size: n.isMe ? 9 : nodeSize(n.tieStrength),
        color: n.isMe ? theme.me : n.primaryCircleId ? (colors.get(n.primaryCircleId) ?? theme.none) : theme.none,
        label: n.label,
        degree: n.degree,
        isMe: n.isMe,
      });
    }
    for (const e of data.edges) {
      if (e.a === e.b || !graph.hasNode(e.a) || !graph.hasNode(e.b) || graph.hasEdge(e.a, e.b)) continue;
      graph.addEdge(e.a, e.b, { size: edgeSize(e.strength), color: edgeColor(e.dominantType), weight: e.strength });
    }
    state.current.cutoff = labelDegreeCutoff(data.nodes);
    sigma.refresh();
    if (firstFit.current) {
      firstFit.current = false;
      void sigma.getCamera().reset({ duration: 0 });
    }

    const ids = data.nodes.map((n) => n.id);
    const fresh = ids.filter((id) => !positions.current.has(id)).length;
    // Mostly-known positions only need a short settle.
    const iterations = fresh / Math.max(1, ids.length) < 0.2 ? Math.ceil(layoutIterations(ids.length) / 4) : layoutIterations(ids.length);
    if (ids.length < 2) {
      for (const [id, p] of seeded) positions.current.set(id, p);
      return;
    }
    setSettling(true);
    layout.start(
      {
        nodes: data.nodes.map((n) => ({ id: n.id, ...(seeded.get(n.id) ?? { x: 0, y: 0 }), size: nodeSize(n.tieStrength) })),
        edges: data.edges.map((e) => ({ a: e.a, b: e.b, weight: e.strength })),
      },
      iterations,
      (pos, done) => {
        const g = graphRef.current;
        if (!g) return;
        const updated = new Map<string, Pos>();
        ids.forEach((id, i) => updated.set(id, { x: pos[2 * i]!, y: pos[2 * i + 1]! }));
        g.updateEachNodeAttributes(
          (node, attrs) => {
            const p = updated.get(node);
            return p ? { ...attrs, x: p.x, y: p.y } : attrs;
          },
          { attributes: ['x', 'y'] },
        );
        for (const [id, p] of updated) positions.current.set(id, p);
        if (done) setSettling(false);
      },
    );
  }, [data]);

  // Selection → dim others, highlight neighbors.
  useEffect(() => {
    state.current.selected = selected;
    state.current.neighbors = selected ? neighborIds(data.edges, selected) : new Set();
    sigmaRef.current?.refresh();
  }, [selected, data]);

  // Search focus → move the camera there.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!focusRequest || !sigma) return;
    const d = sigma.getNodeDisplayData(focusRequest.id);
    if (!d) return;
    void sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.25 }, { duration: 450 });
  }, [focusRequest]);

  return (
    <div className="net-canvas-wrap">
      <div ref={container} className="net-canvas" role="img" aria-label="Network map. Use the list view for an accessible version." />
      {settling && <span className="net-settling caption">Arranging…</span>}
      <div className="net-zoom">
        <button type="button" className="btn btn-sm" aria-label="Zoom in" onClick={() => void sigmaRef.current?.getCamera().zoomIn({ duration: 200 })}>
          +
        </button>
        <button type="button" className="btn btn-sm" aria-label="Zoom out" onClick={() => void sigmaRef.current?.getCamera().zoomOut({ duration: 200 })}>
          −
        </button>
        <button type="button" className="btn btn-sm" aria-label="Fit the whole map" onClick={() => void sigmaRef.current?.getCamera().reset({ duration: 300 })}>
          ⤢
        </button>
      </div>
    </div>
  );
}
