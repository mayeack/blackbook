import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { usePerson } from '../../api/hooks';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink, personPath } from '../../components/PersonLink';
import { relativeDay, roleLine } from '../../lib/format';
import { stateLabel } from '../../lib/labels';
import { PersonOverview } from './PersonOverview';
import { PersonTimeline } from './PersonTimeline';

type Tab = 'overview' | 'timeline';

function cadenceLine(p: PersonDetail): string | null {
  const s = p.stats;
  if (!s) return null;
  const parts: string[] = [];
  if (s.expectedGapD != null && s.expectedGapD > 0) parts.push(`usually every ~${Math.max(1, Math.round(s.expectedGapD))}d`);
  if (s.lastAt != null) parts.push(`last ${relativeDay(s.lastAt)}`);
  return parts.length ? parts.join(' · ') : null;
}

function PersonHeader({ p }: { p: PersonDetail }) {
  const role = roleLine(p.jobTitle, p.company);
  const cadence = cadenceLine(p);
  return (
    <div className="person-header">
      <PersonLink id={p.id} title={p.displayName}>
        <Avatar id={p.id} name={p.displayName} size={64} />
      </PersonLink>
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
        {(cadence || p.stats?.state) && (
          <div className="ph-line">
            {p.stats?.state && (
              <>
                <span className={`state-dot ${p.stats.state}`} style={{ display: 'inline-block', marginRight: 6 }} />
                {stateLabel(p.stats.state)}
                {cadence ? ' · ' : ''}
              </>
            )}
            {cadence}
          </div>
        )}
      </div>
    </div>
  );
}

export function PersonPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'timeline' ? 'timeline' : 'overview';
  const navigate = useNavigate();
  const location = useLocation();
  const person = usePerson(id);

  // A merged-away id resolves to the survivor: move the URL there.
  const resolvedId = person.data?.id;
  useEffect(() => {
    if (resolvedId && resolvedId !== id) void navigate(personPath(resolvedId) + location.search, { replace: true });
  }, [resolvedId, id, navigate, location.search]);

  if (person.isPending) return <PageState error={null} />;
  if (person.isError) {
    if (isApiError(person.error) && (person.error.status === 404 || person.error.status === 400))
      return (
        <div className="card-list">
          <Empty title="This person isn’t available.">
            They may have been merged or hidden. <Link to="/people">Back to People</Link>
          </Empty>
        </div>
      );
    return <PageState error={person.error} onRetry={() => void person.refetch()} />;
  }

  const p = person.data;
  const setTab = (t: Tab) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (t === 'overview') next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <PersonHeader p={p} />
      <div className="segmented" role="tablist" aria-label="Person sections">
        <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button type="button" role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>
          Timeline
        </button>
        <button type="button" role="tab" aria-selected={false} disabled title="Coming with relationship inference">
          Connections
        </button>
      </div>
      {tab === 'overview' ? <PersonOverview p={p} /> : <PersonTimeline p={p} />}
    </>
  );
}
