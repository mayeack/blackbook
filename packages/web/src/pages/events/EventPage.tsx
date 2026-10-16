import { Link, useParams } from 'react-router';
import { isApiError } from '../../api/client';
import { isNotImplemented, useEvent } from '../../api/hooks';
import type { AttendeeTier, AttendeeView, OccasionDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { Icons } from '../../components/icons';
import { Empty, PageState } from '../../components/PageState';
import { SourceWordBadges } from '../../components/SourceBadge';
import { attendeeLine, occasionTitle, whenLine } from '../../lib/events';
import { plural } from '../../lib/format';
import { attendeeSourceLabel, attendeeStatusLabel, channelOf, occasionKindLabel } from '../../lib/labels';
import { DateTile } from './eventFormat';

const SECTIONS: { tier: AttendeeTier; title: string; note?: string }[] = [
  { tier: 'confirmed', title: 'Going' },
  { tier: 'maybe', title: 'Maybe or invited' },
  {
    tier: 'possible',
    title: 'Possibly there',
    note: 'Inferred from messages and the calendar with medium confidence. Shown, but not counted toward your ties until something confirms it.',
  },
  { tier: 'declined', title: 'Can’t go' },
];

/** The attendee's source as a badge: Calendar / Partiful / Inferred. */
function SourcePill({ source }: { source: string }) {
  const label = attendeeSourceLabel(source);
  return <span className={`badge src-${label === 'Inferred' ? 'inference' : channelOf(source)}`}>{label}</span>;
}

function AttendeeRow({ a }: { a: AttendeeView }) {
  const possible = a.tier === 'possible';
  return (
    <EntityRow
      personId={a.personId ?? undefined}
      className={possible ? 'possible' : undefined}
      icon={a.personId ? <Avatar id={a.personId} name={a.name} /> : <IconTile>{Icons.people}</IconTile>}
      title={
        <>
          {a.name}
          {possible && (
            <span className="tier-mark" aria-label="possibly">
              {' '}
              ?
            </span>
          )}
        </>
      }
      subtitle={attendeeLine(a, { withSource: false }) + (a.personId ? '' : ' · not in your people yet')}
      trailing={<SourcePill source={a.source} />}
    />
  );
}

function Header({ o }: { o: OccasionDetail }) {
  return (
    <div className="event-header">
      <DateTile ms={o.startsAt} />
      <div className="eh-text">
        <h1>{occasionTitle(o)}</h1>
        <div className="eh-line">{whenLine(o)}</div>
        {o.venue && !o.sensitive && <div className="eh-line">{o.venue}</div>}
        <div className="ev-badges">
          <SourceWordBadges sources={o.sources} />
          {o.kind && o.kind !== 'unknown' && <span className="pill">{occasionKindLabel(o.kind)}</span>}
          {o.myRsvp && <span className="pill pill-accent">You: {attendeeStatusLabel(o.myRsvp)}</span>}
        </div>
      </div>
    </div>
  );
}

export function EventPage() {
  const { id = '' } = useParams();
  const ev = useEvent(id);
  const back = (
    <Link to="/events" className="back-link">
      ‹ Events
    </Link>
  );

  if (ev.isPending) return <PageState error={null} />;
  if (ev.isError) {
    if (isApiError(ev.error) && (ev.error.status === 404 || ev.error.status === 400))
      return (
        <>
          {back}
          <div className="card-list">
            <Empty title="This event isn’t available.">It may have been merged into another get-together or excluded.</Empty>
          </div>
        </>
      );
    if (isNotImplemented(ev.error))
      return (
        <>
          {back}
          <div className="card-list">
            <Empty title="Events aren’t available yet." />
          </div>
        </>
      );
    return <PageState error={ev.error} onRetry={() => void ev.refetch()} />;
  }

  const o = ev.data;
  const counted = o.attendees.filter((a) => a.tier === 'confirmed').length;
  const summary = [plural(Math.max(counted, o.attendeeCount), 'person', 'people')];
  if (o.possibleCount > 0) summary.push(`${o.possibleCount} possible`);
  if (o.evidenceCount > 0) summary.push(plural(o.evidenceCount, 'clue'));

  return (
    <>
      <p style={{ margin: '0 0 8px' }}>{back}</p>
      <Header o={o} />
      {(o.url || o.calendars.length > 0) && (
        <div className="card source-card">
          <dl>
            {o.calendars.length > 0 && (
              <>
                <dt>{o.calendars.length > 1 ? 'Calendars' : 'Calendar'}</dt>
                <dd>{o.calendars.join(', ')}</dd>
              </>
            )}
            {o.url && (
              <>
                <dt>Link</dt>
                <dd>
                  <a href={o.url} target="_blank" rel="noopener noreferrer">
                    {o.sources.includes('partiful') ? 'Open in Partiful' : 'Open'}
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <h2 className="section-title">
        {o.startsAt != null && o.startsAt > Date.now() ? 'Who’s going' : 'Who was there'} · {summary.join(' · ')}
      </h2>
      {o.attendees.length === 0 ? (
        <div className="card-list">
          <Empty title="No one linked yet.">Attendees appear once RSVPs, the calendar and your messages are cross-referenced overnight.</Empty>
        </div>
      ) : (
        SECTIONS.map((sec) => {
          const rows = o.attendees.filter((a) => a.tier === sec.tier);
          if (rows.length === 0) return null;
          return (
            <section key={sec.tier} aria-label={sec.title}>
              <h3 className="sub-title">
                {sec.title} <span className="muted">({rows.length})</span>
              </h3>
              {sec.note && <p className="caption" style={{ margin: '0 0 6px' }}>{sec.note}</p>}
              <div className={sec.tier === 'possible' ? 'card-list possible-list' : 'card-list'}>
                {rows.map((a, i) => (
                  <AttendeeRow key={a.personId ?? `g${i}`} a={a} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
