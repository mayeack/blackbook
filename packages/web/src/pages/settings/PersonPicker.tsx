import { useState } from 'react';
import { usePerson } from '../../api/hooks';
import { Avatar } from '../../components/Avatar';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { Icons } from '../../components/icons';
import { PersonLink } from '../../components/PersonLink';
import { roleLine } from '../../lib/format';
import { usePeopleSearch } from './api';

/** Search-and-add for a list of people (avatar + name + company per result; the avatar opens the person). */
export function PersonPicker({ exclude, onPick, placeholder = 'Search people…', busy }: { exclude: readonly string[]; onPick: (id: string) => void; placeholder?: string; busy?: boolean }) {
  const [q, setQ] = useState('');
  const res = usePeopleSearch(q);
  const items = (res.data?.items ?? []).filter((p) => !exclude.includes(p.id));
  return (
    <div className="st-picker">
      <input type="search" className="input input-sm st-text-input" value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />
      {q.trim().length >= 2 && (
        <div className="card-list st-picker-results">
          {res.isPending ? (
            <div className="loading">Searching…</div>
          ) : items.length === 0 ? (
            <div className="empty">No one matches.</div>
          ) : (
            items.map((p) => (
              <EntityRow
                key={p.id}
                icon={
                  <PersonLink id={p.id} title={p.displayName}>
                    <Avatar id={p.id} name={p.displayName} />
                  </PersonLink>
                }
                title={p.displayName}
                subtitle={roleLine(p.jobTitle, p.company) ?? p.handle}
                trailing={
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      onPick(p.id);
                      setQ('');
                    }}
                  >
                    Add
                  </button>
                }
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** A chosen person by id: avatar + name (a PersonLink), or a neutral row when they're hidden/merged/gone. */
export function PickedPerson({ id, onRemove, busy }: { id: string; onRemove: () => void; busy?: boolean }) {
  const p = usePerson(id);
  const remove = (
    <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onRemove}>
      Remove
    </button>
  );
  if (!p.data)
    return (
      <EntityRow
        icon={<IconTile>{Icons.people}</IconTile>}
        title={p.isPending ? 'Loading…' : 'Someone not in your list'}
        subtitle={p.isPending ? undefined : 'Hidden, merged or removed'}
        trailing={remove}
      />
    );
  return (
    <EntityRow
      icon={
        <PersonLink id={p.data.id} title={p.data.displayName}>
          <Avatar id={p.data.id} name={p.data.displayName} />
        </PersonLink>
      }
      title={
        <PersonLink id={p.data.id} className="st-plain-link">
          {p.data.displayName}
        </PersonLink>
      }
      subtitle={roleLine(p.data.jobTitle, p.data.company)}
      trailing={remove}
    />
  );
}
