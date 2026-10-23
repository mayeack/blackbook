import { useState } from 'react';
import { Link } from 'react-router';
import type { MetAtLink } from '@yb/shared';
import { isNotImplemented } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import { date, percent } from '../../lib/format';
import { metSignalLabel } from '../../lib/labels';
import { metAtDetail, metAtLine } from '../../lib/tickets';
import { useMetAt, useMetAtWrong } from './api';
import { QuerySection } from './Section';
import { Sheet } from './Sheet';

function WrongSheet({ l, personId, onClose }: { l: MetAtLink; personId: string; onClose: () => void }) {
  const wrong = useMetAtWrong(personId);
  const toast = useToast();
  return (
    <Sheet
      open
      title="Not where you met?"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={wrong.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={wrong.isPending}
            onClick={() =>
              wrong.mutate(l.id, {
                onSuccess: () => {
                  toast('Removed. yeackbot won’t link them to that event again. Undo from Today.');
                  onClose();
                },
                onError: (e) => toast(e.message, 'error'),
              })
            }
          >
            {wrong.isPending ? 'Removing…' : 'It’s wrong'}
          </button>
        </>
      }
    >
      <p>{metAtLine(l)}</p>
      <p className="caption">{metAtDetail(l)}</p>
      <p className="caption">
        yeackbot guessed this from when you connected, close to an event you went to. Marking it wrong removes the link for good, and they won’t be
        suggested for shows like it because of it.
      </p>
    </Sheet>
  );
}

/**
 * "Met at": the event yeackbot thinks the owner met this person at (intel/metAt), evidence-style: the event (a link
 * to its page), the signal and its date, and how sure. "Wrong?" rejects it. Most people have none: the section only
 * appears when there is a link.
 */
export function MetAtSection({ personId }: { personId: string }) {
  const q = useMetAt(personId);
  const [open, setOpen] = useState<MetAtLink | null>(null);
  if (q.isPending || (q.isError && isNotImplemented(q.error)) || (q.data && q.data.links.length === 0)) return null;
  return (
    <QuerySection title="Met at" query={q} hideWhenUnavailable>
      {(d) => (
        <>
          <ul className="evidence-list">
            {d.links.map((l) => (
              <li key={l.id} className="evidence-item met-item">
                <Link to={l.href}>
                  <span className="ev-label">{l.title ?? 'An event'}</span>
                  <span className="ev-meta-line">
                    {[date(l.startsAt), l.venue].filter(Boolean).join(' · ')}
                  </span>
                  <span className="ev-meta-line">
                    via {metSignalLabel(l.signal)} on {date(l.signalAt)} · {percent(l.confidence)} sure
                    {l.screenshot ? ' · you saved their contact' : ''}
                  </span>
                </Link>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(l)} aria-label={`Not met at ${l.title ?? 'this event'}?`}>
                  Wrong?
                </button>
              </li>
            ))}
          </ul>
          {open && <WrongSheet l={open} personId={personId} onClose={() => setOpen(null)} />}
        </>
      )}
    </QuerySection>
  );
}
