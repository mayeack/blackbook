import type { EvalMetric } from '@yb/shared';
import { isNotImplemented } from '../../../api/hooks';
import { Empty, PageState } from '../../../components/PageState';
import { dateTime } from '../../../lib/format';
import { useEvalReport } from '../api';
import { metricLabel, metricPass, metricText, SET_LABELS } from './logic';

function MetricTable({ metrics }: { metrics: EvalMetric[] }) {
  if (metrics.length === 0) return <p className="caption">No metrics yet.</p>;
  return (
    <div className="st-metrics" role="table">
      <div className="st-metric head" role="row">
        <span role="columnheader">Metric</span>
        <span role="columnheader">Value</span>
        <span role="columnheader">Target</span>
        <span role="columnheader">n</span>
      </div>
      {metrics.map((m) => {
        const pass = metricPass(m);
        return (
          <div key={m.name} className="st-metric" role="row">
            <span role="cell" className="st-metric-name">
              {metricLabel(m.name)}
            </span>
            <span role="cell" className={pass == null ? 'st-metric-val' : pass ? 'st-metric-val ok' : 'st-metric-val bad'}>
              {metricText(m)}
              {pass != null && <span className="sr-only">{pass ? ' (passes)' : ' (below target)'}</span>}
            </span>
            <span role="cell" className="st-metric-target">
              {m.higherIsBetter ? '≥' : '≤'} {metricText(m, m.target)}
            </span>
            <span role="cell" className="st-metric-n">
              {m.n}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The eval report: offline metrics per golden set against the targets, plus online signals. */
export function EvalReportView() {
  const q = useEvalReport(true);
  if (!q.data) {
    if (isNotImplemented(q.error))
      return (
        <div className="card-list">
          <Empty title="The report isn’t available on this server yet." />
        </div>
      );
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const r = q.data;
  return (
    <>
      <p className="caption st-lead">
        Generated {dateTime(r.generatedAt)}
        {r.promptVersions.length ? ` · prompts ${r.promptVersions.join(', ')}` : ''}. Thresholds change only by hand, after checking this report.
      </p>
      {r.sets.map((s) => (
        <section key={s.set}>
          <h2 className="section-title">
            {SET_LABELS[s.set]} <span className="st-count">· {s.labeled} labeled</span>
          </h2>
          <div className="card st-card">
            <MetricTable metrics={s.metrics} />
          </div>
        </section>
      ))}
      <h2 className="section-title">Online (from your feedback)</h2>
      <div className="card st-card">
        <MetricTable metrics={r.online} />
      </div>
    </>
  );
}
