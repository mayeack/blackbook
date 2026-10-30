import { Link } from 'react-router';
import { useSources } from '../../api/hooks';
import { relativeDay } from '../../lib/format';
import { sourceCardId, sourceIssues } from '../../lib/sources';

/** Integrations that are broken right now (from /sources), above everything else on Today; each links to its card. */
export function IntegrationsBanner() {
  const q = useSources();
  const issues = q.data ? sourceIssues(q.data.sources) : [];
  if (issues.length === 0) return null;
  return (
    <div className="td-alerts" role="region" aria-label="Integrations to fix">
      {issues.map((i) => (
        <div key={i.source} className={`td-alert ${i.severity}`} role={i.severity === 'critical' ? 'alert' : 'status'}>
          <span className="td-alert-mark" aria-hidden>
            ⚠
          </span>
          <div className="td-alert-text">
            <strong>{i.label}</strong> {i.message}
            {i.lastOkAt != null && <span className="td-alert-meta"> · last worked {relativeDay(i.lastOkAt)}</span>}
          </div>
          <div className="td-alert-actions">
            <Link to={`/sources#${sourceCardId(i.source)}`} className="btn btn-sm">
              Fix
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
