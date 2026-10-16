import { Link } from 'react-router';
import type { Alert } from '@yb/shared';
import { useToast } from '../../components/Toast';
import { relativeDay } from '../../lib/format';
import { useDismissAlert } from './api';
import { alertSourceLabel, sortAlerts } from './logic';

/** Open alerts (source health, pipeline, budget): most severe first, each with its fix link and Dismiss. */
export function AlertsBanner({ alerts }: { alerts: readonly Alert[] }) {
  const dismiss = useDismissAlert();
  const toast = useToast();
  const open = sortAlerts(alerts);
  if (open.length === 0) return null;
  return (
    <div className="td-alerts" role="region" aria-label="Alerts">
      {open.map((a) => (
        <div key={a.id} className={`td-alert ${a.severity}`} role={a.severity === 'critical' ? 'alert' : 'status'}>
          <span className="td-alert-mark" aria-hidden>
            {a.severity === 'info' ? 'ℹ' : '⚠'}
          </span>
          <div className="td-alert-text">
            <strong>{alertSourceLabel(a.source)}</strong> {a.message}
            <span className="td-alert-meta"> · since {relativeDay(a.openedAt)}</span>
          </div>
          <div className="td-alert-actions">
            {a.href && a.href.startsWith('/') && !a.href.startsWith('//') && (
              <Link to={a.href} className="btn btn-sm">
                Fix
              </Link>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={dismiss.isPending && dismiss.variables === a.id}
              onClick={() =>
                dismiss.mutate(a.id, {
                  onSuccess: () => toast('Dismissed. It comes back if the problem does.'),
                  onError: (e) => toast(e.message, 'error'),
                })
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
