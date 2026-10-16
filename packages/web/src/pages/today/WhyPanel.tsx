import { Link } from 'react-router';
import type { EvidenceRef } from '@yb/shared';
import { PageState } from '../../components/PageState';
import { dateTime, percent } from '../../lib/format';
import { sourceLabel } from '../../lib/labels';
import { useWhy } from './api';
import { armLabel, factorText } from './logic';

/** Evidence chips: label, date and a short quote, linking to where it came from (relative app paths only). */
export function EvidenceList({ items }: { items: EvidenceRef[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="td-evidence">
      {items.map((e) => {
        // The label already carries the date ("iMessage · Oct 3"); build one only when there's none.
        const meta = e.label ?? [e.source ? sourceLabel(e.source) : null, e.at != null ? dateTime(e.at) : null].filter(Boolean).join(' · ');
        const body = (
          <>
            {meta && <span className="td-ev-meta">{meta}</span>}
            {e.quote && <q className="td-ev-quote">{e.quote}</q>}
          </>
        );
        return (
          <li key={`${e.kind}:${e.ref}`}>
            {e.href && e.href.startsWith('/') && !e.href.startsWith('//') ? (
              <Link to={e.href} className="td-ev-link">
                {body}
              </Link>
            ) : (
              <span className="td-ev-link">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Why this?": the cadence numbers, what the ranker learned, adjustments and the evidence. */
export function WhyPanel({ suggestionId }: { suggestionId: string }) {
  const q = useWhy(suggestionId, true);
  if (!q.data) return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  const w = q.data;
  return (
    <div className="td-why">
      <p className="td-why-summary">{w.summary}</p>
      {w.signals.length > 0 && (
        <dl className="td-kv">
          {w.signals.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {w.factors.length > 0 && (
        <>
          <h4 className="td-why-h">What I’ve learned</h4>
          <ul className="td-factors">
            {w.factors.map((f) => {
              const t = factorText(f.value);
              return (
                <li key={`${f.arm}:${f.label}`}>
                  <span className="td-f-label">
                    <span className="muted">{armLabel(f.arm)}:</span> {f.label}
                  </span>
                  <span className="td-f-meta">
                    {percent(f.propensity)} acted · n {Math.round(f.n)}
                  </span>
                  <span className={`td-f-val ${t.dir}`}>{t.text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {w.adjustments.length > 0 && (
        <>
          <h4 className="td-why-h">Adjustments</h4>
          <dl className="td-kv">
            {w.adjustments.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {w.evidence.length > 0 && (
        <>
          <h4 className="td-why-h">Evidence</h4>
          <EvidenceList items={w.evidence} />
        </>
      )}
      <p className="caption td-why-score">
        Base {w.base.toFixed(2)} → score {w.score.toFixed(2)}
      </p>
    </div>
  );
}
