/**
 * Settings → Email & photos: the Gmail (ticket emails) and Google Photos (contact screenshots) connections. Each is its
 * own Google consent (/api/v1/google/connect?product=gmail|photos), so the callback lands here with ?gmail=… or
 * ?gphotos=…. Read-only toward Google: mail is never sent, labelled or deleted, and Photos only ever hands over the
 * pictures the owner picks. Disconnecting one keeps the others (Google's revoke would drop them all, so the server
 * revokes only when nothing else is connected).
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { GmailStatus, GphotosStatus } from '@yb/shared';
import { keys, useGmailDisconnect, useGmailStatus, useGphotosDisconnect, useGphotosSession, useGphotosStatus, useStartPick } from '../api/hooks';
import { relativeDay } from '../lib/format';
import {
  gmailSummary,
  gphotosSummary,
  healthProblem,
  pickerLink,
  productOutcome,
  sessionActive,
  sessionProgress,
  type GoogleProductKey,
} from '../lib/googleProducts';
import { googleProductFix } from '../lib/sources';
import { ConfirmDialog } from './ConfirmDialog';
import { FixBox } from './GoogleCalendar';
import { useToast } from './Toast';

/** How /google/callback went for this product (?gmail= / ?gphotos=), dismissible. */
function Outcome({ product }: { product: GoogleProductKey }) {
  const [params, setParams] = useSearchParams();
  const outcome = productOutcome(product, params.get(product));
  if (!outcome) return null;
  const dismiss = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(product);
        return next;
      },
      { replace: true },
    );
  return (
    <div className={`notice ${outcome.tone}`} role="status">
      <span>{outcome.text}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

const since = (at: number | null) => (at != null ? ` since ${relativeDay(at)}` : '');

/** The product's last error (an owner step such as enabling the API, or updating the Mac helper), when there is one. */
function HealthProblem({ s }: { s: Pick<GmailStatus | GphotosStatus, 'health'> }) {
  const problem = healthProblem(s.health);
  return problem ? (
    <p className="error-text" role="status" style={{ margin: 0 }}>
      {problem}
    </p>
  ) : null;
}

/** Disconnect + its confirmation, with the product's "also delete" choice. */
function DisconnectButton({
  label,
  title,
  body,
  deleteLabel,
  busy,
  onDisconnect,
}: {
  label: string;
  title: string;
  body: string;
  deleteLabel: string;
  busy: boolean;
  onDisconnect: (deleteData: boolean, done: () => void) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const close = () => {
    setConfirm(false);
    setDeleteData(false);
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(true)}>
        {label}
      </button>
      <ConfirmDialog open={confirm} title={title} confirmLabel="Disconnect" danger busy={busy} onCancel={close} onConfirm={() => onDisconnect(deleteData, close)}>
        <p>{body}</p>
        <label className="check-line">
          <input type="checkbox" checked={deleteData} disabled={busy} onChange={(e) => setDeleteData(e.target.checked)} />
          <span>{deleteLabel}</span>
        </label>
      </ConfirmDialog>
    </>
  );
}

function GmailConnected({ s }: { s: GmailStatus }) {
  const disconnect = useGmailDisconnect();
  const toast = useToast();
  return (
    <div className="cal-section">
      <p className="caption" style={{ margin: 0 }}>
        Connected{since(s.connectedAt)}
        {s.lastSyncAt != null ? ` · checked ${relativeDay(s.lastSyncAt)}` : ' · first check within 30 minutes'}
      </p>
      <p className="caption" style={{ margin: 0 }}>
        {gmailSummary(s)}
      </p>
      <HealthProblem s={s} />
      <div className="product-actions">
        <Link to="/tickets" className="btn btn-sm">
          See tickets
        </Link>
        <DisconnectButton
          label="Disconnect Gmail"
          title="Disconnect Gmail?"
          body="yeackbot stops reading your email. Your other Google connections (Calendar, Photos) are kept. You can connect again any time."
          deleteLabel="Also delete the ticket emails and events yeackbot recorded (get-togethers built from them are retired overnight)"
          busy={disconnect.isPending}
          onDisconnect={(deleteData, done) =>
            disconnect.mutate(
              { deleteData },
              {
                onSuccess: () => {
                  done();
                  toast(deleteData ? 'Gmail disconnected and its ticket records deleted.' : 'Gmail disconnected.');
                },
                onError: (e) => toast(e.message, 'error'),
              },
            )
          }
        />
      </div>
    </div>
  );
}

/** Settings → Gmail: the callback outcome, then Connect (or Reconnect) or what the ticket source has found. */
export function GmailPanel() {
  const g = useGmailStatus();
  const fix = g.data ? googleProductFix('gmail', g.data) : null;
  return (
    <div className="card google-panel">
      <Outcome product="gmail" />
      {g.isPending ? (
        <p className="caption">Loading…</p>
      ) : g.isError ? (
        <p className="caption">Gmail status isn’t available right now.</p>
      ) : fix ? (
        <FixBox fix={fix} reconnect={g.data.needsReconnect} />
      ) : (
        <GmailConnected s={g.data} />
      )}
    </div>
  );
}

/** Picking: start a Picker session, open Google's page in a new tab, then follow the session to the end. */
function PickScreenshots({ s }: { s: GphotosStatus }) {
  const start = useStartPick();
  const toast = useToast();
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(s.session?.id ?? null);
  const [link, setLink] = useState<string | null>(null);
  const session = useGphotosSession(sessionId);
  const view = session.data ?? (s.session && s.session.id === sessionId ? s.session : null);
  const active = view ? sessionActive(view) : false;

  // A session that stops moving has changed the counts: refresh them once, on that transition.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) void qc.invalidateQueries({ queryKey: keys.gphotos });
    wasActive.current = active;
  }, [qc, active]);

  const pick = () => {
    // Open the tab inside the tap (popup blockers allow only that), then send it to Google once the session exists.
    const tab = window.open('about:blank', '_blank');
    start.mutate(undefined, {
      onSuccess: (r) => {
        const url = pickerLink(r.pickerUri);
        if (!url) {
          tab?.close();
          toast('Google Photos sent an unexpected link. Try again.', 'error');
          return;
        }
        setSessionId(r.sessionId);
        setLink(url);
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        }
      },
      onError: (e) => {
        tab?.close();
        toast(e.message, 'error');
      },
    });
  };

  return (
    <div className="pick-box">
      <div className="product-actions">
        {/* Never blocked by a session still open: its Google tab may be gone (closed, or this page reloaded), and a new
            pick starts a new session while the old one expires on its own. */}
        <button type="button" className="btn btn-sm btn-primary" disabled={start.isPending} onClick={pick}>
          {start.isPending ? 'Opening Google Photos…' : view?.status === 'open' && !link ? 'Pick again' : 'Pick screenshots'}
        </button>
        {link && view?.status === 'open' && (
          <a className="btn btn-sm" href={link} target="_blank" rel="noopener noreferrer">
            Open Google Photos
          </a>
        )}
      </div>
      <p className="caption" style={{ margin: 0 }}>
        In Google Photos, search “screenshots” and select the contact ones (a contact card, an Instagram profile, a number someone showed you).
      </p>
      {view && (
        <p className={`caption pick-progress${active ? ' active' : ''}`} role="status" style={{ margin: 0 }}>
          {sessionProgress(view)}
        </p>
      )}
    </div>
  );
}

