import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { isNotImplemented } from '../../api/hooks';
import { PageState } from '../../components/PageState';
import './ui.css';

/**
 * One person-page section backed by its own query: a title, then loading / "not available yet" (501) / error /
 * content. A failing section never takes the rest of the page down. `hideWhenUnavailable` drops the whole section
 * (title too) while its API hasn't landed.
 */
export function QuerySection<T>({
  title,
  query,
  unavailable,
  hideWhenUnavailable,
  actions,
  children,
}: {
  title: ReactNode;
  query: UseQueryResult<T, unknown>;
  /** Shown for a 501. */
  unavailable?: ReactNode;
  hideWhenUnavailable?: boolean;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const notBuilt = query.isError && isNotImplemented(query.error);
  if (notBuilt && hideWhenUnavailable) return null;
  return (
    <section className="person-section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {query.data !== undefined && actions}
      </div>
      {query.data !== undefined ? (
        children(query.data)
      ) : notBuilt ? (
        <p className="caption">{unavailable ?? 'Not available yet.'}</p>
      ) : query.isError ? (
        <PageState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <p className="caption muted">Loading…</p>
      )}
    </section>
  );
}
