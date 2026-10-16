import type { CheckThisItem } from '@yb/shared';
import { BatchRow, useBatchUndo } from './ActivityFeed';

/** Auto-applied changes with lower confidence from the last 7 days, pinned above the feed: confirm by leaving, or Undo. */
export function CheckThese({ items }: { items: CheckThisItem[] }) {
  const { undoOne, busyId, dialog } = useBatchUndo();
  if (items.length === 0) return null;
  return (
    <>
      <h2 className="section-title">Check these</h2>
      <p className="caption td-lead">Changes the agent made on its own but was less sure about. Leave the right ones; undo the rest.</p>
      <section className="run-card td-check">
        {items.map((c) => (
          <BatchRow key={c.batch.id} b={c.batch} busy={busyId === c.batch.id} onUndo={undoOne} extra={<div className="caption td-check-reason">{c.reason}</div>} />
        ))}
      </section>
      {dialog}
    </>
  );
}
