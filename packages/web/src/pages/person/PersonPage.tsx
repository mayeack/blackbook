import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { usePerson } from '../../api/hooks';
import { Empty, PageState } from '../../components/PageState';
import { personPath } from '../../components/PersonLink';
import { useTies } from './api';
import { personTab, type PersonTab } from './logic';
import { PersonHeader } from './Header';
import { PersonConnections } from './PersonConnections';
import { PersonOverview } from './PersonOverview';
import { PersonTimeline } from './PersonTimeline';
import './person.css';

const TABS: { id: PersonTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'connections', label: 'Connections' },
];

export function PersonPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = personTab(params);
  const navigate = useNavigate();
  const location = useLocation();
  const person = usePerson(id);
  const resolvedId = person.data?.id ?? '';
  const ties = useTies(resolvedId && resolvedId === id ? resolvedId : '');

  // A merged-away id resolves to the survivor: move the URL there.
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
  const setTab = (t: PersonTab) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (t !== 'timeline') {
          next.delete('m');
          next.delete('at');
        }
        if (t === 'overview') next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <PersonHeader p={p} ties={ties.data ?? null} />
      <div className="segmented" role="tablist" aria-label="Person sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <PersonOverview p={p} /> : tab === 'timeline' ? <PersonTimeline p={p} /> : <PersonConnections p={p} />}
    </>
  );
}
