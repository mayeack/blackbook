import { useState } from 'react';
import { isApiError } from '../api/client';
import { useActivity, useUndo } from '../api/hooks';
import type { ActivityBatch, ActivityRun, UndoResult } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, PageHeader, PageState } from '../components/PageState';
import { PersonLink } from '../components/PersonLink';
import { useToast } from '../components/Toast';
import { mergeGroups, type ActivityGroup } from '../lib/activity';
import { dateTime, percent, plural } from '../lib/format';
import { batchKindLabel, runKindLabel } from '../lib/labels';

function BatchRow({ b, busy, onUndo }: { b: ActivityBatch; busy: boolean; onUndo: (b: ActivityBatch, redo?: boolean) => void }) {
  const undone = b.undoneAt != null;
  return (
    <div className={undone ? 'batch undone' : 'batch'}>
      <div className="b-text">
        <div className="b-title">{b.title}</div>
        <div className="b-meta">
          <span className="pill">{batchKindLabel(b.kind)}</span>
          {b.confidence != null && b.confidence < 1 && <span className="pill pill-warn">{percent(b.confidence)} sure</span>}
          {b.actor !== 'agent' && <span>{b.actor === 'user' ? 'by you' : 'system'}</span>}
          <span>{dateTime(b.createdAt)}</span>
          {b.subjectPersonId && (
            <PersonLink id={b.subjectPersonId} className="chip plain">
              <span>View person</span>
            </PersonLink>
          )}
          {undone && <span className="pill">Undone</span>}
        </div>
      </div>
      {!undone && b.undoable && b.kind !== 'undo' && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onUndo(b)}>
          Undo
        </button>
      )}
      {undone && b.undoneByBatchId && b.kind !== 'undo' && (
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onUndo(b, true)}>
          Redo
        </button>
      )}
    </div>
  );
}

function RunCard({
  g,
  busyBatch,
  onUndoBatch,
  onUndoRun,
}: {
  g: ActivityGroup;
  busyBatch: string | null;
  onUndoBatch: (b: ActivityBatch, redo?: boolean) => void;
  onUndoRun: (run: ActivityRun) => void;
}) {
  const { run, batches } = g;
  const live = batches.filter((b) => b.undoneAt == null && b.undoable && b.kind !== 'undo').length;
  return (
    <section className="run-card">
      <div className="run-head">
        <div>
          <div className="rh-title">{runKindLabel(run.kind)}</div>
          <div className="caption">
            {dateTime(run.startedAt)} · {plural(batches.length, 'change')}
            {run.status === 'running' ? ' · running' : run.status !== 'ok' ? ` · ${run.status}` : ''}
          </div>
        </div>
        {run.undoneAt != null ? (
          <span className="pill">Run undone</span>
        ) : (
          live > 1 && (
            <button type="button" className="btn btn-sm" onClick={() => onUndoRun(run)}>
              Undo run…
            </button>
          )
        )}
      </div>
      {batches.map((b) => (
        <BatchRow key={b.id} b={b} busy={busyBatch === b.id} onUndo={onUndoBatch} />
      ))}
    </section>
  );
}

function ActivityFeed() {
  const q = useActivity();
  const undoBatch = useUndo('batch');
  const undoRun = useUndo('run');
  const toast = useToast();
  const [cascadeAsk, setCascadeAsk] = useState<{ batch: ActivityBatch; message: string } | null>(null);
  const [runPreview, setRunPreview] = useState<{ run: ActivityRun; result: UndoResult } | null>(null);

  // Redo = undo the undo batch that reverted this one.
  const undoOne = (b: ActivityBatch, cascade = false, redo = false) =>
    undoBatch.mutate(
      { id: redo && b.undoneByBatchId ? b.undoneByBatchId : b.id, cascade },
      {
        onSuccess: (r) => {
          setCascadeAsk(null);
          if (redo) toast(`Redid “${b.title}”.`);
          else toast(r.undone.length > 1 ? `Undid ${plural(r.undone.length, 'change')}.` : `Undid “${b.title}”.`);
        },
        onError: (e) => {
          if (!cascade && !redo && isApiError(e) && e.code === 'CASCADE_REQUIRED') return setCascadeAsk({ batch: b, message: e.message });
          setCascadeAsk(null);
          toast(e.message, 'error');
        },
      },
    );

  // Whole runs always get a dry-run preview first.
  const previewRun = (run: ActivityRun) =>
    undoRun.mutate(
      { id: run.id, dryRun: true, cascade: true },
      { onSuccess: (result) => setRunPreview({ run, result }), onError: (e) => toast(e.message, 'error') },
    );
  const confirmRun = () => {
    if (!runPreview) return;
    undoRun.mutate(
      { id: runPreview.run.id, cascade: runPreview.result.cascaded.length > 0 },
      {
        onSuccess: (r) => {
          setRunPreview(null);
          toast(`Undid ${plural(r.undone.length, 'change')}.`);
        },
        onError: (e) => {
          setRunPreview(null);
          toast(e.message, 'error');
        },
      },
    );
  };

  if (!q.data) return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  const groups = mergeGroups(q.data.pages.flatMap((p) => p.groups));
  if (groups.length === 0)
    return (
      <div className="card-list">
        <Empty title="No agent activity yet.">Merges, linked accounts and facts the agent adds will be listed here, each with Undo.</Empty>
      </div>
    );

  const preview = runPreview?.result;
  return (
    <>
      {groups.map((g) => (
        <RunCard
          key={g.run.id}
          g={g}
          busyBatch={undoBatch.isPending ? (undoBatch.variables?.id ?? null) : null}
          onUndoBatch={(b, redo) => undoOne(b, false, redo)}
          onUndoRun={previewRun}
        />
      ))}
      {q.hasNextPage && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        </p>
      )}

      <ConfirmDialog
        open={cascadeAsk != null}
        title="Undo later changes too?"
        confirmLabel="Undo all of them"
        danger
        busy={undoBatch.isPending}
        onCancel={() => setCascadeAsk(null)}
        onConfirm={() => cascadeAsk && undoOne(cascadeAsk.batch, true)}
      >
        <p>{cascadeAsk?.message}</p>
        <p className="caption">Later changes built on this one can’t stay without it.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={runPreview != null}
        title={`Undo this ${runPreview ? runKindLabel(runPreview.run.kind).toLowerCase() : 'run'}?`}
        confirmLabel={`Undo ${plural(preview?.undone.length ?? 0, 'change')}`}
        danger
        busy={undoRun.isPending}
        onCancel={() => setRunPreview(null)}
        onConfirm={confirmRun}
      >
        {preview && (
          <>
            <p>This reverts {plural(preview.undone.length, 'change')}:</p>
            <div className="chips">
              {Object.entries(preview.countsByKind).map(([kind, n]) => (
                <span key={kind} className="chip plain">
                  {batchKindLabel(kind)} · {n}
                </span>
              ))}
            </div>
            {preview.cascaded.length > 0 && (
              <p className="caption">Includes {plural(preview.cascaded.length, 'later change')} from other runs that depend on it.</p>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

export function TodayPage() {
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(Date.now());
  return (
    <>
      <PageHeader title="Today" sub={today} />
      <h2 className="section-title">Your brief</h2>
      <div className="card-list">
        <Empty title="Nothing needs you today.">The daily brief appears here once the agent loop is on.</Empty>
      </div>
      <h2 className="section-title">What the agent did</h2>
      <ActivityFeed />
    </>
  );
}
