/**
 * Pre-event brief (/e/:id/brief; the 3-hour push opens it): who you know there, when you last talked, what's
 * open with each of them, one recent thing about them, guests you don't know yet, and the people who connect you
 * to several of them. Every person is a PersonLink to their page. Read-only.
 */
import { Link, useParams } from 'react-router';
import type { BriefAttendee, EventBrief } from '@yb/shared';
import { isApiError } from '../../api/client';
import { Avatar } from '../../components/Avatar';
import { EntityRow } from '../../components/EntityRow';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { dateTime, plural, span } from '../../lib/format';
import { attendeeSubtitle, loopLine, orderAttendees } from '../../lib/intel';
import { DateTile } from './eventFormat';
import { useBrief } from './intelApi';
import './intel.css';

function AttendeeRow({ a }: { a: BriefAttendee }) {
  const extra = [...a.openLoops.slice(0, 2).map(loopLine), ...(a.recentFact ? [`· ${a.recentFact.value}`] : [])];
  return (
    <EntityRow
      personId={a.person.id}
      className={a.status === 'possible' ? 'possible' : undefined}
      icon={<Avatar id={a.person.id} name={a.person.displayName} />}
      title={a.person.displayName}
      subtitle={
        <>
          {attendeeSubtitle(a)}
          {extra.map((line, i) => (
            <span key={i} className="brief-line">
              {line}
            </span>
          ))}
        </>
      }
      trailing={a.openLoops.length > 0 ? <span className="pill pill-warn">{plural(a.openLoops.length, 'open loop')}</span> : undefined}
    />
  );
}

function FollowUp({ b }: { b: EventBrief }) {
  if (!b.followUp || b.followUp.status === 'none' || b.followUp.status === 'pending') return null;
  return (
    <p className="caption brief-follow">
      {b.followUp.status === 'done' ? 'You followed up after this one ✓' : <Link to="/today">A follow-up is on Today</Link>}
    </p>
  );
}

export function BriefPage() {
  const { id = '' } = useParams();
  const q = useBrief(id);
  const back = (
    <Link to={`/e/${encodeURIComponent(id)}`} className="back-link">
      ‹ Event
    </Link>
  );
  if (q.isPending) return <PageState error={null} />;
  if (q.isError) {
    if (isApiError(q.error) && (q.error.status === 404 || q.error.status === 400))
      return (
        <>
          <p style={{ margin: '0 0 8px' }}>{back}</p>
          <div className="card-list">
            <Empty title="No brief for this one.">Briefs are for social get-togethers with people you know.</Empty>
          </div>
        </>
      );
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const b = q.data;
  const attendees = orderAttendees(b.attendees);
  const withLoops = attendees.filter((a) => a.openLoops.length > 0).length;
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>{back}</p>
      <div className="event-header">
        <DateTile ms={b.startsAt} />
        <div className="eh-text">
          <h1>{b.title ?? 'Get-together'}</h1>
          <div className="eh-line">{b.endsAt ? span(b.startsAt, b.endsAt) : dateTime(b.startsAt)}</div>
          {b.venue && <div className="eh-line">{b.venue}</div>}
          <div className="ev-badges">
            <span className="pill pill-accent">Brief</span>
          </div>
        </div>
      </div>
      <FollowUp b={b} />

      <h2 className="section-title">
        Who you know there · {plural(attendees.length, 'person', 'people')}
        {withLoops > 0 ? ` · ${withLoops} with something open` : ''}
      </h2>
      {attendees.length === 0 ? (
        <div className="card-list">
          <Empty title="No one you know yet.">Attendees show up once RSVPs, the calendar and your messages are matched overnight.</Empty>
        </div>
      ) : (
        <div className="card-list brief-list">
          {attendees.map((a) => (
            <AttendeeRow key={a.person.id} a={a} />
          ))}
        </div>
      )}

      {b.connectors.length > 0 && (
        <>
          <h2 className="section-title">Connectors</h2>
          <p className="caption td-lead">People who link you to several of the guests.</p>
          <div className="card-list">
            {b.connectors.map((c) => (
              <div key={c.person.id} className="entity-row brief-connector">
                <PersonLink id={c.person.id} className="brief-connector-who">
                  <Avatar id={c.person.id} name={c.person.displayName} />
                  <span className="er-title">{c.person.displayName}</span>
                </PersonLink>
                <span className="chips">
                  <span className="caption">knows</span>
                  {c.knows.map((k) => (
                    <PersonLink key={k.id} id={k.id} className="chip">
                      <Avatar id={k.id} name={k.displayName} size={22} />
                      <span>{k.firstName ?? k.displayName}</span>
                    </PersonLink>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {b.unknownGuests.length > 0 && (
        <>
          <h2 className="section-title">Other guests · {b.unknownGuests.length}</h2>
          <p className="caption td-lead">On the guest list, not in your people yet.</p>
          <div className="chips brief-guests">
            {b.unknownGuests.map((n, i) => (
              <span key={`${n}-${i}`} className="chip plain">
                {n}
              </span>
            ))}
          </div>
        </>
      )}
      <p className="caption brief-foot">Built from your messages, events and what yeackbot learned. Nothing here is sent to anyone.</p>
    </>
  );
}
