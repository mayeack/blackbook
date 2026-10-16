import { Fragment } from 'react';
import { useGoogleStatus, useSources } from '../api/hooks';
import type { GoogleStatusView, SourceView } from '../api/types';
import { CalendarSection, FixBox } from '../components/GoogleCalendar';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { SourceTile } from '../components/SourceBadge';
import { date, dateTime, relativeDay } from '../lib/format';
import { channelOf, sourceCardLabel } from '../lib/labels';
import { cardStatus, countRows, googleFix, hasData } from '../lib/sources';

const TONE_CLASS = { ok: 'pill pill-ok', warn: 'pill pill-warn', bad: 'pill pill-bad', neutral: 'pill' } as const;

const when = (ms: number | null) => (ms == null ? '—' : `${dateTime(ms)} (${relativeDay(ms)})`);

function SourceCard({ s, google }: { s: SourceView; google?: GoogleStatusView }) {
  const st = cardStatus(s);
  const isGoogle = s.source === 'gcal';
  const fix = isGoogle ? googleFix(s.fix, google) : (s.fix ?? null);
  const rows = countRows(s.counts);
  const top = s.cursors[0];
  const seen = hasData(s) || s.checkedAt != null;
  return (
    <section className="card source-card" aria-label={sourceCardLabel(s.source)}>
      <div className="sc-head">
        <span className="sc-name">
          <SourceTile source={channelOf(s.source)} />
          <h2 style={{ margin: 0 }}>{sourceCardLabel(s.source)}</h2>
        </span>
        <span className={TONE_CLASS[st.tone]}>{st.label}</span>
      </div>
      {fix && <FixBox fix={fix} reconnect={isGoogle && google?.needsReconnect} />}
      {seen && (
        <dl>
          <dt>Last success</dt>
          <dd>{when(s.lastOkAt)}</dd>
          <dt>Newest data</dt>
          <dd>{when(s.newestDataAt)}</dd>
          {s.messages && (
            <>
              <dt>Messages</dt>
              <dd>
                {s.messages.last24h.toLocaleString()} today · {s.messages.last7d.toLocaleString()} this week · {s.messages.total.toLocaleString()} total
              </dd>
              <dt>Oldest data</dt>
              <dd>{s.messages.oldestAt == null ? '—' : date(s.messages.oldestAt)}</dd>
            </>
          )}
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </Fragment>
          ))}
          {top && (
            <>
              <dt>{s.cursorCount > 1 ? `Cursors (${s.cursorCount})` : 'Cursor'}</dt>
              <dd>
                <span className="mono">
                  {top.scope ? `${top.scope}: ` : ''}
                  {top.cursor}
                </span>
                <span className="muted"> · {relativeDay(top.updatedAt)}</span>
              </dd>
            </>
          )}
          <dt>Checked</dt>
          <dd>{when(s.checkedAt)}</dd>
        </dl>
      )}
      {s.lastError && <div className="error-text">{s.lastError}</div>}
      {isGoogle && google?.connected && <CalendarSection g={google} />}
    </section>
  );
}

export function SourcesPage() {
  const q = useSources();
  // Optional: a server without the Google routes answers 501 and the card falls back to its health row.
  const google = useGoogleStatus();
  return (
    <>
      <PageHeader title="Sources" sub="Where yeackbot reads from, how fresh each one is, and what needs you." />
      {!q.data ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.sources.length === 0 ? (
        <div className="card-list">
          <Empty title="No sources have reported yet.">Cards appear once the Mac helper and the ingest jobs check in.</Empty>
        </div>
      ) : (
        <div className="card-grid">
          {q.data.sources.map((s) => (
            <SourceCard key={s.source} s={s} google={s.source === 'gcal' ? google.data : undefined} />
          ))}
        </div>
      )}
    </>
  );
}
