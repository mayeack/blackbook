import { sourceLabel, sourceShort } from '../lib/labels';
import { IconTile } from './EntityRow';

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="badge" title={sourceLabel(source)}>
      {sourceLabel(source)}
    </span>
  );
}

export function SourceBadges({ sources, max = 3 }: { sources: string[]; max?: number }) {
  if (sources.length === 0) return null;
  const shown = sources.slice(0, max);
  return (
    <span className="chips" aria-label={`Sources: ${sources.map(sourceLabel).join(', ')}`}>
      {shown.map((s) => (
        <span key={s} className="badge" title={sourceLabel(s)}>
          {sourceShort(s)}
        </span>
      ))}
      {sources.length > max && <span className="badge">+{sources.length - max}</span>}
    </span>
  );
}

export const SourceTile = ({ source, size }: { source: string; size?: number }) => (
  <IconTile size={size}>
    <span style={{ fontSize: 12, fontWeight: 700 }}>{sourceShort(source)}</span>
  </IconTile>
);
