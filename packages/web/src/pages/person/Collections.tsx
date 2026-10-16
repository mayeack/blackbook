import { useState } from 'react';
import { Link } from 'react-router';
import type { CollectionChip, CollectionType, PersonCollections } from '@yb/shared';
import { isNotImplemented } from '../../api/hooks';
import type { PersonDetail } from '../../api/types';
import { useToast } from '../../components/Toast';
import { useCollections } from '../circles/api';
import { CollectionDot } from '../circles/CollectionIcon';
import { collectionNoun, collectionPath, matchCollections, sortCollections } from '../circles/logic';
import { useEditPersonCollections, usePersonCollections } from './api';
import { Sheet } from './Sheet';

const ROWS: { type: CollectionType; key: keyof PersonCollections; title: string }[] = [
  { type: 'circle', key: 'circles', title: 'Circles' },
  { type: 'tag', key: 'tags', title: 'Tags' },
  { type: 'location', key: 'locations', title: 'Places' },
];

function AddSheet({ type, personId, have, onClose }: { type: CollectionType; personId: string; have: Set<string>; onClose: () => void }) {
  const list = useCollections(type);
  const edit = useEditPersonCollections(personId);
  const toast = useToast();
  const [q, setQ] = useState('');
  const noun = collectionNoun(type);
  const options = matchCollections(sortCollections(list.data?.items ?? []), q).filter((c) => !have.has(c.id));
  const exact = (list.data?.items ?? []).some((c) => c.status === 'active' && c.name.toLocaleLowerCase() === q.trim().toLocaleLowerCase());
  const add = (item: { id?: string; name?: string }) =>
    edit.mutate(
      { add: [{ type, ...item }] },
      {
        onSuccess: () => {
          toast(`Added. Undo from Today.`);
          onClose();
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );
  return (
    <Sheet open title={`Add to a ${noun.one}`} onClose={onClose}>
      <input
        className="input search-input"
        type="search"
        placeholder={`Find or create a ${noun.one}`}
        value={q}
        maxLength={80}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="pick-list">
        {q.trim() && !exact && (
          <button type="button" className="pick-row create" disabled={edit.isPending} onClick={() => add({ name: q.trim() })}>
            <span className="pick-plus" aria-hidden>
              +
            </span>
            <span>
              Create “{q.trim()}”{type === 'circle' ? ' (your circle)' : ''}
            </span>
          </button>
        )}
        {list.isPending && <p className="caption muted">Loading…</p>}
        {options.slice(0, 40).map((c) => (
          <button key={c.id} type="button" className="pick-row" disabled={edit.isPending} onClick={() => add({ id: c.id })}>
            <CollectionDot color={c.color} />
            <span className="pick-name">{c.name}</span>
            {c.kind === 'auto' && <span className="badge">auto</span>}
            <span className="caption">{c.memberCount}</span>
          </button>
        ))}
        {list.data && options.length === 0 && !q.trim() && <p className="caption">No {noun.one}s yet. Type a name to create one.</p>}
      </div>
    </Sheet>
  );
}

function ChipLink({ c, editing, onRemove, busy }: { c: CollectionChip & { origin?: string }; editing: boolean; onRemove: () => void; busy: boolean }) {
  return (
    <span className="coll-chip">
      <Link to={collectionPath(c.type, c.id)} className="chip plain">
        <CollectionDot color={c.color} />
        <span>
          {c.icon ? `${c.icon} ` : ''}
          {c.name}
        </span>
        {c.kind === 'auto' && <span className="badge">auto</span>}
      </Link>
      {editing && (
        <button type="button" className="chip-x" aria-label={`Remove from ${c.name}`} disabled={busy} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  );
}

/** Circles, tags and places for this person: chips that open the collection; Edit adds and removes. */
export function PersonCollectionsSection({ p }: { p: PersonDetail }) {
  const q = usePersonCollections(p.id);
  const edit = useEditPersonCollections(p.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<CollectionType | null>(null);

  // Until the membership API lands, the base person's tag and place names (read-only).
  if (q.isError && isNotImplemented(q.error)) {
    if (!p.tags.length && !p.locations.length) return null;
    return (
      <section className="person-section">
        <h2 className="section-title">Tags & places</h2>
        <div className="chips">
          {[...p.tags.map((t) => `t:${t}`), ...p.locations.map((l) => `l:${l}`)].map((k) => (
            <span key={k} className="chip plain">
              <span>{k.slice(2)}</span>
            </span>
          ))}
        </div>
      </section>
    );
  }

  const remove = (c: CollectionChip & { origin?: string }) =>
    edit.mutate(
      { remove: [{ type: c.type, id: c.id }] },
      {
        onSuccess: () => toast(c.kind === 'auto' ? `Removed from ${c.name}. The agent won’t add them back.` : `Removed from ${c.name}. Undo from Today.`),
        onError: (e) => toast(e.message, 'error'),
      },
    );

  return (
    <section className="person-section">
      <div className="section-head">
        <h2 className="section-title">Circles, tags & places</h2>
        {q.data && (
          <button type="button" className="btn btn-sm btn-ghost" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      {!q.data ? (
        <p className="caption muted">{q.isError ? (q.error as Error).message : 'Loading…'}</p>
      ) : (
        <div className="coll-rows">
          {ROWS.map((r) => {
            const items = q.data[r.key] as (CollectionChip & { origin?: string })[];
            if (!items.length && !editing) return null;
            return (
              <div key={r.key} className="coll-row">
                <span className="coll-row-title">{r.title}</span>
                <div className="chips">
                  {items.map((c) => (
                    <ChipLink key={c.id} c={c} editing={editing} busy={edit.isPending} onRemove={() => remove(c)} />
                  ))}
                  {editing && (
                    <button type="button" className="chip plain add-chip" onClick={() => setAdding(r.type)}>
                      <span>+ Add</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!editing && ROWS.every((r) => q.data[r.key].length === 0) && (
            <p className="caption">
              Not in any circle, tag or place yet.{' '}
              <button type="button" className="link-btn" onClick={() => setEditing(true)}>
                Add some
              </button>
            </p>
          )}
        </div>
      )}
      {adding && q.data && (
        <AddSheet
          type={adding}
          personId={p.id}
          have={new Set(q.data[ROWS.find((r) => r.type === adding)!.key].map((c) => c.id))}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}
