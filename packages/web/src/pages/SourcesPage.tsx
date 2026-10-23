import { Fragment } from 'react';
import { Link } from 'react-router';
import { useGoogleStatus, useSources } from '../api/hooks';
import type { GoogleStatusView, SourceView } from '../api/types';
import { CalendarSection, FixBox } from '../components/GoogleCalendar';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { SourceTile } from '../components/SourceBadge';
import { date, dateTime, relativeDay } from '../lib/format';
import { channelOf, sourceCardLabel } from '../lib/labels';
import { cardStatus, countRows, googleFix, hasData } from '../lib/sources';
import { useSettings } from './settings/api';
import { normalizeSpend, pct, spendUsd, usd } from './settings/logic';

const TONE_CLASS = { ok: 'pill pill-ok', warn: 'pill pill-warn', bad: 'pill pill-bad', neutral: 'pill' } as const;

const when = (ms: number | null) => (ms == null ? '—' : `${dateTime(ms)} (${relativeDay(ms)})`);

function SourceCard({ s, google }: { s: SourceView; google?: GoogleStatusView }) {
  const st = cardStatus(s);
  const isGoogle = s.source === 'gcal';
  // Gmail and Google Photos are their own Google grants; Settings → Email & photos manages them.
  const isProduct = s.source === 'gmail' || s.source === 'gphotos';
  const fix = isGoogle ? googleFix(s.fix, google) : (s.fix ?? null);
  const reconnect = isGoogle ? google?.needsReconnect : isProduct && s.status === 'auth_required';
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
      {fix && <FixBox fix={fix} reconnect={reconnect} />}
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
      {isProduct && !fix && (
        <p className="caption" style={{ margin: '8px 0 0' }}>
          {s.source === 'gmail' && (s.counts?.tickets ?? 0) > 0 && (
            <>
              <Link to="/tickets">See tickets →</Link>{' '}
            </>
          )}
          <Link to="/settings#email-photos">{s.source === 'gphotos' ? 'Pick screenshots in Settings →' : 'Manage in Settings →'}</Link>
        </p>
      )}
    </section>
  );
}

/** The agent pipeline's cost: Claude spend against the budgets and the prompt-cache hit rate (PLAN "Web app"). */
function PipelineCard() {
  const q = useSettings();
  const env = q.data?.environment;
  const v = q.data?.values;
  if (!env || !v) return null;
  const spend = normalizeSpend(env);
  const claude = !env.llmConfigured ? 'Not set up' : v['llm.enabled'] ? 'On' : 'Off';
  const tone = !env.llmConfigured || !v['llm.enabled'] ? 'pill' : 'pill pill-ok';
  return (
    <section className="card source-card" aria-label="Pipeline cost">
      <div className="sc-head">
        <span className="sc-name">
          <h2 style={{ margin: 0 }}>Pipeline cost</h2>
        </span>
        <span className={tone}>Claude {claude.toLowerCase()}</span>
      </div>
      {spend ? (
        <dl>
          <dt>Today</dt>
          <dd>
            {spendUsd(spend.todayUsd)} of {usd(v['llm.daily_budget_usd'])}
            {spend.requestsToday != null ? ` · ${spend.requestsToday.toLocaleString()} requests` : ''}
          </dd>
          <dt>This month</dt>
          <dd>
            {spendUsd(spend.monthUsd)} of {usd(v['llm.monthly_budget_usd'])}
          </dd>
          {spend.backfillUsd > 0 && (
            <>
              <dt>History backfill</dt>
              <dd>{spendUsd(spend.backfillUsd)}</dd>
            </>
          )}
          {env.llmModel && (
            <>
              <dt>Model</dt>
              <dd>
                {env.llmModel.label}
                {env.llmModel.overriddenRoutes > 0 ? ` · ${env.llmModel.overriddenRoutes} route${env.llmModel.overriddenRoutes === 1 ? '' : 's'} overridden` : ''} · nightly work batched (50% off)
              </dd>
            </>
          )}
          <dt>Cache hit rate</dt>
          <dd>{spend.cacheHitRate == null ? '— (no requests in the last 7 days)' : `${pct(spend.cacheHitRate)} of input tokens, last 7 days`}</dd>
        </dl>
      ) : (
        <p className="caption">Spend isn’t reported by this server.</p>
      )}
      {!env.llmConfigured && <p className="caption">Without an API key the agent runs on rules and templates only; nothing is sent to Claude.</p>}
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
      <h2 className="section-title">Agent pipeline</h2>
      <PipelineCard />
    </>
  );
}
