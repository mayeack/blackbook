/**
 * Source fixes and the Google Calendar controls, shared by Sources (the Google card) and Settings (where the OAuth
 * callback lands). Read-only toward Google: treatments only change how yeackbot uses each calendar.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useGoogleDisconnect, useGoogleStatus, useSetCalendarTreatments } from '../api/hooks';
import type { GoogleStatusView, SourceFix } from '../api/types';
import { googleOutcome } from '../lib/events';
import { plural, relativeDay } from '../lib/format';
import { treatmentHint, treatmentLabel } from '../lib/labels';
import { calendarSummary, fixCopy, googleFix, reconnectCopy } from '../lib/sources';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

/** "How to fix": what to do, in words, plus the one button when there is something to click. */
export function FixBox({ fix, reconnect }: { fix: SourceFix; reconnect?: boolean }) {
  const c = fixCopy(fix);
  const again = reconnect ? reconnectCopy(fix.kind) : null;
  return (
    <div className={fix.kind === 'contract_broken' ? 'fix-box bad' : 'fix-box'} role="note">
      <strong>{again ? again.title : c.title}</strong>
      <p>{again ? again.body : c.body}</p>
      {c.folder && <p className="mono fix-folder">{c.folder}</p>}
      {c.action && (
        // A full navigation: the server redirects to Google's consent screen.
        <a className="btn btn-primary btn-sm" href={c.action.href}>
          {again ? 'Reconnect' : c.action.label}
        </a>
      )}
    </div>
  );
}

/** Connected Google account: how each calendar counts, and Disconnect. Never writes to the calendar. */
export function CalendarSection({ g }: { g: GoogleStatusView }) {
  const setTreatments = useSetCalendarTreatments();
  const disconnect = useGoogleDisconnect();
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [deleteData, setDeleteData] = useState(false);

  const change = (id: string, name: string, treatment: string) => {
    setPending((m) => ({ ...m, [id]: treatment }));
    setTreatments.mutate([{ id, treatment }], {
      onSuccess: () => toast(`${name}: ${treatmentLabel(treatment)}`),
      onError: (e) => toast(e.message, 'error'),
      onSettled: () => setPending(({ [id]: _done, ...rest }) => rest),
    });
  };

  return (
    <div className="cal-section">
      <p className="caption" style={{ margin: 0 }}>
        {g.account ? `Signed in as ${g.account}` : 'Connected'} · {calendarSummary(g)}
        {g.lastSyncAt != null ? ` · synced ${relativeDay(g.lastSyncAt)}` : ''}
      </p>
      {g.calendars.length === 0 ? (
        <p className="caption">Your calendars appear here after the first sync.</p>
      ) : (
        <div className="cal-list">
          {g.calendars.map((c) => {
            const value = pending[c.id] ?? c.treatment;
            return (
              <div key={c.id} className="cal-row">
                <span className="er-text">
                  <span className="er-title">
                    {c.name}
                    {c.primary && <span className="badge cal-primary">Primary</span>}
                  </span>
                  <span className="er-subtitle">{[treatmentHint(value), c.events != null ? plural(c.events, 'event') : null].filter(Boolean).join(' · ')}</span>
                </span>
                <select
                  className="input input-sm"
                  aria-label={`How “${c.name}” counts`}
                  value={value}
                  disabled={c.id in pending}
                  onChange={(e) => change(c.id, c.name, e.target.value)}
                >
                  {g.treatments.map((t) => (
                    <option key={t} value={t}>
                      {treatmentLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(true)}>
          Disconnect Google Calendar
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Disconnect Google Calendar?"
        confirmLabel="Disconnect"
        danger
        busy={disconnect.isPending}
        onCancel={() => {
          setConfirm(false);
          setDeleteData(false);
        }}
        onConfirm={() =>
          disconnect.mutate(
            { deleteData },
            {
              onSuccess: () => {
                setConfirm(false);
                toast(deleteData ? 'Google Calendar disconnected and its synced data deleted.' : 'Google Calendar disconnected.');
                setDeleteData(false);
              },
              onError: (e) => toast(e.message, 'error'),
            },
          )
        }
      >
        <p>yeackbot stops reading your calendars. Your other Google connections (Gmail, Photos) are kept. You can connect again any time.</p>
        <label className="check-line">
          <input type="checkbox" checked={deleteData} disabled={disconnect.isPending} onChange={(e) => setDeleteData(e.target.checked)} />
          <span>Also delete the calendar events yeackbot synced (get-togethers built from them are retired overnight)</span>
        </label>
      </ConfirmDialog>
    </div>
  );
}


/** Settings → Google Calendar: how the OAuth callback went (?google=…), then Connect or the calendar list. */
export function GoogleCalendarPanel() {
  const [params, setParams] = useSearchParams();
  const outcome = googleOutcome(params.get('google'));
  const g = useGoogleStatus();
  const fix = g.data ? googleFix(null, g.data) : null;
  const dismiss = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('google');
        return next;
      },
      { replace: true },
    );
  return (
    <div className="card google-panel">
      {outcome && (
        <div className={`notice ${outcome.tone}`} role="status">
          <span>{outcome.text}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {g.isPending ? (
        <p className="caption">Loading…</p>
      ) : g.isError ? (
        <p className="caption">Google Calendar status isn’t available right now.</p>
      ) : fix ? (
        <FixBox fix={fix} reconnect={g.data.needsReconnect} />
      ) : (
        <CalendarSection g={g.data} />
      )}
    </div>
  );
}
