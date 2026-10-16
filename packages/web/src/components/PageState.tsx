import type { ReactNode } from 'react';
import { isApiError } from '../api/client';

/** Loading or error placeholder for a query. */
export function PageState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return <div className="loading">Loading…</div>;
  return (
    <div className="error-box" role="alert">
      <strong>Could not load this.</strong> {(error as Error).message}{' '}
      {onRetry && !(isApiError(error) && error.code === 'SESSION_EXPIRED') && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub != null && <p className="sub">{sub}</p>}
      </div>
      {actions}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
