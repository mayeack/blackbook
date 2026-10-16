import { useRef, useState } from 'react';
import { Link } from 'react-router';
import type { DigestItem, SuggestionFeedback } from '@yb/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PersonChip } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { date } from '../../lib/format';
import { useFeedback, useOpenFeedback } from './api';
import {
  cardActions,
  kindLabel,
  pickedDateUntil,
  resolvedLabel,
  SNOOZE_CHOICES,
  snoozeUntil,
  tomorrowInput,
  wildcardLabel,
} from './logic';
import { ActionMenu, type MenuItem } from './Menu';
import { WhyPanel } from './WhyPanel';

type MuteScope = Extract<SuggestionFeedback, { action: 'mute' }>['scope'];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Conversation-starter drafts. Copy only: nothing in yeackbot sends them. */
function Openers({ item, canDraft }: { item: DigestItem; canDraft: boolean }) {
  const feedback = useFeedback();
  const toast = useToast();
  const [extra, setExtra] = useState<string[]>([]);
  const all = [...new Set([...item.openers, ...extra])];
  if (all.length === 0 && !canDraft) return null;
  return (
    <div className="dc-openers">
      <div className="dc-openers-head">
        <span className="caption">Drafts · never sent</span>
        {canDraft && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={feedback.isPending}
            onClick={() =>
              feedback.mutate(
                { id: item.suggestionId, body: { action: 'draft' } },
                {
                  onSuccess: (r) => setExtra((xs) => [...xs, ...(r.openers ?? [])]),
                  onError: (e) => toast(e.message, 'error'),
                },
              )
            }
          >
            {feedback.isPending ? 'Drafting…' : all.length ? 'More drafts' : 'Draft an opener'}
          </button>
        )}
      </div>
      {all.map((o) => (
        <div key={o} className="dc-opener">
          <p>{o}</p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void copyText(o).then((ok) => toast(ok ? 'Copied. Paste it into your chat.' : 'Couldn’t copy on this device.', ok ? 'info' : 'error'))}
          >
            Copy
          </button>
        </div>
      ))}
    </div>
  );
}

