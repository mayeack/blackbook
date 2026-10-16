import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import type { CollectionDetail, CollectionMember, CollectionType, PersonChip } from '@yb/shared';
import { api, isApiError } from '../../api/client';
import { isNotImplemented } from '../../api/hooks';
import { Avatar } from '../../components/Avatar';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { date, plural } from '../../lib/format';
import { stateLabel } from '../../lib/labels';
import { MoreMenu } from '../person/MoreMenu';
import { retryOnce } from '../person/api';
import { Sheet } from '../person/Sheet';
import { collectionKeys, useCollection, useDeleteCollection, useEditMembers, useUpdateCollection } from './api';
import { CollectionIcon } from './CollectionIcon';
import {
  collectionApiPath,
  collectionBadges,
  collectionNoun,
  deleteAction,
  FACET_TITLE,
  FACET_TYPE,
  filterByFacets,
  matchMembers,
  memberSubtitle,
  otherFacets,
  tabParam,
  toggleFacet,
  type FacetKey,
} from './logic';
import { PersonPicker } from './PersonPicker';
import './circles.css';

type Selected = Partial<Record<FacetKey, string[]>>;

function MemberRow({ person, subtitle, trailing }: { person: PersonChip; subtitle: string | null; trailing?: ReactNode }) {
  return (
    <div className="entity-row member-row">
      <PersonLink id={person.id} className="member-link">
        <Avatar id={person.id} name={person.displayName} />
        <span className="er-text">
          <span className="er-title">{person.displayName}</span>
          {(subtitle || person.state) && (
            <span className="er-subtitle">{[subtitle, person.state && person.state !== 'steady' ? stateLabel(person.state) : null].filter(Boolean).join(' · ')}</span>
          )}
        </span>
      </PersonLink>
      {trailing && <span className="er-trailing">{trailing}</span>}
    </div>
  );
}

