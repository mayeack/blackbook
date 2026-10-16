import type { CSSProperties } from 'react';
import { hueFor, initials } from '../lib/format';

/**
 * Initials tile (36px, radius scales with size). Never render one on its own: wrap it in <PersonLink> (every
 * avatar links to its person).
 */
export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  const style = { '--av-h': String(hueFor(id)), '--size': `${size}px` } as CSSProperties;
  return (
    <span className="avatar" style={style} aria-hidden>
      {initials(name)}
    </span>
  );
}
