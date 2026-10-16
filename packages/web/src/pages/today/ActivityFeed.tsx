/**
 * "What the agent did": the journal feed grouped by run, per-change Undo/Redo, "Undo run…" with a dry-run preview,
 * filter chips by family, and bulk agent creations (roster-only people, service senders) collapsed into one row.
 */
import { useState, type ReactNode } from 'react';
import { isApiError } from '../../api/client';
import { useActivity, useUndo } from '../../api/hooks';
import type { ActivityBatch, ActivityRun, UndoResult } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icons } from '../../components/icons';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { mergeGroups, type ActivityGroup } from '../../lib/activity';
import { dateTime, percent, plural } from '../../lib/format';
import { batchKindLabel, runKindLabel } from '../../lib/labels';
import { collapseBulk, FAMILY_FILTERS, filterBatches, type Family, type FeedRow } from './logic';

/** Undo/redo of single batches, with the "undo later changes too?" question. Shared by the feed and Check these. */
export function useBatchUndo(): { undoOne: (b: ActivityBatch, redo?: boolean) => void; busyId: string | null; dialog: ReactNode } {
  const undoBatch = useUndo('batch');
  const toast = useToast();
  const [cascadeAsk, setCascadeAsk] = useState<{ batch: ActivityBatch; message: string } | null>(null);

  // Redo = undo the undo batch that reverted this one.
  const run = (b: ActivityBatch, cascade = false, redo = false) =>
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

  const dialog = (
    <ConfirmDialog
      open={cascadeAsk != null}
      title="Undo later changes too?"
      confirmLabel="Undo all of them"
      danger
      busy={undoBatch.isPending}
      onCancel={() => setCascadeAsk(null)}
      onConfirm={() => cascadeAsk && run(cascadeAsk.batch, true)}
    >
      <p>{cascadeAsk?.message}</p>
      <p className="caption">Later changes built on this one can’t stay without it.</p>
    </ConfirmDialog>
  );
  return { undoOne: (b, redo) => run(b, false, redo), busyId: undoBatch.isPending ? (undoBatch.variables?.id ?? null) : null, dialog };
}

export function BatchRow({ b, busy, onUndo, extra }: { b: ActivityBatch; busy: boolean; onUndo: (b: ActivityBatch, redo?: boolean) => void; extra?: ReactNode }) {
  const undone = b.undoneAt != null;
  return (
    <div className={undone ? 'batch undone' : 'batch'}>
      <div className="b-text">
        <div className="b-title">{b.title}</div>
        {extra}
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

/** Rows of a collapsed bulk group rendered per tap (a backfill can note thousands of people). */
const BULK_PAGE = 25;

function BulkRow({ row, busyId, onUndo }: { row: Extract<FeedRow, { type: 'bulk' }>; busyId: string | null; onUndo: (b: ActivityBatch, redo?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(BULK_PAGE);
  return (
    <div className="td-bulk">
      <button type="button" className="batch td-bulk-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="b-text">
          <span className="b-title">{row.label}</span>
          <span className="b-meta">
            <span className="pill">{plural(row.batches.length, 'change')}</span>
            {row.undone > 0 && <span className="pill">{row.undone} undone</span>}
            <span>{open ? 'Hide each one' : 'Show each one'}</span>
          </span>
        </span>
        <span className={open ? 'chevron open' : 'chevron'}>{Icons.chevron}</span>
      </button>
      {open && row.batches.slice(0, shown).map((b) => <BatchRow key={b.id} b={b} busy={busyId === b.id} onUndo={onUndo} />)}
      {open && row.batches.length > shown && (
        <div className="batch td-bulk-more">
          <button type="button" className="btn btn-sm btn-block" onClick={() => setShown((n) => n + BULK_PAGE)}>
            Show {Math.min(BULK_PAGE, row.batches.length - shown)} more of {row.batches.length - shown}
          </button>
        </div>
      )}
    </div>
  );
}

function RunCard({
  g,
  families,
  busyId,
  onUndoBatch,
  onUndoRun,
}: {
  g: ActivityGroup;
  families: ReadonlySet<Family>;
  busyId: string | null;
  onUndoBatch: (b: ActivityBatch, redo?: boolean) => void;
  onUndoRun: (run: ActivityRun) => void;
}) {
  const { run } = g;
  const batches = filterBatches(g.batches, families);
  if (batches.length === 0) return null;
  const live = g.batches.filter((b) => b.undoneAt == null && b.undoable && b.kind !== 'undo').length;
  const rows = collapseBulk(batches);
  return (
    <section className="run-card">
      <div className="run-head">
        <div>
          <div className="rh-title">{runKindLabel(run.kind)}</div>
          <div className="caption">
            {dateTime(run.startedAt)} · {plural(g.batches.length, 'change')}
            {batches.length !== g.batches.length ? ` (${batches.length} shown)` : ''}
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
      {rows.map((r) =>
        r.type === 'batch' ? (
          <BatchRow key={r.batch.id} b={r.batch} busy={busyId === r.batch.id} onUndo={onUndoBatch} />
        ) : (
          <BulkRow key={`${run.id}:${r.key}`} row={r} busyId={busyId} onUndo={onUndoBatch} />
        ),
      )}
    </section>
  );
}

export function ActivityFeed() {
  const q = useActivity();
  const undoRun = useUndo('run');
  const toast = useToast();
  const { undoOne, busyId, dialog } = useBatchUndo();
  const [families, setFamilies] = useState<Set<Family>>(new Set());
  const [runPreview, setRunPreview] = useState<{ run: ActivityRun; result: UndoResult } | null>(null);

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

  const visible = groups.filter((g) => filterBatches(g.batches, families).length > 0);
  const toggle = (f: Family) =>
    setFamilies((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  const preview = runPreview?.result;
  return (
    <>
      <div className="filter-chips" role="group" aria-label="Show only">
        {FAMILY_FILTERS.map((f) => (
          <button key={f.id} type="button" className="chip plain" aria-pressed={families.has(f.id)} onClick={() => toggle(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="card-list">
          <Empty title="Nothing like that in the loaded changes.">{q.hasNextPage ? 'Load older changes to look further back.' : null}</Empty>
        </div>
      ) : (
        visible.map((g) => <RunCard key={g.run.id} g={g} families={families} busyId={busyId} onUndoBatch={undoOne} onUndoRun={previewRun} />)
      )}
      {q.hasNextPage && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        </p>
      )}

      {dialog}

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
