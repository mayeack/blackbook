import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { NetworkGraph, NetworkNode } from '@yb/shared';
import { isNotImplemented } from '../api/hooks';
import { Avatar } from '../components/Avatar';
import { EntityRow } from '../components/EntityRow';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { PersonLink, personPath } from '../components/PersonLink';
import { plural } from '../lib/format';
import { stateLabel } from '../lib/labels';
import { useNetwork } from './network/api';
import {
  circleColors,
  DEFAULT_FILTERS,
  edgeColor,
  edgeTypeChip,
  filtersToParams,
  parseFilters,
  searchNodes,
  STRENGTH_STEPS,
  topNeighbors,
  WINDOWS,
  type NetworkFilters,
} from './network/logic';
import './network/network.css';

type View = 'graph' | 'list';

/** sigma + graphology + ForceAtlas2 load with the map only (their own chunk). */
const GraphCanvas = lazy(() => import('./network/GraphCanvas').then((m) => ({ default: m.GraphCanvas })));

const CanvasFallback = () => (
  <div className="net-canvas-wrap">
    <div className="net-canvas net-canvas-loading">
      <span className="caption">Loading the map…</span>
    </div>
  </div>
);

function Filters({ f, data, onChange }: { f: NetworkFilters; data: NetworkGraph | undefined; onChange: (next: NetworkFilters) => void }) {
  const [open, setOpen] = useState(false);
  const types = data?.edgeTypes ?? [];
  const active = (f.circle ? 1 : 0) + (f.types.length ? 1 : 0) + (f.minStrength !== DEFAULT_FILTERS.minStrength ? 1 : 0) + (f.includeMe ? 1 : 0);
  return (
    <div className="net-filters">
      <div className="net-filter-bar">
        <div className="segmented net-window" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.value} type="button" aria-selected={f.window === w.value} onClick={() => onChange({ ...f, window: w.value })}>
              {w.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Filters{active ? ` · ${active}` : ''}
        </button>
      </div>
      {open && (
        <div className="card net-filter-panel">
          <label className="field">
            <span className="caption">Circle</span>
            <select className="input input-sm" value={f.circle ?? ''} onChange={(e) => onChange({ ...f, circle: e.target.value || null })}>
              <option value="">Everyone</option>
              {(data?.circles ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon ? `${c.icon} ` : ''}
                  {c.name} ({c.size}){c.kind === 'auto' ? ' · auto' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="caption">Minimum strength · {Math.round(f.minStrength * 100)}%</span>
            <input
              type="range"
              min={0}
              max={STRENGTH_STEPS.length - 1}
              step={1}
              value={Math.max(0, STRENGTH_STEPS.findIndex((s) => s >= f.minStrength - 1e-9))}
              onChange={(e) => onChange({ ...f, minStrength: STRENGTH_STEPS[Number(e.target.value)] ?? DEFAULT_FILTERS.minStrength })}
              aria-valuetext={`${Math.round(f.minStrength * 100)}%`}
            />
          </label>
          {types.length > 0 && (
            <div className="field">
              <span className="caption">Connected through</span>
              <div className="filter-chips" role="group" aria-label="Edge sources">
                {types
                  .filter((t) => t !== 'tie')
                  .map((t) => {
                    const on = f.types.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        className="chip plain"
                        aria-pressed={on}
                        onClick={() => onChange({ ...f, types: on ? f.types.filter((x) => x !== t) : [...f.types, t] })}
                      >
                        <span className="edge-swatch" style={{ background: edgeColor(t) }} aria-hidden />
                        <span>{edgeTypeChip(t)}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
          <label className="check-line">
            <input type="checkbox" checked={f.includeMe} onChange={(e) => onChange({ ...f, includeMe: e.target.checked })} />
            <span>Show me in the middle (links everyone to you)</span>
          </label>
          {active > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange({ ...DEFAULT_FILTERS, window: f.window })}>
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NodeSheet({ g, id, onClose }: { g: NetworkGraph; id: string; onClose: () => void }) {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return null;
  const circles = new Map(g.circles.map((c) => [c.id, c]));
  const colors = circleColors(g.circles);
  const top = topNeighbors(g, id, 4);
  if (node.isMe)
    return (
      <div className="net-sheet" role="dialog" aria-label="You">
        <div className="net-sheet-head">
          <strong>You</strong>
          <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="caption">Lines from you show how strong each tie is.</p>
      </div>
    );
  return (
    <div className="net-sheet" role="dialog" aria-label={node.label}>
      <div className="net-sheet-head">
        <PersonLink id={node.id} className="net-sheet-person">
          <Avatar id={node.id} name={node.label} size={44} />
          <span className="er-text">
            <span className="er-title">{node.label}</span>
            <span className="er-subtitle">
              {[node.state ? stateLabel(node.state) : null, node.tieStrength != null ? `tie ${Math.round(node.tieStrength)}` : null, plural(node.degree, 'connection')]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </PersonLink>
        <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {node.circleIds.length > 0 && (
        <div className="chips net-sheet-row">
          {node.circleIds.slice(0, 4).map((cid) => {
            const c = circles.get(cid);
            if (!c) return null;
            return (
              <Link key={cid} to={`/c/${encodeURIComponent(cid)}`} className="chip plain">
                <span className="coll-dot" style={{ background: colors.get(cid) }} aria-hidden />
                <span>{c.name}</span>
              </Link>
            );
          })}
        </div>
      )}
      {top.length > 0 && (
        <div className="chips net-sheet-row" aria-label="Strongest connections">
          {top.map((t) => (
            <PersonLink key={t.node.id} id={t.node.id} className="chip">
              <Avatar id={t.node.id} name={t.node.label} size={22} />
              <span>{t.node.firstName ?? t.node.label}</span>
            </PersonLink>
          ))}
        </div>
      )}
      <div className="net-sheet-actions">
        <Link to={personPath(node.id)} className="btn btn-primary">
          Open
        </Link>
        <Link to={`${personPath(node.id)}?tab=connections`} className="btn">
          Connections
        </Link>
      </div>
    </div>
  );
}

function NodeList({ g }: { g: NetworkGraph }) {
  const circles = new Map(g.circles.map((c) => [c.id, c]));
  const nodes = [...g.nodes].filter((n) => !n.isMe).sort((a, b) => b.degree - a.degree || (b.tieStrength ?? 0) - (a.tieStrength ?? 0));
  return (
    <div className="card-list">
      {nodes.slice(0, 300).map((n: NetworkNode) => (
        <EntityRow
          key={n.id}
          personId={n.id}
          icon={<Avatar id={n.id} name={n.label} />}
          title={n.label}
          subtitle={[plural(n.degree, 'connection'), n.primaryCircleId ? circles.get(n.primaryCircleId)?.name : null].filter(Boolean).join(' · ')}
          trailing={n.state ? <span className={`state-dot ${n.state}`} title={stateLabel(n.state)} aria-label={stateLabel(n.state)} /> : undefined}
        />
      ))}
      {nodes.length > 300 && <p className="caption" style={{ padding: '8px 14px' }}>Showing the 300 best-connected of {nodes.length}.</p>}
    </div>
  );
}

/** /network: who knows whom (sigma + ForceAtlas2 in a worker), colored by circle. */
export function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const view: View = params.get('view') === 'list' ? 'list' : 'graph';
  const q = useNetwork(filters);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const data = q.data;
  const matches = useMemo(() => (data ? searchNodes(data.nodes, search) : []), [data, search]);

  const setFilters = (next: NetworkFilters) => setParams((prev) => filtersToParams(next, prev), { replace: true });
  const setView = (v: View) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'list') next.set('view', 'list');
        else next.delete('view');
        return next;
      },
      { replace: true },
    );
  const navigate = useNavigate();
  const effectiveView: View = failed ? 'list' : view;
  const pick = (id: string) => {
    if (effectiveView === 'list') {
      void navigate(personPath(id));
      return;
    }
    setSelected(id);
    setFocus((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }));
    setSearch('');
  };

  const visibleCount = data ? data.nodes.filter((n) => !n.isMe).length : 0;
  const legendColors = useMemo(() => circleColors(data?.circles ?? []), [data]);

  return (
    <>
      <PageHeader
        title="Network"
        sub={data ? `${plural(visibleCount, 'person', 'people')} · ${plural(data.edges.filter((e) => e.dominantType !== 'tie').length, 'connection')}${data.truncated ? ' (best connected)' : ''}` : 'Who knows whom'}
        actions={
          <div className="segmented net-view" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={effectiveView === 'graph'} disabled={failed} onClick={() => setView('graph')}>
              Map
            </button>
            <button type="button" role="tab" aria-selected={effectiveView === 'list'} onClick={() => setView('list')}>
              List
            </button>
          </div>
        }
      />
      <div className="net-search">
        <input
          className="input search-input"
          type="search"
          placeholder="Find someone on the map"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) pick(matches[0].id);
          }}
          aria-label="Find someone on the map"
          aria-controls="net-search-results"
        />
        {matches.length > 0 && (
          <ul id="net-search-results" className="net-search-results" role="listbox">
            {matches.map((n) => (
              <li key={n.id} role="option" aria-selected={false}>
                <button type="button" onClick={() => pick(n.id)}>
                  <span>{n.label}</span>
                  <span className="caption">{plural(n.degree, 'connection')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Filters f={filters} data={data} onChange={setFilters} />

      {q.isError && isNotImplemented(q.error) ? (
        <div className="card-list">
          <Empty title="The network map isn’t available yet." />
        </div>
      ) : !data ? (
        <PageState error={q.error} onRetry={() => void q.refetch()} />
      ) : visibleCount === 0 ? (
        <div className="card-list">
          {filters.circle || filters.types.length || filters.minStrength !== DEFAULT_FILTERS.minStrength ? (
            <Empty title="No one matches these filters.">
              <button type="button" className="btn btn-sm" onClick={() => setFilters({ ...DEFAULT_FILTERS, window: filters.window })}>
                Reset filters
              </button>
            </Empty>
          ) : (
            <Empty title="No connections mapped yet.">The nightly run links people who share group chats and events. Check back after it runs.</Empty>
          )}
        </div>
      ) : effectiveView === 'list' ? (
        <>
          {failed && <p className="caption">This device can’t draw the map (no WebGL), so here’s the list.</p>}
          <NodeList g={data} />
        </>
      ) : (
        <div className={q.isPlaceholderData ? 'net-stage loading' : 'net-stage'}>
          <Suspense fallback={<CanvasFallback />}>
            <GraphCanvas data={data} selected={selected} onSelect={setSelected} focusRequest={focus} onFailed={() => setFailed(true)} />
          </Suspense>
          {data.circles.length > 0 && (
            <div className="net-legend" aria-label="Circles">
              {data.circles.slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip plain"
                  aria-pressed={filters.circle === c.id}
                  onClick={() => setFilters({ ...filters, circle: filters.circle === c.id ? null : c.id })}
                >
                  <span className="coll-dot" style={{ background: legendColors.get(c.id) }} aria-hidden />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          )}
          {selected && <NodeSheet g={data} id={selected} onClose={() => setSelected(null)} />}
        </div>
      )}
    </>
  );
}
