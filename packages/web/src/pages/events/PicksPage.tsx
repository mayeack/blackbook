/**
 * Event picks: the latest week of events yeackbot found for the owner's free nights on the web, in his event
 * newsletters and on his Recurring Events calendar (GET /event-picks; the same picks the weekly email or texts send).
 * One card per pick in the email's order: when and where, why it was picked, where it came from, a 🎲 pill for the
 * wildcard, the ticket link (/go/<id>, which counts the tap and redirects), and his answer: "I’m going" / "Not for me"
 * teach the ranker, Undo takes his own answer back. Picks yeackbot settled itself (a ticket email, calendar entry or
 * Partiful RSVP it found) say so on the Going pill.
 */
import { Link } from 'react-router';
import type { EventPickItem, EventPicksWeek } from '@yb/shared';
import { isNotImplemented, useEventPicks, usePickFeedback, type PickFeedbackVars } from '../../api/hooks';
import { Empty, PageHeader, PageState } from '../../components/PageState';
import { historyLine, localDayMs, pickActions, pickLink, pickMeta, pickSource, pickStatus, sortPicks, weekLine } from '../../lib/picks';
import { performersLine, ticketKindLine } from '../../lib/tickets';
import { DateTile } from './eventFormat';

const TONE_CLASS = { ok: 'pill pill-ok', neutral: 'pill' } as const;

type Verdict = PickFeedbackVars['verdict'];

/** One pick. Presentational: the page wires `onVerdict` to the feedback POST. */
export function PickCard({ p, onVerdict, busy = false }: { p: EventPickItem; onVerdict: (v: Verdict) => void; busy?: boolean }) {
  const performers = performersLine(p);
  const status = pickStatus(p);
  const link = pickLink(p);
  const actions = pickActions(p);
  const meta = pickMeta(p);
  const source = pickSource(p);
  return (
    <article className="event-card pick-card" aria-label={p.title}>
      <div className="ev-head">
        <DateTile ms={localDayMs(p.localDate, p.startTime)} />
        <span className="er-text">
          <span className="ev-title">{p.title}</span>
          {meta && <span className="ev-meta">{meta}</span>}
          {performers && <span className="ev-meta">{performers}</span>}
        </span>
      </div>
      <div className="ev-badges">
        {status && <span className={TONE_CLASS[status.tone]}>{status.label}</span>}
        {p.wildcard && <span className="pill pill-accent">🎲 Something different</span>}
        {source && <span className="pill">{source}</span>}
        {(p.source !== 'calendar' || p.linkKind) && <span className="pill">{ticketKindLine(p)}</span>}
      </div>
      {p.why && <p className="pick-why">{p.why}</p>}
      {(link || actions.answer || actions.undo) && (
        <div className="pick-actions">
          {link && (
            <a className="btn btn-sm btn-primary" href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          )}
          {actions.answer && (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onVerdict('going')}>
                I’m going
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onVerdict('not_for_me')}>
                Not for me
              </button>
            </>
          )}
          {actions.undo && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onVerdict('undo')}>
              Undo
            </button>
          )}
        </div>
      )}
      <div className="ev-foot-gap" />
    </article>
  );
}

function Week({ week }: { week: EventPicksWeek }) {
  const feedback = usePickFeedback();
  const picks = sortPicks(week.picks);
  return (
    <>
      <p className="picks-week">{weekLine(week)}</p>
      {picks.length === 0 ? (
        <div className="card-list">
          <Empty title="No picks this week.">Nothing on the web, in your newsletters or on your Recurring Events calendar fit your free nights.</Empty>
        </div>
      ) : (
        <div className="event-list">
          {picks.map((p) => (
            <PickCard
              key={p.id}
              p={p}
              busy={feedback.isPending && feedback.variables?.id === p.id}
              onVerdict={(verdict) => feedback.mutate({ id: p.id, verdict })}
            />
          ))}
        </div>
      )}
    </>
  );
}

const SettingsLink = () => <Link to="/settings/agent">Settings → Agent</Link>;

export function PicksPage() {
  const q = useEventPicks();
  const data = q.data;
  const history = data ? historyLine(data.history) : null;

  return (
    <>
      <PageHeader
        title="Event picks"
        sub={
          <>
            Events on your free nights, from the web, your newsletters and your Recurring Events calendar. Get tickets and yeackbot notices.{' '}
            <Link to="/events">Events →</Link>
          </>
        }
      />
      {q.isPending ? (
        <PageState error={null} />
      ) : !data ? (
        isNotImplemented(q.error) ? (
          <div className="card-list">
            <Empty title="Event picks aren’t available yet.">They appear once the weekly picks job is running.</Empty>
          </div>
        ) : (
          <PageState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : !data.week ? (
        <div className="card-list">
          {data.enabled ? (
            <Empty title="No picks yet.">They arrive once a week.</Empty>
          ) : (
            <Empty title="Weekly event picks are off.">
              Turn them on in <SettingsLink />.
            </Empty>
          )}
        </div>
      ) : (
        <>
          {!data.enabled && (
            <p className="caption picks-off">
              Weekly event picks are off. Turn them on in <SettingsLink />.
            </p>
          )}
          <Week week={data.week} />
        </>
      )}
      {history && <p className="caption picks-history">{history}</p>}
    </>
  );
}