/** One digest item: Done / Snooze / Skip, ⋯ (Why this?, Wrong, never suggest). Wildcards wear the 🎲. */
export function DigestCard({ item }: { item: DigestItem }) {
  const feedback = useFeedback();
  const openFb = useOpenFeedback();
  const toast = useToast();
  const opened = useRef(false);
  const [why, setWhy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState('');
  const [wrongOpen, setWrongOpen] = useState(false);
  const [note, setNote] = useState('');
  const [mute, setMute] = useState<MuteScope | null>(null);

  const actions = cardActions(item);
  const resolved = resolvedLabel(item.status);
  const busy = feedback.isPending;
  const person = item.people.length === 1 ? item.people[0]! : null;
  const who = person ? (person.firstName ?? person.displayName) : null;

  const send = (body: SuggestionFeedback, done: string, after?: () => void) =>
    feedback.mutate(
      { id: item.suggestionId, body },
      {
        onSuccess: (r) => {
          after?.();
          toast(r.batchId ? `${done} The change it caused is in the feed below, with Undo.` : done);
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );

  const markOpened = () => {
    if (opened.current || resolved) return;
    opened.current = true;
    openFb.mutate(item.suggestionId);
  };

  const snoozeItems: MenuItem[] = [
    ...SNOOZE_CHOICES.map((c) => ({
      label: c.label,
      onSelect: () => send({ action: 'snooze', until: snoozeUntil(c.id) }, `Snoozed until ${date(snoozeUntil(c.id))}.`),
    })),
    { label: 'Pick a date…', onSelect: () => setPicking(true) },
  ];

  const moreItems: MenuItem[] = [];
  if (actions.has('why')) moreItems.push({ label: why ? 'Hide why' : 'Why this?', onSelect: () => setWhy((w) => !w) });
  if (actions.has('wrong')) moreItems.push({ label: 'Wrong…', onSelect: () => setWrongOpen(true), danger: true });
  if (actions.has('mute')) {
    if (person) moreItems.push({ label: `Never suggest ${who}`, onSelect: () => setMute('person') });
    if (person) moreItems.push({ label: `No more “${kindLabel(item.kind).toLowerCase()}” for ${who}`, onSelect: () => setMute('person_kind') });
    moreItems.push({ label: `Never suggest “${kindLabel(item.kind).toLowerCase()}”`, onSelect: () => setMute('kind') });
  }

  const cls = ['digest-card', item.isWildcard ? 'wildcard' : '', resolved ? 'resolved' : ''].filter(Boolean).join(' ');
  const pickedAt = pickedDateUntil(pick);
  const headline = item.target ? (
    <Link to={item.target.href} onClick={markOpened}>
      {item.headline}
    </Link>
  ) : (
    item.headline
  );

  return (
    <article className={cls} aria-label={`Item ${item.ordinal}`}>
      <div className="dc-top">
        <span className="dc-ordinal" title={`Reply “done ${item.ordinal}” to the brief`}>
          {item.ordinal}
        </span>
        <div className="dc-badges">
          {item.isWildcard ? (
            <span className="pill pill-accent" title="A wildcard: something different, now and then">
              <span aria-hidden>🎲</span>&nbsp;{wildcardLabel(item.wildcardGenerator)}
            </span>
          ) : (
            <span className="pill">{kindLabel(item.kind)}</span>
          )}
          {item.timeCritical && !resolved && <span className="pill pill-warn">Soon</span>}
          {item.sensitive && <span className="pill">Private</span>}
          {resolved && (
            <span className={item.status === 'done' ? 'pill pill-ok' : 'pill'}>
              {resolved}
              {item.status === 'snoozed' && item.snoozedUntil != null ? ` until ${date(item.snoozedUntil)}` : ''}
            </span>
          )}
        </div>
      </div>

      <h3 className="dc-headline">{headline}</h3>
      {item.body && !resolved && <p className="dc-body">{item.body}</p>}

      {item.people.length > 0 && (
        <div className="chips dc-people">
          {item.people.map((p) => (
            <PersonChip key={p.id} id={p.id} name={p.displayName} />
          ))}
        </div>
      )}

      {!resolved && <Openers item={item} canDraft={actions.has('draft')} />}

      {!resolved && (
        <div className="dc-actions">
          {actions.has('done') && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => send({ action: 'done' }, 'Marked done.')}>
              Done
            </button>
          )}
          {actions.has('snooze') && <ActionMenu label="Snooze ▾" items={snoozeItems} align="start" />}
          {actions.has('skip') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => send({ action: 'skip' }, 'Skipped. Fewer like this.')}>
              Skip
            </button>
          )}
          <span className="dc-spacer" />
          <ActionMenu label="⋯" ariaLabel="More actions" items={moreItems} className="btn btn-sm btn-ghost" />
        </div>
      )}

      {picking && !resolved && (
        <div className="dc-pick">
          <label className="caption" htmlFor={`snz-${item.suggestionId}`}>
            Snooze until
          </label>
          <input
            id={`snz-${item.suggestionId}`}
            type="date"
            className="input input-sm"
            min={tomorrowInput()}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || pickedAt == null}
            onClick={() => pickedAt != null && send({ action: 'snooze', until: pickedAt }, `Snoozed until ${date(pickedAt)}.`, () => setPicking(false))}
          >
            Snooze
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}

      {resolved && actions.has('why') && (
        <div className="dc-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWhy((w) => !w)}>
            {why ? 'Hide why' : 'Why this?'}
          </button>
        </div>
      )}
      {why && <WhyPanel suggestionId={item.suggestionId} />}

      <ConfirmDialog
        open={wrongOpen}
        title="Something’s wrong here?"
        confirmLabel="Mark wrong"
        danger
        busy={busy}
        onCancel={() => setWrongOpen(false)}
        onConfirm={() =>
          send({ action: 'wrong', ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}) }, 'Thanks — marked wrong.', () => {
            setWrongOpen(false);
            setNote('');
          })
        }
      >
        <p>
          yeackbot will learn from it. If this rests on a fact, merge or connection it got wrong, that is taken back too
          (you can undo that from the feed).
        </p>
        <label className="caption" htmlFor={`wrong-${item.suggestionId}`}>
          What’s wrong? (optional)
        </label>
        <textarea
          id={`wrong-${item.suggestionId}`}
          className="input td-textarea"
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={mute != null}
        title={
          mute === 'kind'
            ? `Never suggest “${kindLabel(item.kind).toLowerCase()}”?`
            : mute === 'person_kind'
              ? `No more “${kindLabel(item.kind).toLowerCase()}” for ${who}?`
              : `Never suggest ${who}?`
        }
        confirmLabel="Never suggest"
        busy={busy}
        onCancel={() => setMute(null)}
        onConfirm={() => mute && send({ action: 'mute', scope: mute }, 'Muted. Unmute any time in Settings → What I’ve learned.', () => setMute(null))}
      >
        <p>You can undo this any time in Settings → What I’ve learned.</p>
      </ConfirmDialog>
    </article>
  );
}