function RenameSheet({ d, type, onClose }: { d: CollectionDetail; type: CollectionType; onClose: () => void }) {
  const update = useUpdateCollection(type, d.collection.id);
  const toast = useToast();
  const [name, setName] = useState(d.collection.name);
  const [description, setDescription] = useState(d.collection.description ?? '');
  const save = () =>
    update.mutate(
      { name: name.trim(), ...(type === 'circle' ? { description: description.trim() || null } : {}) },
      {
        onSuccess: () => {
          toast('Saved. Undo from Today.');
          onClose();
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );
  return (
    <Sheet
      open
      title={`Edit ${collectionNoun(type).one}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || update.isPending} onClick={save}>
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save();
        }}
      >
        <label className="field">
          <span className="caption">Name</span>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {type === 'circle' && (
          <label className="field">
            <span className="caption">Description</span>
            <input className="input" value={description} maxLength={240} onChange={(e) => setDescription(e.target.value)} />
          </label>
        )}
        {d.collection.kind === 'auto' && <p className="caption">The agent won’t rename a circle once you’ve named it.</p>}
      </form>
    </Sheet>
  );
}

/** Filter chips for the other two facets (OR within a facet, AND across). */
function FacetFilters({ d, type, selected, onToggle }: { d: CollectionDetail; type: CollectionType; selected: Selected; onToggle: (f: FacetKey, id: string) => void }) {
  const facets = otherFacets(type).filter((f) => d.facets[f].length > 0);
  if (!facets.length) return null;
  return (
    <div className="facet-filters">
      {facets.map((f) => (
        <div key={f} className="facet-row">
          <span className="facet-title">{FACET_TITLE[f]}</span>
          <div className="filter-chips" role="group" aria-label={`Filter by ${FACET_TITLE[f]}`}>
            {d.facets[f].slice(0, 12).map((v) => (
              <button key={v.id} type="button" className="chip plain" aria-pressed={!!selected[f]?.includes(v.id)} onClick={() => onToggle(f, v.id)}>
                <span>{v.name}</span> <span className="muted">{v.count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** /c/:id, /tags/:id, /locations/:id — members (last-name order), facet filters, suggested additions, ⋯ menu. */
export function CollectionPage({ type }: { type: CollectionType }) {
  const { id = '' } = useParams();
  const q = useCollection(type, id);
  const edit = useEditMembers(type, id);
  const del = useDeleteCollection(type, id);
  const toast = useToast();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Selected>({});
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState<PersonChip | null>(null);
  const noun = collectionNoun(type);
  const back = `/circles${tabParam(type) ? `?tab=${tabParam(type)}` : ''}`;

  const facetPairs = (Object.entries(selected) as [FacetKey, string[]][]).flatMap(([f, ids]) => ids.map((fid) => [f, fid] as const));
  const facetQueries = useQueries({
    queries: facetPairs.map(([f, fid]) => ({
      queryKey: collectionKeys.detail(FACET_TYPE[f], fid),
      queryFn: () => api.get<CollectionDetail>(`${collectionApiPath(FACET_TYPE[f])}/${encodeURIComponent(fid)}`),
      retry: retryOnce,
      staleTime: 60_000,
    })),
  });

  if (q.isPending) return <PageState error={null} />;
  if (q.isError) {
    if (isNotImplemented(q.error))
      return (
        <div className="card-list">
          <Empty title="Not available yet.">
            <Link to={back}>Back</Link>
          </Empty>
        </div>
      );
    if (isApiError(q.error) && (q.error.status === 404 || q.error.status === 400))
      return (
        <div className="card-list">
          <Empty title={`This ${noun.one} isn’t available.`}>
            It may have been deleted. <Link to={back}>Back to {noun.one}s</Link>
          </Empty>
        </div>
      );
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }

  const d = q.data;
  const c = d.collection;
  const memberIds = new Set(d.members.map((m) => m.person.id));
  const facetSet = (f: FacetKey, fid: string): ReadonlySet<string> | null => {
    const i = facetPairs.findIndex(([ff, x]) => ff === f && x === fid);
    const data = i >= 0 ? facetQueries[i]?.data : undefined;
    return data ? new Set(data.members.map((m) => m.person.id)) : null;
  };
  const shown = matchMembers(filterByFacets(d.members, selected, facetSet), filter);
  const filtering = facetPairs.length > 0 || filter.trim() !== '';
  const archivedOrGone = c.status !== 'active';
  const delAction = deleteAction(c);

  const add = (ids: string[], done?: () => void) =>
    edit.mutate(
      { add: ids },
      {
        onSuccess: () => {
          toast(`Added ${plural(ids.length, 'person', 'people')}. Undo from Today.`);
          done?.();
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );

  const remove = (p: PersonChip) =>
    edit.mutate(
      { remove: [p.id] },
      {
        onSuccess: () => {
          setRemoving(null);
          toast(c.kind === 'auto' ? `Removed ${p.displayName}. The agent won’t add them back.` : `Removed ${p.displayName}. Undo from Today.`);
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );

  const badges = collectionBadges(c);
  return (
    <>
      <Link to={back} className="back-link">
        ← {type === 'circle' ? 'Circles' : type === 'tag' ? 'Tags' : 'Locations'}
      </Link>
      <div className="coll-header">
        <CollectionIcon type={type} icon={c.icon} color={c.color} size={48} />
        <div className="coll-head-text">
          <h1>
            {c.name}
            {badges.map((b) => (
              <span key={b} className={b === 'auto' ? 'badge badge-auto new-badge' : 'badge new-badge'}>
                {b}
              </span>
            ))}
            {archivedOrGone && <span className="pill new-badge">{c.status === 'archived' ? 'Archived' : 'Deleted'}</span>}
          </h1>
          {c.description && <div className="ph-line">{c.description}</div>}
          <div className="ph-line caption">
            {plural(d.members.length, 'person', 'people')}
            {d.lastActivityAt != null ? ` · active ${date(d.lastActivityAt)}` : ''}
            {c.kind === 'auto' ? ' · kept up to date by the agent' : ''}
          </div>
        </div>
        <MoreMenu
          items={[
            { label: 'Add people', onSelect: () => setPicking(true), disabled: archivedOrGone },
            { label: type === 'circle' ? 'Edit name & description' : 'Rename', onSelect: () => setRenaming(true) },
            { label: delAction.label, onSelect: () => setDeleting(true), danger: true, disabled: archivedOrGone },
          ]}
        />
      </div>

      <FacetFilters d={d} type={type} selected={selected} onToggle={(f, fid) => setSelected((s) => toggleFacet(s, f, fid))} />

      <div className="section-head">
        <h2 className="section-title">
          Members{filtering ? ` · ${shown.length} of ${d.members.length}` : ` · ${d.members.length}`}
        </h2>
        <span className="head-actions">
          {d.members.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
          {!archivedOrGone && (
            <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
              + Add
            </button>
          )}
        </span>
      </div>
      {d.members.length > 12 && (
        <div className="toolbar">
          <input className="input search" type="search" placeholder="Filter members" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter members" />
        </div>
      )}
      <div className="card-list">
        {d.members.length === 0 ? (
          <Empty title="No one here yet.">Add people, or pick from the suggestions below.</Empty>
        ) : shown.length === 0 ? (
          <Empty title="No members match these filters." />
        ) : (
          shown.map((m: CollectionMember) => (
            <MemberRow
              key={m.person.id}
              person={m.person}
              subtitle={memberSubtitle(m, type)}
              trailing={
                editing ? (
                  <button type="button" className="btn btn-sm" disabled={edit.isPending} onClick={() => setRemoving(m.person)}>
                    Remove
                  </button>
                ) : undefined
              }
            />
          ))
        )}
      </div>

      {d.suggestedAdditions.filter((s) => !memberIds.has(s.person.id)).length > 0 && !archivedOrGone && (
        <>
          <h2 className="section-title">Suggested additions</h2>
          <div className="card-list">
            {d.suggestedAdditions
              .filter((s) => !memberIds.has(s.person.id))
              .map((s) => (
                <MemberRow
                  key={s.person.id}
                  person={s.person}
                  subtitle={s.reason}
                  trailing={
                    <button type="button" className="btn btn-sm" disabled={edit.isPending} onClick={() => add([s.person.id])}>
                      Add
                    </button>
                  }
                />
              ))}
          </div>
        </>
      )}

      {d.fromFacts.filter((p) => !memberIds.has(p.id)).length > 0 && !archivedOrGone && (
        <>
          <h2 className="section-title">Also live here</h2>
          <p className="caption section-note">From what they’ve said about where they live; not added yet.</p>
          <div className="card-list">
            {d.fromFacts
              .filter((p) => !memberIds.has(p.id))
              .map((p) => (
                <MemberRow
                  key={p.id}
                  person={p}
                  subtitle={null}
                  trailing={
                    <button type="button" className="btn btn-sm" disabled={edit.isPending} onClick={() => add([p.id])}>
                      Add
                    </button>
                  }
                />
              ))}
          </div>
        </>
      )}

      {picking && <PersonPicker title={`Add people to ${c.name}`} exclude={memberIds} busy={edit.isPending} onPick={(ids) => add(ids, () => setPicking(false))} onClose={() => setPicking(false)} />}
      {renaming && <RenameSheet d={d} type={type} onClose={() => setRenaming(false)} />}

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.displayName ?? ''}?`}
        confirmLabel="Remove"
        busy={edit.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      >
        <p className="caption">
          {c.kind === 'auto'
            ? 'They stay out of this circle: the agent won’t add them back. You can undo this from Today.'
            : `They’re only removed from this ${noun.one}. You can undo this from Today.`}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        title={`${delAction.verb} “${c.name}”?`}
        confirmLabel={delAction.verb}
        danger
        busy={del.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setDeleting(false);
              toast(`${delAction.verb === 'Archive' ? 'Archived' : 'Deleted'}. Undo from Today.`);
              void navigate(back);
            },
            onError: (e) => toast(e.message, 'error'),
          })
        }
      >
        <p className="caption">
          {c.kind === 'auto'
            ? 'The circle is archived and the agent won’t bring it back. Nobody is changed otherwise.'
            : `The ${noun.one} goes away; the people in it aren’t touched.`}{' '}
          You can undo this from Today.
        </p>
      </ConfirmDialog>
    </>
  );
}
