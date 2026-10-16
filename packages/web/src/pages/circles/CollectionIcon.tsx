import type { CSSProperties } from 'react';
import type { CollectionType } from '@yb/shared';
import { IconTile } from '../../components/EntityRow';

const GLYPH: Record<CollectionType, string> = { circle: '◎', tag: '#', location: '⌖' };

/** 36px tile: the circle's emoji/icon if it has one, else a type glyph on the collection's color. */
export function CollectionIcon({ type, icon, color, size }: { type: CollectionType; icon: string | null; color: string | null; size?: number }) {
  const style = color ? ({ '--coll-color': color } as CSSProperties) : undefined;
  return (
    <span className={color ? 'coll-icon colored' : 'coll-icon'} style={style}>
      <IconTile size={size}>
        <span aria-hidden>{icon || GLYPH[type]}</span>
      </IconTile>
    </span>
  );
}

/** A small colored dot for chips. */
export function CollectionDot({ color }: { color: string | null }) {
  return <span className="coll-dot" style={color ? ({ background: color } as CSSProperties) : undefined} aria-hidden />;
}
