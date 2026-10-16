import { Link } from 'react-router';
import { MORE_ITEMS } from '../components/AppShell';
import { EntityRow, IconTile } from '../components/EntityRow';
import { Icons } from '../components/icons';
import { Empty, PageHeader } from '../components/PageState';

const MORE_SUBTITLES: Record<string, string> = {
  '/circles': 'Groups, tags and places',
  '/events': 'Get-togethers and who was there',
  '/sources': 'Ingest health and freshness',
  '/settings': 'Digest, push, privacy',
};

/** Mobile "More" tab: the screens that don't fit in the tab bar. */
export function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <div className="card-list">
        {MORE_ITEMS.map((i) => (
          <EntityRow
            key={i.to}
            to={i.to}
            icon={<IconTile accent>{i.icon}</IconTile>}
            title={i.label}
            subtitle={MORE_SUBTITLES[i.to]}
            trailing={<span className="chevron">{Icons.chevron}</span>}
          />
        ))}
      </div>
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="card-list">
      <Empty title="Nothing here.">
        <Link to="/today">Go to Today</Link>
      </Empty>
    </div>
  );
}
