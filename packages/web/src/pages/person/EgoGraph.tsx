import { useNavigate } from 'react-router';
import { personPath } from '../../components/PersonLink';
import { hueFor, initials } from '../../lib/format';
import { egoLayout } from './logic';

export interface EgoNeighbor {
  id: string;
  name: string;
  strength: number;
}

/**
 * Mini ego graph (SVG, no layout engine): the person in the middle, neighbors on a ring (stronger = closer),
 * edges to the center plus the edges among neighbors. Every node is a link to that person.
 */
export function EgoGraph({
  center,
  neighbors,
  among,
  size = 280,
}: {
  center: { id: string; name: string };
  neighbors: EgoNeighbor[];
  among: { a: string; b: string; strength: number }[];
  size?: number;
}) {
  const navigate = useNavigate();
  const nodes = egoLayout(center.id, neighbors, size);
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const names = new Map([[center.id, center.name], ...neighbors.map((n) => [n.id, n.name] as const)]);
  const strength = new Map(neighbors.map((n) => [n.id, n.strength]));
  const c = pos.get(center.id)!;
  return (
    <svg className="ego-graph" viewBox={`0 0 ${size} ${size}`} role="group" aria-label={`${center.name}’s closest connections`}>
      {among.map((e) => {
        const a = pos.get(e.a);
        const b = pos.get(e.b);
        if (!a || !b) return null;
        return <line key={`${e.a}-${e.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={0.6 + e.strength * 1.6} opacity={0.7} />;
      })}
      {nodes
        .filter((n) => !n.center)
        .map((n) => (
          <line key={`c-${n.id}`} x1={c.x} y1={c.y} x2={n.x} y2={n.y} stroke="var(--accent)" strokeWidth={0.6 + (strength.get(n.id) ?? 0) * 2.4} opacity={0.55} />
        ))}
      {nodes.map((n) => {
        const name = names.get(n.id) ?? '';
        const hue = hueFor(n.id);
        return (
          <a
            key={n.id}
            href={personPath(n.id)}
            onClick={(e) => {
              e.preventDefault();
              void navigate(personPath(n.id));
            }}
            aria-label={name}
          >
            <title>{name}</title>
            <circle cx={n.x} cy={n.y} r={n.r} fill={`hsl(${hue} 52% ${n.center ? 70 : 78}%)`} stroke={n.center ? 'var(--accent)' : 'var(--surface)'} strokeWidth={n.center ? 2.5 : 1.5} />
            {n.r >= 7 && (
              <text x={n.x} y={n.y} dy="0.35em" textAnchor="middle" fontSize={Math.round(n.r * 0.85)} fontWeight={650} fill={`hsl(${hue} 45% 22%)`} pointerEvents="none">
                {initials(name)}
              </text>
            )}
          </a>
        );
      })}
    </svg>
  );
}
