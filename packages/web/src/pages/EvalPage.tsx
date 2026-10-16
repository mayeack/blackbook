/**
 * Settings → Eval (/settings/eval): label the golden sets (intelligence §8: G1 extraction, G2 identity, G3 reply
 * debt, G4 ask) and read the report. Items are the owner's own data on his own server; nothing here goes to the LLM.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import type { EvalSet } from '@yb/shared';
import { isNotImplemented } from '../api/hooks';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { useEvalItems } from './settings/api';
import { EvalItemCard } from './settings/eval/EvalItemCard';
import { EvalReportView } from './settings/eval/EvalReportView';
import { progress, SET_LABELS, SETS } from './settings/eval/logic';
import './settings/settings.css';

type Status = 'unlabeled' | 'labeled' | 'all';

function Labeler() {
  const [set, setSet] = useState<EvalSet | null>(null);
  const [status, setStatus] = useState<Status>('unlabeled');
  const q = useEvalItems(set, status);
  const counts = q.data?.pages[0]?.counts ?? [];

  return (
    <>
      {counts.length > 0 && (
        <div className="card st-card st-progress">
          {counts.map((c) => (
            <div key={c.set} className="st-prog-row">
              <span className="st-prog-name">{SET_LABELS[c.set]}</span>
              <span className="st-bar" aria-hidden>
                <span style={{ width: `${Math.round(progress(c) * 100)}%` }} />
              </span>
              <span className="caption st-prog-num">
                {c.labeled}/{c.target}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="filter-chips" role="group" aria-label="Golden set">
        <button type="button" className="chip plain" aria-pressed={set == null} onClick={() => setSet(null)}>
          All sets
        </button>
        {SETS.map((s) => (
          <button key={s} type="button" className="chip plain" aria-pressed={set === s} onClick={() => setSet(s)}>
            {SET_LABELS[s]}
          </button>
        ))}
      </div>
      <div className="segmented" role="tablist" aria-label="Which items">
        {(['unlabeled', 'labeled', 'all'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>
            {s === 'unlabeled' ? 'To label' : s === 'labeled' ? 'Labeled' : 'All'}
          </button>
        ))}
      </div>

      {!q.data ? (
        isNotImplemented(q.error) ? (
          <div className="card-list">
            <Empty title="Eval isn’t available on this server yet." />
          </div>
        ) : (
          <PageState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : (
        (() => {
          const items = q.data.pages.flatMap((p) => p.items);
          if (items.length === 0)
            return (
              <div className="card-list">
                <Empty title={status === 'unlabeled' ? 'Nothing left to label here.' : 'No items.'}>
                  {status === 'unlabeled' ? 'New items are sampled from recent runs.' : null}
                </Empty>
              </div>
            );
          return (
            <div className="st-eval-list">
              {items.map((i) => (
                <EvalItemCard key={`${i.id}:${i.label?.labeledAt ?? 0}`} item={i} />
              ))}
              {q.hasNextPage && (
                <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
                </button>
              )}
            </div>
          );
        })()
      )}
    </>
  );
}

export function EvalPage() {
  const [tab, setTab] = useState<'label' | 'report'>('label');
  return (
    <>
      <Link to="/settings" className="back-link">
        ‹ Settings
      </Link>
      <PageHeader title="Eval" sub="Label a small golden set so changes to the agent can be measured." />
      <div className="segmented" role="tablist" aria-label="Eval">
        <button type="button" role="tab" aria-selected={tab === 'label'} onClick={() => setTab('label')}>
          Label
        </button>
        <button type="button" role="tab" aria-selected={tab === 'report'} onClick={() => setTab('report')}>
          Report
        </button>
      </div>
      {tab === 'label' ? <Labeler /> : <EvalReportView />}
    </>
  );
}
