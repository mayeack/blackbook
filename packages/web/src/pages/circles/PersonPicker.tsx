import { useEffect, useState } from 'react';
import { usePeople } from '../../api/hooks';
import { Avatar } from '../../components/Avatar';
import { PersonLink } from '../../components/PersonLink';
import { roleLine } from '../../lib/format';
import { Sheet } from '../person/Sheet';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Search people (visible only, last-name order) and pick some. The avatar opens the person; the row toggles them.
 * `exclude` people are already members and aren't offered.
 */
export function PersonPicker({
  title,
  exclude,
  busy,
  onPick,
  onClose,
}: {
  title: string;
  exclude: ReadonlySet<string>;
  busy?: boolean;
  onPick: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 200);
  const people = usePeople(q, 'last');
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const items = (people.data?.pages.flatMap((p) => p.items) ?? []).filter((p) => !exclude.has(p.id));
  const toggle = (id: string, name: string) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, name);
      return next;
    });
  return (
    <Sheet
      open
      wide
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!picked.size || busy} onClick={() => onPick([...picked.keys()])}>
            {busy ? 'Adding…' : picked.size ? `Add ${picked.size}` : 'Add'}
          </button>
        </>
      }
    >
      <input
        className="input search-input"
        type="search"
        placeholder="Search people"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search people"
        autoFocus
      />
      {picked.size > 0 && (
        <div className="chips picked">
          {[...picked].map(([id, name]) => (
            <button key={id} type="button" className="chip plain" onClick={() => toggle(id, name)} aria-label={`Unselect ${name}`}>
              <span>{name}</span> ✕
            </button>
          ))}
        </div>
      )}
      <div className="pick-list people">
        {people.isPending && <p className="caption muted">Loading…</p>}
        {people.isError && <p className="caption">{(people.error as Error).message}</p>}
        {items.slice(0, 80).map((p) => {
          const on = picked.has(p.id);
          return (
            <div key={p.id} className={on ? 'pick-person on' : 'pick-person'}>
              <PersonLink id={p.id} title={`Open ${p.displayName}`}>
                <Avatar id={p.id} name={p.displayName} />
              </PersonLink>
              <button type="button" className="pick-person-btn" aria-pressed={on} onClick={() => toggle(p.id, p.displayName)}>
                <span className="er-text">
                  <span className="er-title">{p.displayName}</span>
                  {(roleLine(p.jobTitle, p.company) ?? p.handle) && <span className="er-subtitle">{roleLine(p.jobTitle, p.company) ?? p.handle}</span>}
                </span>
                <span className={on ? 'pick-check on' : 'pick-check'} aria-hidden>
                  {on ? '✓' : '+'}
                </span>
              </button>
            </div>
          );
        })}
        {people.data && items.length === 0 && <p className="caption">{q ? 'No one matches.' : 'Everyone is already in here.'}</p>}
      </div>
    </Sheet>
  );
}
