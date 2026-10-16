/**
 * Network graph: GET /api/v1/network?circle=&types=&minStrength=&window=&includeMe=&limit=
 *
 * Canonical, visible people only (never hidden/merged/roster-only/ME unless includeMe). Edges with strength ≥
 * minStrength (default 0.15); width = strength, color = dominant evidence type; node size = tie strength to me.
 * Layout (ForceAtlas2) runs in the browser worker; x/y are optional seeds.
 */
import { z } from 'zod';
import { EdgeTier, Ms, QueryBool, TieState } from './common';

export const NetworkWindow = z.enum(['90d', '1y', 'all']);
export type NetworkWindow = z.infer<typeof NetworkWindow>;

export const NetworkQuery = z.object({
  circle: z.string().optional(),
  /** Comma-separated edge evidence types ('co_group,co_attend'). */
  types: z
    .string()
    .max(400)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)),
  minStrength: z.coerce.number().min(0).max(1).default(0.15),
  window: NetworkWindow.default('1y'),
  includeMe: QueryBool,
  limit: z.coerce.number().int().min(10).max(5000).default(1500),
});
export type NetworkQuery = z.infer<typeof NetworkQuery>;

export const NetworkNode = z.object({
  id: z.string(),
  label: z.string(),
  firstName: z.string().nullable(),
  /** Tie strength to me T (0–100), drives node size. */
  tieStrength: z.number().nullable(),
  state: TieState.nullable(),
  circleIds: z.array(z.string()),
  /** The circle that colors the node. */
  primaryCircleId: z.string().nullable(),
  degree: z.number().int(),
  isMe: z.boolean(),
  x: z.number().nullable(),
  y: z.number().nullable(),
});
export type NetworkNode = z.infer<typeof NetworkNode>;

export const NetworkEdge = z.object({
  a: z.string(),
  b: z.string(),
  strength: z.number(),
  weight: z.number(),
  tier: EdgeTier,
  dominantType: z.string().nullable(),
  types: z.array(z.string()),
});
export type NetworkEdge = z.infer<typeof NetworkEdge>;

export const NetworkCircle = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['auto', 'user']),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  size: z.number().int(),
});
export type NetworkCircle = z.infer<typeof NetworkCircle>;

export const NetworkGraph = z.object({
  nodes: z.array(NetworkNode),
  edges: z.array(NetworkEdge),
  circles: z.array(NetworkCircle),
  /** Edge evidence types present (for the filter chips). */
  edgeTypes: z.array(z.string()),
  generatedAt: Ms,
  /** More nodes matched than `limit`. */
  truncated: z.boolean(),
});
export type NetworkGraph = z.infer<typeof NetworkGraph>;
