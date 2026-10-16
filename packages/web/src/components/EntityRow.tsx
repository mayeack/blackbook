import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { PersonLink } from './PersonLink';

export interface EntityRowProps {
  /** 36px tile: an <Avatar> for people, an <IconTile> for everything else. */
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Accessories: badges, counts, buttons (buttons only when the row itself isn't a link). */
  trailing?: ReactNode;
  /** Row links to this person (through PersonLink). */
  personId?: string;
  /** Row links elsewhere. */
  to?: string;
}

/** The shared list row: 36px icon, title up to two lines, caption subtitle, trailing slot. */
export function EntityRow({ icon, title, subtitle, trailing, personId, to }: EntityRowProps) {
  const body = (
    <>
      {icon}
      <span className="er-text">
        <span className="er-title">{title}</span>
        {subtitle != null && subtitle !== '' && <span className="er-subtitle">{subtitle}</span>}
      </span>
      {trailing != null && <span className="er-trailing">{trailing}</span>}
    </>
  );
  if (personId)
    return (
      <PersonLink id={personId} className="entity-row">
        {body}
      </PersonLink>
    );
  if (to)
    return (
      <Link to={to} className="entity-row">
        {body}
      </Link>
    );
  return <div className="entity-row">{body}</div>;
}

/** A 36px rounded tile with an icon or short text (for non-person rows). */
export function IconTile({ children, accent, size }: { children: ReactNode; accent?: boolean; size?: number }) {
  return (
    <span className={accent ? 'icon-tile accent' : 'icon-tile'} style={size ? ({ '--size': `${size}px` } as CSSProperties) : undefined} aria-hidden>
      {children}
    </span>
  );
}
