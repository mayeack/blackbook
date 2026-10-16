import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar } from './Avatar';

export const personPath = (id: string) => `/p/${encodeURIComponent(id)}`;

/** The only way to show a person's avatar, chip or row: everything about a person links to /p/:id. */
export function PersonLink({
  id,
  children,
  className,
  title,
}: {
  id: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <Link to={personPath(id)} className={className} title={title}>
      {children}
    </Link>
  );
}

/** Small avatar + name chip. */
export function PersonChip({ id, name }: { id: string; name: string }) {
  return (
    <PersonLink id={id} className="chip">
      <Avatar id={id} name={name} size={22} />
      <span>{name}</span>
    </PersonLink>
  );
}
