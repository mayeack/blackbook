/**
 * Today (delivery §2): date + delivery status → alerts → today's digest cards → Open loops → Check these →
 * "What the agent did". Works before the agent loop exists: if /today isn't available the brief says so and the
 * activity feed still shows.
 */
import { Link } from 'react-router';
import type { TodayResponse } from '@yb/shared';
import { isNotImplemented } from '../api/hooks';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { time } from '../lib/format';
import { ActivityFeed } from './today/ActivityFeed';
import { AlertsBanner } from './today/Alerts';
import { useAlerts, useToday } from './today/api';
import { CheckThese } from './today/CheckThese';
import { DigestCard } from './today/DigestCard';
import { deliveryLine, isOpen } from './today/logic';
import { OpenLoopsStrip } from './today/OpenLoops';
import './today/today.css';

const fmtDay = (d: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(d);

/** The server's local day (`YYYY-MM-DD` in the tz setting) as "Thursday, October 16". */
function dayLabel(localDate: string | undefined): string {
  const m = localDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate) : null;
  return fmtDay(m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date());
}

function Brief({ t }: { t: TodayResponse }) {
  const open = t.items.filter(isOpen);
  if (t.items.length === 0)
    return (
      <div className="card-list">
        {t.allClear ? (
          <Empty title="Nothing needs you today.">{t.activity.line ?? 'All clear. The agent keeps watching your sources overnight.'}</Empty>
        ) : (
          <Empty title="No brief yet today.">{t.digest?.status === 'composing' ? 'It’s being written now.' : 'It appears here after the morning run.'}</Empty>
        )}
      </div>
    );
  return (
    <>
      {open.length === 0 && <p className="td-all-done">All done for today ✓</p>}
      <div className="td-cards">
        {t.items.map((i) => (
          <DigestCard key={i.suggestionId} item={i} />
        ))}
      </div>
      {t.digest?.imessage === 'disabled' && (
        <p className="caption td-hint">
          The daily text is off, so this brief lives here only. <Link to="/settings/digest">Digest settings</Link>
        </p>
      )}
    </>
  );
}

export function TodayPage() {
  const q = useToday();
  const t = q.data;
  const fallbackAlerts = useAlerts(q.isError);
  const line = t ? deliveryLine(t.digest, time) : null;
  return (
    <>
      <PageHeader
        title="Today"
        sub={
          <>
            {dayLabel(t?.date)}
            {line && (
              <>
                {' · '}
                <span className={`td-delivery ${line.tone}`}>{line.text}</span>
              </>
            )}
          </>
        }
      />
      <AlertsBanner alerts={t ? t.alerts : (fallbackAlerts.data?.alerts ?? [])} />

      <h2 className="section-title">Your brief</h2>
      {t ? (
        <Brief t={t} />
      ) : isNotImplemented(q.error) ? (
        <div className="card-list">
          <Empty title="Nothing needs you today.">The daily brief appears here once the agent loop is on.</Empty>
        </div>
      ) : (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      )}

      {t && <OpenLoopsStrip counts={t.openLoops.counts} preview={t.openLoops.preview} />}
      {t && <CheckThese items={t.checkThese} />}

      <h2 className="section-title">What the agent did</h2>
      {t?.activity.line && <p className="caption td-lead">{t.activity.line}</p>}
      <ActivityFeed />
    </>
  );
}
