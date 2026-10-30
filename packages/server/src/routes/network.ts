/**
 * GET /network?circle=&types=&minStrength=&window=&includeMe=&limit=   → NetworkGraph (@yb/shared api/network.ts)
 *
 * The person↔person graph from edge_stats (pipeline/graph). Nodes are visible canonical people only (person_visible:
 * never hidden, merged-away, roster-only or service people), minus records named like a venue, brand or promoter
 * (identity/nonPerson); the owner is hidden unless includeMe, and then only linked by tie strength (T/100) to the
 * people shown. Filters:
 *   types        keep only these evidence types: W and strength are recomputed from the per-type breakdown
 *   window       90d / 1y keep evidence types whose latest evidence is that recent (labels always count); all = no cut
 *   minStrength  default 0.15 (faint edges hidden)
 *   circle       only members of that circle (and the edges among them)
 *   limit        the best-connected nodes first (degree, then tie strength); `truncated` says more matched
 * Node size = tie strength to the owner; color = primary circle (auto first, by score). Layout runs in the browser.
 */
import { Router } from 'express';
import { NetworkQuery, type NetworkCircle, type NetworkEdge, type NetworkGraph, type NetworkNode, type TieState } from '@yb/shared';
import type { DB } from '../db/connection';
import { notFound } from '../http/errors';
import { organizationPeople } from '../identity/nonPerson';
import { strengthOf, tierOf } from '../pipeline/graph/weights';
import type { RouteDeps } from './index';
import { maskText } from './people';

const DAY = 86_400_000;
const TIMELESS = new Set(['label', 'met_via']);
const WINDOW_DAYS: Record<string, number | null> = { '90d': 90, '1y': 365, all: null };

interface EdgeRow {
  a_id: string;
  b_id: string;
  weight: number;
  strength: number;
  dominant_type: string | null;
  types: string;
  breakdown: string;
}

