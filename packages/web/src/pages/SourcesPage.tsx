import { useSources } from '../api/hooks';
import type { SourceView } from '../api/types';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { SourceTile } from '../components/SourceBadge';
import { date, dateTime, relativeDay } from '../lib/format';
import { sourceLabel, sourceStatus } from '../lib/labels';

const TONE_CLASS = { ok: 'pill pill-ok', warn: 'pill pill-warn', bad: 'pill pill-bad', neutral: 'pill' } as const;

const when = (ms: number | null) => (ms == null ? '—' : `${dateTime(ms)} (${relativeDay(ms)})`);

function SourceCard({ s }: { s: SourceView }) {
  const st = sourceStatus(s.status);
  const top = s.cursors[0];
  return (
    <section className="card source-card" aria-label={sourceLabel(s.source)}>
      <div className="sc-head">
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <SourceTile source={s.source} />
          <h2 style={{ margin: 0 }}>{sourceLabel(s.source)}</h2>
        </span>
        <span className={TONE_CLASS[st.tone]}>{st.label}</span>
      </div>
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
        {top && (
          <>
            <dt>{s.cursorCount > 1 ? `Cursors (${s.cursorCount})` : 'Cursor'}</dt>
            <dd>
              <span className="mono">{top.scope ? `${top.scope}: ` : ''}{top.cursor}</span>
              <span className="muted"> · {relativeDay(top.updatedAt)}</span>
            </dd>
          </>
        )}
        <dt>Checked</dt>
        <dd>{when(s.checkedAt)}</dd>
      </dl>
      {s.lastError && <div className="error-text">{s.lastError}</div>}
    </section>
  );
}

export function SourcesPage() {
  const q = useSources();
  return (
    <>
      <PageHeader title="Sources" sub="Where yeackbot reads from, and how fresh each one is." />
      {!q.data ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.sources.length === 0 ? (
        <div className="card-list">
          <Empty title="No sources have reported yet.">Cards appear once the Mac helper and the ingest jobs check in.</Empty>
        </div>
      ) : (
        <div className="card-grid">
          {q.data.sources.map((s) => (
            <SourceCard key={s.source} s={s} />
          ))}
        </div>
      )}
    </>
  );
}
