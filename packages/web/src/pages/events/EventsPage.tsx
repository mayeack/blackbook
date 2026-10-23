import { Link, useSearchParams } from 'react-router';
import { isNotImplemented, useEvents } from '../../api/hooks';
import type { EventsWhen, OccasionSummary } from '../../api/types';
import { AttendeeChip } from '../../components/AttendeeChip';
import { Icons } from '../../components/icons';
import { Empty, PageHeader, PageState } from '../../components/PageState';
import { SourceWordBadges } from '../../components/SourceBadge';
import { eventPath, occasionTitle, sortOccasions, whenLine } from '../../lib/events';
import { plural } from '../../lib/format';
import { attendeeStatusLabel, occasionKindLabel } from '../../lib/labels';
import { DateTile } from './eventFormat';

const MAX_CHIPS = 8;

function OccasionCard({ o }: { o: OccasionSummary }) {
  const visible = o.attendees.filter((a) => a.tier !== 'declined');
  const shown = visible.slice(0, MAX_CHIPS);
  const extra = Math.max(visible.length, o.attendeeCount + o.possibleCount) - shown.length;
  const foot = o.attendeeCount > 0 ? [plural(o.attendeeCount, 'person', 'people')] : [];
  if (o.possibleCount > 0) foot.push(`${o.possibleCount} possible`);
  if (o.evidenceCount > 0) foot.push(plural(o.evidenceCount, 'clue'));
  const venue = o.sensitive ? null : o.venue;
  return (
    <article className="event-card" aria-label={occasionTitle(o)}>
      <Link to={eventPath(o.id)} className="ev-head">
        <DateTile ms={o.startsAt} />
        <span className="er-text">
          <span className="ev-title">{occasionTitle(o)}</span>
          <span className="ev-meta">
            {whenLine(o)}
            {venue ? ` · ${venue}` : ''}
          </span>
        </span>
        <span className="chevron">{Icons.chevron}</span>
      </Link>
      <div className="ev-badges">
        <SourceWordBadges sources={o.sources} />
        {o.kind && o.kind !== 'social' && o.kind !== 'unknown' && <span className="pill">{occasionKindLabel(o.kind)}</span>}
        {o.myRsvp && <span className="pill pill-accent">You: {attendeeStatusLabel(o.myRsvp)}</span>}
      </div>
      {shown.length > 0 && (
        <div className="chips ev-people">
          {shown.map((a, i) => (
            <AttendeeChip key={a.personId ?? `g${i}`} a={a} />
          ))}
          {extra > 0 && (
            <Link to={eventPath(o.id)} className="chip plain more-chip">
              +{extra}
            </Link>
          )}
        </div>
      )}
      {foot.length > 0 ? <div className="ev-foot">{foot.join(' · ')}</div> : <div className="ev-foot-gap" />}
    </article>
  );
}

const TABS: { value: EventsWhen; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];

export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const when: EventsWhen = params.get('when') === 'past' ? 'past' : 'upcoming';
  const q = useEvents(when);
  const items = sortOccasions(q.data?.pages.flatMap((p) => p.items) ?? [], when);

  const setWhen = (w: EventsWhen) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (w === 'upcoming') next.delete('when');
        else next.set('when', w);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        title="Events"
        sub={
          <>
            Get-togethers from Partiful, your calendar and your tickets, and who was there. <Link to="/trips">Trips →</Link>{' '}
            <Link to="/tickets">Tickets →</Link>
          </>
        }
      />
      <div className="segmented" role="tablist" aria-label="When">
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={when === t.value} onClick={() => setWhen(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <PageState error={null} />
      ) : q.isError && items.length === 0 ? (
        isNotImplemented(q.error) ? (
          <div className="card-list">
            <Empty title="Events aren’t available yet.">They appear once the Partiful and calendar sync is running. See Sources.</Empty>
          </div>
        ) : (
          <PageState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : items.length === 0 ? (
        <div className="card-list">
          {when === 'upcoming' ? (
            <Empty title="Nothing coming up.">Partiful invites and calendar plans show here, with who’s going.</Empty>
          ) : (
            <Empty title="No past get-togethers yet.">Once Partiful and your calendar sync, past events show who was there.</Empty>
          )}
        </div>
      ) : (
        <div className="event-list">
          {items.map((o) => (
            <OccasionCard key={o.id} o={o} />
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : when === 'past' ? 'Load older' : 'Load more'}
          </button>
        </p>
      )}
    </>
  );
}
