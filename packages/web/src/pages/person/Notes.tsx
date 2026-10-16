import { useState } from 'react';
import type { Note } from '@yb/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { dateTime } from '../../lib/format';
import { useNoteCreate, useNoteDelete, useNotes, useNoteUpdate } from './api';
import { QuerySection } from './Section';

const ORIGIN: Record<Note['origin'], string | null> = { user: null, text_log: 'From a text', legacy: 'From Blackbook', agent: 'Agent' };
const MAX = 10_000;

function NoteItem({ n, personId }: { n: Note; personId: string }) {
  const update = useNoteUpdate(personId);
  const del = useNoteDelete(personId);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.content);
  const [confirm, setConfirm] = useState(false);
  const origin = ORIGIN[n.origin];
  return (
    <li className="note">
      {editing ? (
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault();
            const content = text.trim();
            if (!content) return;
            update.mutate(
              { noteId: n.id, content },
              {
                onSuccess: () => setEditing(false),
                onError: (err) => toast(err.message, 'error'),
              },
            );
          }}
        >
          <textarea className="input textarea" rows={3} maxLength={MAX} value={text} onChange={(e) => setText(e.target.value)} aria-label="Edit note" autoFocus />
          <div className="note-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setText(n.content);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={update.isPending || !text.trim()}>
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="note-text">{n.content}</p>
          <div className="note-foot">
            <span className="caption">
              {dateTime(n.updatedAt)}
              {n.updatedAt - n.createdAt > 60_000 ? ' · edited' : ''}
              {origin ? ` · ${origin}` : ''}
            </span>
            <span className="note-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(true)}>
                Delete
              </button>
            </span>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        title="Delete this note?"
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          del.mutate(n.id, {
            onSuccess: () => {
              setConfirm(false);
              toast('Note deleted. Undo from Today.');
            },
            onError: (e) => toast(e.message, 'error'),
          })
        }
      >
        <p className="caption">You can bring it back with Undo on Today.</p>
      </ConfirmDialog>
    </li>
  );
}

export function NotesSection({ personId }: { personId: string }) {
  const q = useNotes(personId);
  const create = useNoteCreate(personId);
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <QuerySection
      title="Notes"
      query={q}
      hideWhenUnavailable
      actions={
        !open && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
            + Add note
          </button>
        )
      }
    >
      {(d) => (
        <>
          {open && (
            <form
              className="note-form card"
              onSubmit={(e) => {
                e.preventDefault();
                const content = draft.trim();
                if (!content) return;
                create.mutate(content, {
                  onSuccess: () => {
                    setDraft('');
                    setOpen(false);
                  },
                  onError: (err) => toast(err.message, 'error'),
                });
              }}
            >
              <textarea
                className="input textarea"
                rows={3}
                maxLength={MAX}
                placeholder="Something to remember about them"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="New note"
                autoFocus
              />
              <div className="note-actions">
                <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={create.isPending || !draft.trim()}>
                  {create.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}
          {d.notes.length === 0 ? (
            !open && <p className="caption">No notes yet. Texting “log: …” to yeackbot adds one too.</p>
          ) : (
            <ul className="note-list">
              {[...d.notes]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((n) => (
                  <NoteItem key={n.id} n={n} personId={personId} />
                ))}
            </ul>
          )}
        </>
      )}
    </QuerySection>
  );
}
