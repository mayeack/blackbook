import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { CollectionSummary, CollectionType } from '@yb/shared';
import { isNotImplemented } from '../../api/hooks';
import { EntityRow } from '../../components/EntityRow';
import { Icons } from '../../components/icons';
import { Empty, PageHeader, PageState } from '../../components/PageState';
import { useToast } from '../../components/Toast';
import { plural } from '../../lib/format';
import { Sheet } from '../person/Sheet';
import { useCollections, useCreateCollection } from './api';
import { CollectionIcon } from './CollectionIcon';
import { COLLECTION_TABS, collectionBadges, collectionNoun, collectionPath, matchCollections, parseTab, sortCollections, tabParam } from './logic';
import './circles.css';

function CollectionRow({ c }: { c: CollectionSummary }) {
  const badges = collectionBadges(c);
  return (
    <EntityRow
      to={collectionPath(c.type, c.id)}
      icon={<CollectionIcon type={c.type} icon={c.icon} color={c.color} />}
      title={
        <>
          {c.name}
          {badges.map((b) => (
            <span key={b} className={b === 'auto' ? 'badge badge-auto new-badge' : 'badge new-badge'}>
              {b}
            </span>
          ))}
        </>
      }
      subtitle={c.description ?? plural(c.memberCount, 'person', 'people')}
      trailing={
        <>
          {c.description && <span className="count">{c.memberCount}</span>}
          <span className="chevron">{Icons.chevron}</span>
        </>
      }
    />
  );
}

function CreateSheet({ type, onClose }: { type: CollectionType; onClose: () => void }) {
  const create = useCreateCollection(type);
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const noun = collectionNoun(type);
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    create.mutate(
      { name: n, ...(type === 'circle' && description.trim() ? { description: description.trim() } : {}) },
      {
        onSuccess: (r) => {
          onClose();
          void navigate(collectionPath(type, r.collection.id));
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );
  };
  return (
    <Sheet
      open
      title={`New ${noun.one}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span className="caption">Name</span>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {type === 'circle' && (
          <label className="field">
            <span className="caption">Description (optional)</span>
            <input className="input" value={description} maxLength={240} onChange={(e) => setDescription(e.target.value)} />
          </label>
        )}
        <p className="caption">Your own {noun.one}s are never changed or removed by the agent.</p>
      </form>
    </Sheet>
  );
}

function CollectionList({ type, filter }: { type: CollectionType; filter: string }) {
  const q = useCollections(type);
  if (q.isError && isNotImplemented(q.error))
    return (
      <div className="card-list">
        <Empty title="Not available yet." />
      </div>
    );
  if (!q.data) return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  const items = matchCollections(sortCollections(q.data.items), filter);
  const noun = collectionNoun(type);
  if (!items.length)
    return (
      <div className="card-list">
        {filter ? (
          <Empty title={`No ${noun.one}s match “${filter}”.`} />
        ) : type === 'circle' ? (
          <Empty title="No circles yet.">The weekly run finds circles from shared group chats and events. You can also make your own.</Empty>
        ) : (
          <Empty title={`No ${noun.one}s yet.`}>Add one here or from anyone’s page.</Empty>
        )}
      </div>
    );
  if (type !== 'circle')
    return (
      <div className="card-list">
        {items.map((c) => (
          <CollectionRow key={c.id} c={c} />
        ))}
      </div>
    );
  const auto = items.filter((c) => c.kind === 'auto');
  const mine = items.filter((c) => c.kind !== 'auto');
  return (
    <>
      {auto.length > 0 && (
        <>
          <h2 className="section-title">Auto circles · {auto.length}</h2>
          <p className="caption section-note">Found from group chats and events. The agent keeps membership current but never deletes one.</p>
          <div className="card-list">
            {auto.map((c) => (
              <CollectionRow key={c.id} c={c} />
            ))}
          </div>
        </>
      )}
      {mine.length > 0 && (
        <>
          <h2 className="section-title">Your circles · {mine.length}</h2>
          <div className="card-list">
            {mine.map((c) => (
              <CollectionRow key={c.id} c={c} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** /circles: Circles | Tags | Locations, each a list → detail. */
export function CirclesPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const noun = collectionNoun(tab);
  return (
    <>
      <PageHeader
        title="Circles"
        sub="Circles, tags and places"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            + New {noun.one}
          </button>
        }
      />
      <div className="segmented" role="tablist" aria-label="Collection type">
        {COLLECTION_TABS.map((t) => (
          <button
            key={t.type}
            type="button"
            role="tab"
            aria-selected={tab === t.type}
            onClick={() =>
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  const v = tabParam(t.type);
                  if (v) next.set('tab', v);
                  else next.delete('tab');
                  return next;
                },
                { replace: true },
              )
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder={`Filter ${noun.one}s`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={`Filter ${noun.one}s`}
        />
      </div>
      <CollectionList type={tab} filter={filter.trim()} />
      {creating && <CreateSheet type={tab} onClose={() => setCreating(false)} />}
    </>
  );
}
