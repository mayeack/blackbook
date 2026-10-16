import { describe, expect, it } from 'vitest';
import type { NetworkGraph, NetworkNode } from '@yb/shared';
import { LayoutRunner } from '../src/pages/network/layout';
import {
  CIRCLE_PALETTE,
  DEFAULT_FILTERS,
  circleColors,
  edgeColor,
  filtersToParams,
  isZoomedOut,
  labelDegreeCutoff,
  labelMode,
  layoutIterations,
  neighborIds,
  networkQuery,
  nodeSize,
  parseFilters,
  searchNodes,
  seedPositions,
  SIGMA_SETTINGS,
  topNeighbors,
} from '../src/pages/network/logic';

const node = (id: string, label: string, o: Partial<NetworkNode> = {}): NetworkNode => ({
  id,
  label,
  firstName: label.split(' ')[0] ?? null,
  tieStrength: 50,
  state: 'steady',
  circleIds: [],
  primaryCircleId: null,
  degree: 1,
  isMe: false,
  x: null,
  y: null,
  ...o,
});

describe('network filters ⇄ URL ⇄ query', () => {
  it('defaults when the URL is empty or malformed', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(DEFAULT_FILTERS);
    const bad = parseFilters(new URLSearchParams('min=abc&win=5y&types=co_group,DROP TABLE,co_attend&me=yes'));
    expect(bad.minStrength).toBe(DEFAULT_FILTERS.minStrength);
    expect(bad.window).toBe('1y');
    expect(bad.types).toEqual(['co_group', 'co_attend']);
    expect(bad.includeMe).toBe(false);
  });

  it('round-trips and keeps unrelated params', () => {
    const f = { circle: 'c1', types: ['co_attend', 'co_group'], minStrength: 0.4, window: '90d' as const, includeMe: true };
    const p = filtersToParams(f, new URLSearchParams('view=list'));
    expect(p.get('view')).toBe('list');
    expect(p.get('types')).toBe('co_attend,co_group');
    expect(parseFilters(p)).toEqual({ ...f, types: ['co_attend', 'co_group'] });
    // defaults are omitted
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe('');
  });

  it('clamps strength into 0–1', () => {
    expect(parseFilters(new URLSearchParams('min=7')).minStrength).toBe(1);
    expect(parseFilters(new URLSearchParams('min=-1')).minStrength).toBe(0);
  });

  it('builds the API query (ME only when asked)', () => {
    expect(networkQuery(DEFAULT_FILTERS)).toBe('?minStrength=0.15&window=1y&limit=1500');
    expect(networkQuery({ circle: 'c 1', types: ['b', 'a'], minStrength: 0.25, window: 'all', includeMe: true }, 200)).toBe(
      '?circle=c+1&types=a%2Cb&minStrength=0.25&window=all&includeMe=1&limit=200',
    );
  });
});

describe('network styling', () => {
  it('uses a circle’s own color, else a stable palette slot', () => {
    const m = circleColors([
      { id: 'a', name: 'A', kind: 'auto', color: '#112233', icon: null, size: 3 },
      { id: 'b', name: 'B', kind: 'user', color: null, icon: null, size: 3 },
      { id: 'c', name: 'C', kind: 'user', color: 'red', icon: null, size: 3 },
    ]);
    expect(m.get('a')).toBe('#112233');
    expect(m.get('b')).toBe(CIRCLE_PALETTE[1]);
    expect(m.get('c')).toBe(CIRCLE_PALETTE[2]);
  });

  it('sizes nodes by tie strength and colors edges by type', () => {
    expect(nodeSize(null)).toBe(3);
    expect(nodeSize(100)).toBeCloseTo(14);
    expect(nodeSize(25)).toBeGreaterThan(nodeSize(5));
    expect(edgeColor('co_group')).not.toBe(edgeColor('co_attend'));
    expect(edgeColor(null)).toBe(edgeColor('something_new'));
  });

  it('labels only high-degree nodes when zoomed out, everyone zoomed in, always the focus', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ degree: i < 8 ? 20 : 1 }));
    const cutoff = labelDegreeCutoff(nodes);
    expect(cutoff).toBe(20);
    expect(labelMode({ degree: 20, cutoff, zoomedOut: true, focused: false, neighborOfFocus: false })).toBe('auto');
    expect(labelMode({ degree: 1, cutoff, zoomedOut: true, focused: false, neighborOfFocus: false })).toBe('hidden');
    expect(labelMode({ degree: 1, cutoff, zoomedOut: false, focused: false, neighborOfFocus: false })).toBe('auto');
    expect(labelMode({ degree: 1, cutoff, zoomedOut: true, focused: true, neighborOfFocus: false })).toBe('visible');
    expect(labelMode({ degree: 1, cutoff, zoomedOut: true, focused: false, neighborOfFocus: true })).toBe('auto');
    expect(isZoomedOut(1)).toBe(true);
    expect(isZoomedOut(0.2)).toBe(false);
    // small graphs label anyone with a few connections
    expect(labelDegreeCutoff([{ degree: 1 }, { degree: 5 }])).toBe(3);
    expect(labelDegreeCutoff([])).toBe(Infinity);
  });
});

