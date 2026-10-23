/**
 * Tickets: the shows and events the owner has (or had) tickets for, from his ticket emails (GET /tickets; the Gmail
 * ledger). Upcoming / Past, event-card style: when and where, a status pill (holding, sold, gave away, …), how many
 * are held and how they moved, and "Met here" chips for people yeackbot thinks he met there. A card links to its
 * get-together page when the ticket feeds one.
 */
import { Link, useSearchParams } from 'react-router';
import type { TicketItem } from '@yb/shared';
import { isNotImplemented, useGmailStatus, useTickets } from '../../api/hooks';
import { Avatar } from '../../components/Avatar';
import { Icons } from '../../components/icons';
import { Empty, PageHeader, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { ticketStatus } from '../../lib/labels';
import { flattenTickets, performersLine, ticketCountsLine, ticketHref, ticketKindLine, ticketPlace, ticketsWhen, ticketWhen, type TicketsWhen } from '../../lib/tickets';
import { DateTile } from './eventFormat';

const TONE_CLASS = { ok: 'pill pill-ok', warn: 'pill pill-warn', bad: 'pill pill-bad', neutral: 'pill' } as const;

function TicketHead({ t }: { t: TicketItem }) {
  const place = ticketPlace(t);
  const performers = performersLine(t);
  const body = (
    <>
      <DateTile ms={t.startsAt} />
      <span className="er-text">
        <span className="ev-title">{t.title}</span>
        <span className="ev-meta">
          {ticketWhen(t)}
          {place ? ` · ${place}` : ''}
        </span>
        {performers && <span className="ev-meta">{performers}</span>}
      </span>
    </>
  );
  const href = ticketHref(t);
  return href ? (
    <Link to={href} className="ev-head">
      {body}
      <span className="chevron">{Icons.chevron}</span>
    </Link>
  ) : (
    <div className="ev-head">{body}</div>
  );
}

function TicketCard({ t }: { t: TicketItem }) {
  const st = ticketStatus(t.status);
  const extra = t.metHereCount - t.metHere.length;
  return (
    <article className="event-card ticket-card" aria-label={t.title}>
      <TicketHead t={t} />
      <div className="ev-badges">
        <span className={TONE_CLASS[st.tone]}>{st.label}</span>
        <span className="pill">{ticketKindLine(t)}</span>
      </div>
      <div className="ticket-counts">{ticketCountsLine(t)}</div>
      {t.metHere.length > 0 && (
        <div className="chips ev-people" aria-label="Met here">
          <span className="met-here-label">Met here</span>
          {t.metHere.map((p) => (
            <PersonLink key={p.id} id={p.id} className="chip">
              <Avatar id={p.id} name={p.displayName} size={22} />
              <span>{p.displayName}</span>
            </PersonLink>
          ))}
          {extra > 0 && <span className="chip plain more-chip">+{extra}</span>}
        </div>
      )}
      <div className="ev-foot-gap" />
    </article>
  );
}

const TABS: { value: TicketsWhen; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];

export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const when = ticketsWhen(params);
  const q = useTickets(when);
  const gmail = useGmailStatus();
  const items = flattenTickets(q.data?.pages ?? []);
  const notConnected = gmail.data != null && !gmail.data.connected;

  const setWhen = (w: TicketsWhen) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (w === 'upcoming') next.delete('when');
        else next.set('when', w);
        return next;
      },
      { replace: true },
    );

  const connectHint = notConnected && (
    <p className="caption">
      Connect Gmail in <Link to="/settings#email-photos">Settings → Email &amp; photos</Link> so yeackbot can read your ticket emails.
    </p>
  );

  return (
    <>
      <PageHeader
        title="Tickets"
        sub={
          <>
            Shows and events you have tickets for, from your email. <Link to="/events">Events →</Link>
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
            <Empty title="Tickets aren’t available yet.">They appear once the Gmail ticket source is running.</Empty>
          </div>
        ) : (
          <PageState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : items.length === 0 && !q.hasNextPage ? (
        <div className="card-list">
          {when === 'upcoming' ? (
            <Empty title="No tickets coming up.">{connectHint || 'Ticket and registration emails show up here with who you met there.'}</Empty>
          ) : (
            <Empty title="No past tickets yet.">{connectHint || 'Once your ticket emails are read, past shows appear here.'}</Empty>
          )}
        </div>
      ) : (
        <div className="event-list">
          {items.map((t) => (
            <TicketCard key={t.id} t={t} />
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
