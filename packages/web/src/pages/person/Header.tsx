import { Link } from 'react-router';
import type { MetAtList, SparkPoint, TieStats } from '@yb/shared';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { PersonLink } from '../../components/PersonLink';
import { roleLine } from '../../lib/format';
import { stateLabel } from '../../lib/labels';
import { metAtHeader } from '../../lib/tickets';
import { cadenceLine, closenessText, initiativeLine, ringDash, ringLabel, sparklineCoords, stateColorVar, tiesFromPerson } from './logic';

/** Avatar inside a ring whose arc is tie strength T (0–100), colored by state. Links to the person. */
export function TieRing({ id, name, ties, size = 64 }: { id: string; name: string; ties: TieStats | null; size?: number }) {
  const stroke = 4;
  const box = size + 2 * (stroke + 3);
  const r = (box - stroke) / 2;
  const dash = ringDash(ties?.tieStrength ?? null, r);
  const color = stateColorVar(ties?.state ?? null);
  return (
    <PersonLink id={id} className="tie-ring" title={ringLabel(ties)}>
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden focusable="false">
        <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        {dash.fraction > 0 && (
          <circle
            cx={box / 2}
            cy={box / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash.length} ${dash.gap}`}
            transform={`rotate(-90 ${box / 2} ${box / 2})`}
          />
        )}
      </svg>
      <span className="tie-ring-avatar">
        <Avatar id={id} name={name} size={size} />
      </span>
      <span className="sr-only">{ringLabel(ties)}</span>
    </PersonLink>
  );
}

/** Weekly tie strength, oldest left (no axes: a glance, not a chart). */
export function Sparkline({ points, width = 96, height = 24, label }: { points: SparkPoint[]; width?: number; height?: number; label: string }) {
  const coords = sparklineCoords(points, width, height);
  const end = coords[coords.length - 1];
  if (!end) return null;
  const last = points[points.length - 1]!;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title>
      <polyline points={coords.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={end[0]} cy={end[1]} r={2.2} fill="var(--accent)">
        <title>{`Now: ${Math.round(last.t)}`}</title>
      </circle>
    </svg>
  );
}

/**
 * Header: tie ring + name (+ priority star, New), role, places, "Met at <event> · <date> · via <signal>" when yeackbot
 * placed where you met, then "Strong · 7/10 · usually every ~9d · last 41d ago", a trend sparkline and who usually starts. Tie
 * stats come from /ties when it's available, else the base person.
 */
export function PersonHeader({ p, ties, metAt }: { p: PersonDetail; ties: TieStats | null; metAt?: MetAtList | null }) {
  const role = roleLine(p.jobTitle, p.company);
  const met = metAtHeader(metAt);
  const t = ties ?? tiesFromPerson(p);
  const cadence = cadenceLine(t);
  const state = t?.state ?? null;
  const stateText = t?.label ?? (state ? stateLabel(state) : null);
  const initiative = initiativeLine(t);
  const spark = t?.sparkline ?? [];
  const suppressed = t?.fadingSuppressed ?? false;
  const closeness = t?.closeness ?? p.closeness;

  return (
    <div className="person-header">
      <TieRing id={p.id} name={p.displayName} ties={t} />
      <div className="ph-text">
        <h1>
          {p.displayName}
          {p.isPriority && (
            <span className="star" aria-label="Priority">
              {' '}
              ★
            </span>
          )}
          {p.status === 'provisional' && <span className="pill pill-accent new-badge">New</span>}
        </h1>
        {p.nickname && <div className="ph-line">“{p.nickname}”</div>}
        {role && <div className="ph-line">{role}</div>}
        {p.locations.length > 0 && <div className="ph-line">{p.locations.join(' · ')}</div>}
        {met && (
          <div className="ph-line ph-met">
            Met at <Link to={met.href}>{met.title}</Link> · {met.when} · via {met.via}
          </div>
        )}
        <div className="ph-line ph-cadence">
          {stateText && (
            <span className={`state-pill state-${state ?? 'none'}`}>
              <span className={`state-dot ${state ?? ''}`} aria-hidden />
              {stateText}
            </span>
          )}
          <span className="closeness" title="Closeness: 1 = acquaintance, 10 = closest" aria-label={closenessText(closeness)}>
            {closeness}/10
          </span>
          {cadence && <span>{cadence}</span>}
        </div>
        {(spark.length > 1 || initiative) && (
          <div className="ph-line ph-trend">
            {spark.length > 1 && <Sparkline points={spark} label={`Tie strength over the last ${spark.length} weeks`} />}
            {initiative && <span className="caption">{initiative}</span>}
          </div>
        )}
        {suppressed && <div className="ph-line caption">Fading checks wait until WhatsApp and Instagram are syncing for them.</div>}
      </div>
    </div>
  );
}
