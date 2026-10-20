import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { usePeople } from '../api/hooks';
import type { PeopleSort, PersonListItem } from '../api/types';
import { Avatar } from '../components/Avatar';
import { EntityRow } from '../components/EntityRow';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { SourceBadges } from '../components/SourceBadge';
import { plural, relativeDay, roleLine } from '../lib/format';
import { stateLabel } from '../lib/labels';

const SORTS: { value: PeopleSort; label: string }[] = [
  { value: 'last', label: 'Last name' },
  { value: 'recent', label: 'Recent' },
  { value: 'added', label: 'Added' },
  { value: 'close', label: 'Closest' },
];
const isSort = (s: string | null): s is PeopleSort => SORTS.some((x) => x.value === s);

/** Value that follows `value` after `ms` of quiet. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function subtitle(p: PersonListItem, sort: PeopleSort): string | null {
  if (sort === 'recent') return p.lastAt ? `Last contact ${relativeDay(p.lastAt)}` : 'No contact yet';
  return roleLine(p.jobTitle, p.company) ?? p.handle;
}

function PersonRow({ p, sort }: { p: PersonListItem; sort: PeopleSort }) {
  return (
    <EntityRow
      personId={p.id}
      icon={<Avatar id={p.id} name={p.displayName} />}
      title={
        <>
          {p.displayName}
          {p.isPriority && (
            <span className="star" aria-label="Priority">
              {' '}
              ★
            </span>
          )}
          {p.status === 'provisional' && <span className="pill pill-accent new-badge">New</span>}
        </>
      }
      subtitle={subtitle(p, sort)}
      trailing={
        <>
          <SourceBadges sources={p.sources} max={2} />
          <span className="closeness-score" title={`Closeness ${p.closeness} of 10 (1 acquaintance, 10 closest)`} aria-label={`Closeness ${p.closeness} of 10`}>
            {p.closeness}
          </span>
          {p.state && <span className={`state-dot ${p.state}`} title={stateLabel(p.state)} aria-label={stateLabel(p.state)} />}
        </>
      }
    />
  );
}

export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const sortParam = params.get('sort');
  const sort: PeopleSort = isSort(sortParam) ? sortParam : 'last';
  const q = useDebounced(text.trim(), 200);

  // Keep q/sort in the URL so Back restores the list as it was.
  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [q, setParams]);

  const query = usePeople(q, sort);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.isPlaceholderData ? undefined : query.data?.pages[0]?.total;

  // The window scrolls (not an inner box), so the virtualizer needs the list's offset from the page top.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
  }, [hasItems]);

  const virtualizer = useWindowVirtualizer({
    count: items.length + (query.hasNextPage ? 1 : 0),
    estimateSize: () => 57,
    overscan: 10,
    scrollMargin,
    getItemKey: (i) => items[i]?.id ?? `loader-${i}`,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= items.length - 25) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastIndex, items.length]);

  return (
    <>
      <PageHeader title="People" sub={total != null ? plural(total, q ? 'match' : 'person', q ? 'matches' : 'people') : undefined} />
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Search names, companies, handles"
          aria-label="Search people"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          className="input"
          aria-label="Sort"
          value={sort}
          onChange={(e) =>
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                if (e.target.value === 'last') next.delete('sort');
                else next.set('sort', e.target.value);
                return next;
              },
              { replace: true },
            )
          }
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {query.isPending ? (
        <PageState error={null} />
      ) : query.isError && items.length === 0 ? (
        <PageState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <div className="card-list">
          <Empty title={q ? 'No one matches that search.' : 'No people yet.'}>
            {q ? 'Try part of a first name, a company or an @handle.' : 'People appear here once a source has been ingested.'}
          </Empty>
        </div>
      ) : (
        <div className="card-list" style={{ opacity: query.isPlaceholderData ? 0.6 : 1 }}>
          <div ref={listRef} className="vlist" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((v) => {
              const p = items[v.index];
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="vrow"
                  style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
                >
                  {p ? <PersonRow p={p} sort={sort} /> : <div className="loading">Loading more…</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
