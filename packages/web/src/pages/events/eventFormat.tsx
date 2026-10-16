import { IconTile } from '../../components/EntityRow';
import { Icons } from '../../components/icons';

/** 36px month/day tile (radius 8) for event rows. */
export function DateTile({ ms }: { ms: number | null }) {
  if (ms == null) return <IconTile accent>{Icons.calendar}</IconTile>;
  const d = new Date(ms);
  return (
    <span className="icon-tile accent date-tile" aria-hidden>
      <span className="dt-m">{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d)}</span>
      <span className="dt-d">{d.getDate()}</span>
    </span>
  );
}