function GphotosConnected({ s }: { s: GphotosStatus }) {
  const disconnect = useGphotosDisconnect();
  const toast = useToast();
  return (
    <div className="cal-section">
      <p className="caption" style={{ margin: 0 }}>
        Connected{since(s.connectedAt)}
        {s.lastPickAt != null ? ` · last pick ${relativeDay(s.lastPickAt)}` : ''}
      </p>
      <p className="caption" style={{ margin: 0 }}>
        {gphotosSummary(s)}
      </p>
      <HealthProblem s={s} />
      <PickScreenshots s={s} />
      <div className="product-actions">
        <DisconnectButton
          label="Disconnect Google Photos"
          title="Disconnect Google Photos?"
          body="Screenshots waiting to be read are deleted from this Mac and any open pick is cancelled. Your other Google connections (Calendar, Gmail) are kept."
          deleteLabel="Also delete the screenshot records (the people they linked stay)"
          busy={disconnect.isPending}
          onDisconnect={(deleteData, done) =>
            disconnect.mutate(
              { deleteData },
              {
                onSuccess: () => {
                  done();
                  toast(deleteData ? 'Google Photos disconnected and its screenshot records deleted.' : 'Google Photos disconnected.');
                },
                onError: (e) => toast(e.message, 'error'),
              },
            )
          }
        />
      </div>
    </div>
  );
}

/** Settings → Google Photos: the callback outcome, then Connect or picking with its progress. */
export function GooglePhotosPanel() {
  const g = useGphotosStatus();
  const fix = g.data ? googleProductFix('gphotos', g.data) : null;
  return (
    <div className="card google-panel">
      <Outcome product="gphotos" />
      {g.isPending ? (
        <p className="caption">Loading…</p>
      ) : g.isError ? (
        <p className="caption">Google Photos status isn’t available right now.</p>
      ) : fix ? (
        <FixBox fix={fix} reconnect={g.data.needsReconnect} />
      ) : (
        <GphotosConnected s={g.data} />
      )}
    </div>
  );
}