describe('layout seeding', () => {
  const nodes = [node('a', 'A', { primaryCircleId: 'c1' }), node('b', 'B', { primaryCircleId: 'c1' }), node('c', 'C', { primaryCircleId: 'c2' }), node('d', 'D')];
  const edges = [{ a: 'a', b: 'b' }, { a: 'c', b: 'd' }];

  it('is deterministic and keeps known positions', () => {
    const one = seedPositions(nodes, edges, ['c1', 'c2']);
    const two = seedPositions(nodes, edges, ['c1', 'c2']);
    expect([...one]).toEqual([...two]);
    const kept = seedPositions(nodes, edges, ['c1', 'c2'], new Map([['a', { x: 999, y: -5 }]]));
    expect(kept.get('a')).toEqual({ x: 999, y: -5 });
    for (const p of kept.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('starts circle-mates near each other and an unclustered node near a placed neighbor', () => {
    const pos = seedPositions(nodes, edges, ['c1', 'c2']);
    const dist = (x: string, y: string) => Math.hypot(pos.get(x)!.x - pos.get(y)!.x, pos.get(x)!.y - pos.get(y)!.y);
    expect(dist('a', 'b')).toBeLessThan(dist('a', 'c'));
    expect(dist('c', 'd')).toBeLessThan(dist('a', 'd'));
  });

  it('scales iterations down for bigger graphs', () => {
    expect(layoutIterations(20)).toBeGreaterThan(layoutIterations(2000));
  });
});

describe('ForceAtlas2 runner (the worker’s engine)', () => {
  it('returns finite positions in input order and pulls connected nodes together', () => {
    const input = {
      nodes: [
        { id: 'a', x: -50, y: 0, size: 5 },
        { id: 'b', x: 50, y: 0, size: 5 },
        { id: 'c', x: 0, y: 60, size: 5 },
        { id: 'd', x: 0, y: -60, size: 5 },
      ],
      edges: [
        { a: 'a', b: 'b', weight: 1 },
        { a: 'c', b: 'd', weight: 0.2 },
        { a: 'a', b: 'missing', weight: 1 },
      ],
    };
    const r = new LayoutRunner(input);
    const before = r.positions();
    const after = r.step(200);
    expect(after).toHaveLength(8);
    for (const v of after) expect(Number.isFinite(v)).toBe(true);
    const d = (p: Float32Array, i: number, j: number) => Math.hypot(p[2 * i]! - p[2 * j]!, p[2 * i + 1]! - p[2 * j + 1]!);
    expect(d(after, 0, 1)).toBeLessThan(d(before, 0, 1));
  });

  it('survives an empty or single-node graph', () => {
    expect(new LayoutRunner({ nodes: [], edges: [] }).step(10)).toHaveLength(0);
    const one = new LayoutRunner({ nodes: [{ id: 'x', x: 1, y: 2, size: 3 }], edges: [] }).step(10);
    expect([...one]).toEqual([1, 2]);
  });
});

describe('search and neighbors', () => {
  const g: Pick<NetworkGraph, 'nodes' | 'edges'> = {
    nodes: [
      node('1', 'Avery Quinn', { degree: 2 }),
      node('2', 'Quinn Ruiz', { degree: 9 }),
      node('3', 'Zoë Park', { degree: 1 }),
      node('me', 'Me', { isMe: true, degree: 3 }),
    ],
    edges: [
      { a: '1', b: '2', strength: 0.8, weight: 3, tier: 'close', dominantType: 'co_group', types: ['co_group'] },
      { a: '2', b: '3', strength: 0.3, weight: 0.7, tier: 'acquainted', dominantType: 'co_attend', types: ['co_attend'] },
      { a: 'me', b: '2', strength: 0.5, weight: 1, tier: 'know', dominantType: 'tie', types: ['tie'] },
    ],
  };

  it('ranks label-prefix matches first, then word prefixes, ignoring accents; never ME', () => {
    expect(searchNodes(g.nodes, 'quinn').map((n) => n.id)).toEqual(['2', '1']);
    expect(searchNodes(g.nodes, 'zoe').map((n) => n.id)).toEqual(['3']);
    expect(searchNodes(g.nodes, 'me')).toEqual([]);
    expect(searchNodes(g.nodes, '  ')).toEqual([]);
  });

  it('lists neighbors and the strongest connections (without ME)', () => {
    expect([...neighborIds(g.edges, '2')].sort()).toEqual(['1', '3', 'me']);
    expect(topNeighbors(g, '2').map((x) => x.node.id)).toEqual(['1', '3']);
  });
});

describe('renderer settings', () => {
  it('sizes nodes and edges in screen pixels (sigma v4 defaults to graph units)', () => {
    expect(SIGMA_SETTINGS.itemSizesReference).toBe('screen');
    expect(SIGMA_SETTINGS.zoomToSizeRatioFunction(4)).toBe(2);
    expect(nodeSize(100)).toBeLessThanOrEqual(14);
  });
});
