import { channelsOf, sourceLabel, sourceShort } from '../lib/labels';
import { IconTile } from './EntityRow';

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="badge" title={sourceLabel(source)}>
      {sourceLabel(source)}
    </span>
  );
}

/** One badge per network (Beeper and the Instagram export both read as Instagram). */
export function SourceBadges({ sources, max = 3 }: { sources: string[]; max?: number }) {
  const channels = channelsOf(sources);
  if (channels.length === 0) return null;
  const shown = channels.slice(0, max);
  return (
    <span className="chips" aria-label={`Sources: ${channels.map(sourceLabel).join(', ')}`}>
      {shown.map((s) => (
        <span key={s} className="badge" title={sourceLabel(s)}>
          {sourceShort(s)}
        </span>
      ))}
      {channels.length > max && <span className="badge">+{channels.length - max}</span>}
    </span>
  );
}

/** Full-word source badges ("Partiful", "Calendar"), for event cards. */
export function SourceWordBadges({ sources }: { sources: string[] }) {
  const channels = channelsOf(sources);
  if (channels.length === 0) return null;
  return (
    <span className="chips" aria-label={`From ${channels.map(sourceLabel).join(' and ')}`}>
      {channels.map((s) => (
        <span key={s} className={`badge src-${s}`}>
          {sourceLabel(s)}
        </span>
      ))}
    </span>
  );
}

export const SourceTile = ({ source, size }: { source: string; size?: number }) => (
  <IconTile size={size}>
    <span style={{ fontSize: 12, fontWeight: 700 }} title={sourceLabel(source)}>
      {sourceShort(source)}
    </span>
  </IconTile>
);