interface Breakdown {
  [type: string]: { w: number; n: number; last: number | null };
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function networkGraph(db: DB, q: NetworkQuery, now = Date.now()): NetworkGraph {
  const visible = new Map(
    (
      db.prepare('SELECT v.id, v.display_name, v.first_name, s.tie_strength, s.state FROM person_visible v LEFT JOIN person_stats s ON s.person_id = v.id').all() as {
        id: string;
        display_name: string;
        first_name: string | null;
        tie_strength: number | null;
        state: TieState | null;
      }[]
    ).map((p) => [p.id, p]),
  );
  for (const id of organizationPeople(db)) visible.delete(id);

  // circles: active ones with their visible canonical members
  const circleRows = db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.color_hex, c.icon, pc.canonical_id AS person_id, cm.score
       FROM circles c
       LEFT JOIN circle_members cm ON cm.circle_id = c.id AND cm.excluded = 0
       LEFT JOIN person_canon pc ON pc.person_id = cm.person_id
       WHERE c.status = 'active'
       ORDER BY c.id`,
    )
    .all() as { id: string; name: string; kind: 'auto' | 'user'; color_hex: string | null; icon: string | null; person_id: string | null; score: number | null }[];
  const circles = new Map<string, NetworkCircle & { members: Set<string> }>();
  const memberships = new Map<string, { id: string; kind: 'auto' | 'user'; score: number; name: string }[]>();
  for (const r of circleRows) {
    let c = circles.get(r.id);
    if (!c) circles.set(r.id, (c = { id: r.id, name: maskText(r.name), kind: r.kind, color: r.color_hex, icon: r.icon, size: 0, members: new Set() }));
    if (!r.person_id || !visible.has(r.person_id) || c.members.has(r.person_id)) continue;
    c.members.add(r.person_id);
    const list = memberships.get(r.person_id) ?? [];
    list.push({ id: r.id, kind: r.kind, score: r.score ?? 0, name: c.name });
    memberships.set(r.person_id, list);
  }
  for (const c of circles.values()) c.size = c.members.size;
  const only = q.circle ? circles.get(q.circle) : undefined;
  if (q.circle && !only) throw notFound('Circle');

  const windowDays = WINDOW_DAYS[q.window] ?? null;
  const cutoff = windowDays === null ? null : now - windowDays * DAY;
  const wanted = q.types ? new Set(q.types) : null;
  const filtering = wanted !== null || cutoff !== null;

  const edgeTypes = new Set<string>();
  const edges: NetworkEdge[] = [];
  for (const e of db.prepare('SELECT a_id, b_id, weight, strength, dominant_type, types, breakdown FROM edge_stats').all() as EdgeRow[]) {
    if (!visible.has(e.a_id) || !visible.has(e.b_id)) continue;
    if (only && (!only.members.has(e.a_id) || !only.members.has(e.b_id))) continue;
    const allTypes = JSON.parse(e.types) as string[];
    for (const t of allTypes) edgeTypes.add(t);
    let weight = e.weight;
    let strength = e.strength;
    let dominant = e.dominant_type;
    let types = allTypes;
    if (filtering) {
      const b = JSON.parse(e.breakdown) as Breakdown;
      types = allTypes.filter((t) => (!wanted || wanted.has(t)) && (cutoff === null || TIMELESS.has(t) || (b[t]?.last ?? 0) >= cutoff));
      if (!types.length) continue;
      weight = r4(types.reduce((s, t) => s + (b[t]?.w ?? 0), 0));
      strength = r4(strengthOf(weight));
      dominant = types.reduce<string | null>((best, t) => (best === null || (b[t]?.w ?? 0) > (b[best]?.w ?? 0) ? t : best), null);
    }
    if (strength < q.minStrength) continue;
    edges.push({ a: e.a_id, b: e.b_id, strength, weight, tier: tierOf(strength), dominantType: dominant, types });
  }

  // nodes: connected people (plus every member of the selected circle), best-connected first
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  if (only) for (const m of only.members) if (!degree.has(m)) degree.set(m, 0);
  const ranked = [...degree.keys()].sort(
    (x, y) => degree.get(y)! - degree.get(x)! || (visible.get(y)!.tie_strength ?? 0) - (visible.get(x)!.tie_strength ?? 0) || (x < y ? -1 : 1),
  );
  const truncated = ranked.length > q.limit;
  const kept = new Set(ranked.slice(0, q.limit));
  const keptEdges = edges.filter((e) => kept.has(e.a) && kept.has(e.b));
  const keptDegree = new Map<string, number>();
  for (const e of keptEdges) {
    keptDegree.set(e.a, (keptDegree.get(e.a) ?? 0) + 1);
    keptDegree.set(e.b, (keptDegree.get(e.b) ?? 0) + 1);
  }

  const nodes: NetworkNode[] = [...kept].map((id) => {
    const p = visible.get(id)!;
    const ms = (memberships.get(id) ?? []).sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'auto' ? -1 : 1) || y.score - x.score || x.name.localeCompare(y.name));
    return {
      id,
      label: maskText(p.display_name),
      firstName: p.first_name === null ? null : maskText(p.first_name),
      tieStrength: p.tie_strength,
      state: p.state,
      circleIds: ms.map((m) => m.id),
      primaryCircleId: ms[0]?.id ?? null,
      degree: keptDegree.get(id) ?? 0,
      isMe: false,
      x: null,
      y: null,
    };
  });

  if (q.includeMe) {
    const me = db
      .prepare(`SELECT id, display_name, first_name FROM people WHERE kind = 'me' AND merged_into_id IS NULL AND status IN ('active','provisional') LIMIT 1`)
      .get() as { id: string; display_name: string; first_name: string | null } | undefined;
    const meId = me?.id ?? 'me';
    let meDegree = 0;
    for (const n of nodes) {
      const t = n.tieStrength;
      if (t === null || t <= 0) continue;
      const strength = r4(Math.min(1, t / 100));
      if (strength < q.minStrength) continue;
      keptEdges.push({ a: meId, b: n.id, strength, weight: r4(-2 * Math.log(1 - Math.min(0.9999, strength))), tier: tierOf(strength), dominantType: 'tie', types: ['tie'] });
      n.degree++;
      meDegree++;
    }
    nodes.push({ id: meId, label: 'Me', firstName: null, tieStrength: null, state: null, circleIds: [], primaryCircleId: null, degree: meDegree, isMe: true, x: null, y: null });
    if (meDegree) edgeTypes.add('tie');
  }

  return {
    nodes,
    edges: keptEdges,
    circles: [...circles.values()]
      .filter((c) => c.size > 0)
      .map(({ members: _m, ...c }) => c)
      .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'auto' ? -1 : 1) || y.size - x.size || x.name.localeCompare(y.name)),
    edgeTypes: [...edgeTypes].sort(),
    generatedAt: now,
    truncated,
  };
}

export function networkRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/network', (req, res) => {
    const q = NetworkQuery.parse(req.query);
    res.json(networkGraph(db, q) satisfies NetworkGraph);
  });
  return r;
}
