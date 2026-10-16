/**
 * Trips (/trips; travel digest items link here): your trips away from home with the people you know there and
 * why they matched, plus friends coming to your city. Upcoming | Past. Every person is a PersonLink. Read-only.
 */
import { Link, useSearchParams } from 'react-router';
import type { Trip, TripsQuery, Visitor } from '@yb/shared';
import { Avatar } from '../components/Avatar';
import { EntityRow, IconTile } from '../components/EntityRow';
import { Icons } from '../components/icons';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { plural } from '../lib/format';
import { dayRange, tripPersonLine, whenLabel } from '../lib/intel';
import { useTrips } from './events/intelApi';
import './events/intel.css';

type When = TripsQuery['when'];
const TABS: { value: When; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];

function TripCard({ t }: { t: Trip }) {
  const when = whenLabel(t.startsOn, t.endsOn);
  return (
    <article className="card trip-card" aria-label={t.label ?? 'Trip'}>
      <div className="entity-row trip-head">
        <IconTile accent>{Icons.events}</IconTile>
        <span className="er-text">
          <span className="er-title">{t.label ?? 'Trip'}</span>
          <span className="er-subtitle">
            {dayRange(t.startsOn, t.endsOn)}
            {when ? ` · ${when}` : ''}
          </span>
        </span>
        {t.suggestionId && (
          <span className="er-trailing">
            <Link to="/today" className="pill pill-accent">
              On Today
            </Link>
          </span>
        )}
      </div>
      {t.people.length === 0 ? (
        <p className="caption trip-empty">No one you know there yet.</p>
      ) : (
        <div className="card-list trip-people">
          {t.people.map((p) => (
            <EntityRow
              key={p.person.id}
              personId={p.person.id}
              icon={<Avatar id={p.person.id} name={p.person.displayName} />}
              title={p.person.displayName}
              subtitle={tripPersonLine(p.reason, p.detail)}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function VisitorRow({ v }: { v: Visitor }) {
  return (
    <EntityRow
      personId={v.person.id}
      icon={<Avatar id={v.person.id} name={v.person.displayName} />}
      title={v.person.displayName}
      subtitle={`In town ${dayRange(v.startsOn, v.endsOn)}`}
      trailing={v.suggestionId ? <span className="pill pill-accent">On Today</span> : undefined}
    />
  );
}

export function TripsPage() {
  const [params, setParams] = useSearchParams();
  const when: When = params.get('when') === 'past' ? 'past' : 'upcoming';
  const q = useTrips(when);
  const setWhen = (w: When) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (w === 'upcoming') next.delete('when');
        else next.set('when', w);
        return next;
      },
      { replace: true },
    );
  const d = q.data;
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link to="/events" className="back-link">
          ‹ Events
        </Link>
      </p>
      <PageHeader title="Trips" sub={d?.home ? `Time away from ${d.home}, who you know there, and friends coming your way.` : 'Time away, who you know there, and friends coming your way.'} />
      <div className="segmented" role="tablist" aria-label="When">
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={when === t.value} onClick={() => setWhen(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <PageState error={null} />
      ) : q.isError ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {!d!.home && (
            <div className="notice">
              yeackbot doesn’t know your home city yet, so it can’t tell when you’re away. <Link to="/settings/agent">Set it in Agent settings</Link>.
            </div>
          )}
          <h2 className="section-title">{when === 'past' ? 'Past trips' : 'Your trips'}</h2>
          {d!.trips.length === 0 ? (
            <div className="card-list">
              {when === 'upcoming' ? (
                <Empty title="No trips coming up.">Flights, hotels and out-of-town events from your calendar show up here.</Empty>
              ) : (
                <Empty title="No past trips in the last year." />
              )}
            </div>
          ) : (
            <div className="trip-list">
              {d!.trips.map((t) => (
                <TripCard key={t.id} t={t} />
              ))}
            </div>
          )}
          <h2 className="section-title">
            {when === 'past' ? 'Friends who visited' : 'Friends coming to town'}
            {d!.visitors.length > 0 ? ` · ${plural(d!.visitors.length, 'person', 'people')}` : ''}
          </h2>
          {d!.visitors.length === 0 ? (
            <div className="card-list">
              <Empty title={when === 'past' ? 'No visits on record.' : 'No one has mentioned a visit.'}>When a friend says they’re coming your way, it shows here.</Empty>
            </div>
          ) : (
            <div className="card-list">
              {d!.visitors.map((v) => (
                <VisitorRow key={`${v.person.id}-${v.factId}`} v={v} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
