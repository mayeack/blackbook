import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useHidden, useMe, useUnhide } from '../api/hooks';
import { MORE_ITEMS } from '../components/AppShell';
import { EntityRow, IconTile } from '../components/EntityRow';
import { Icons } from '../components/icons';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { useToast } from '../components/Toast';

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

/** A screen that arrives in a later phase. */
export function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card-list">
        <Empty title="Coming soon.">{children}</Empty>
      </div>
    </>
  );
}

export function SettingsPage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="Settings" />
      <h2 className="section-title">Account</h2>
      <div className="card-list">
        <EntityRow
          icon={<IconTile accent>{Icons.settings}</IconTile>}
          title={me.data ? me.data.email : me.isError ? 'Not signed in' : 'Loading…'}
          subtitle={me.data ? (me.data.via === 'access' ? 'Signed in through Cloudflare Access' : 'Development sign-in') : undefined}
        />
      </div>
      <HiddenSection />
      <h2 className="section-title">Agent, digest and privacy</h2>
      <div className="card-list">
        <Empty title="Coming soon.">Digest time, push, thresholds and what the agent has learned will live here.</Empty>
      </div>
    </>
  );
}

/**
 * Settings → Hidden: the one place hidden people appear. Rows are deliberately not links (a hidden person has no
 * page) and use an icon tile, not an avatar.
 */
function HiddenSection() {
  const hidden = useHidden();
  const unhide = useUnhide();
  const toast = useToast();
  return (
    <>
      <h2 className="section-title">Hidden</h2>
      <div className="card-list">
        {hidden.isError ? (
          <PageState error={hidden.error} onRetry={() => void hidden.refetch()} />
        ) : !hidden.data ? (
          <Empty title="Loading…" />
        ) : hidden.data.items.length === 0 ? (
          <Empty title="No hidden people.">People you hide stay out of every list, search and suggestion, and appear only here.</Empty>
        ) : (
          hidden.data.items.map((p) => (
            <EntityRow
              key={p.id}
              icon={<IconTile>{Icons.people}</IconTile>}
              title={p.displayName}
              subtitle={p.company}
              trailing={
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={unhide.isPending}
                  onClick={() =>
                    unhide.mutate(p.id, {
                      onSuccess: () => toast('Unhidden. You can undo this from Today.'),
                      onError: (e) => toast(e.message, 'error'),
                    })
                  }
                >
                  Unhide
                </button>
              }
            />
          ))
        )}
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
