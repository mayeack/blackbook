import { useState } from 'react';
import type { MergeRecord } from '@yb/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { useToast } from '../../components/Toast';
import { date, percent } from '../../lib/format';
import { useMerges, useSplit } from './api';
import { QuerySection } from './Section';

const METHOD: Record<MergeRecord['method'], string> = {
  deterministic: 'Same phone, email or account',
  probabilistic: 'Likely the same person',
  llm_tiebreak: 'AI tie-break',
  user: 'Merged by you',
  legacy: 'From Blackbook',
  migration: 'Import',
};

/** Records combined into this person, newest first, each with Split (undo the merge + never merge again). */
export function MergeHistorySection({ personId, displayName }: { personId: string; displayName: string }) {
  const q = useMerges(personId);
  const split = useSplit(personId);
  const toast = useToast();
  const [target, setTarget] = useState<MergeRecord | null>(null);
  return (
    <QuerySection title="Merge history" query={q} hideWhenUnavailable>
      {(d) =>
        d.merges.length === 0 ? (
          <p className="caption">Nothing merged into {displayName}.</p>
        ) : (
          <>
            <div className="card-list">
              {[...d.merges]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((m) => {
                  const sub = [METHOD[m.method], m.score != null && m.score < 1 ? percent(m.score) : null, date(m.createdAt), ...m.reasons.slice(0, 2)]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <EntityRow
                      key={m.id}
                      className={m.undoneAt ? 'undone' : undefined}
                      icon={<IconTile>⇢</IconTile>}
                      title={
                        <>
                          {m.merged.displayName}
                          {m.undoneAt != null && <span className="pill new-badge">Split</span>}
                        </>
                      }
                      subtitle={sub}
                      trailing={
                        m.canSplit && m.undoneAt == null ? (
                          <button type="button" className="btn btn-sm" onClick={() => setTarget(m)}>
                            Split
                          </button>
                        ) : undefined
                      }
                    />
                  );
                })}
            </div>
            <ConfirmDialog
              open={target !== null}
              title={`Split ${target?.merged.displayName ?? ''} out?`}
              confirmLabel="Split"
              busy={split.isPending}
              onCancel={() => setTarget(null)}
              onConfirm={() =>
                target &&
                split.mutate(target.id, {
                  onSuccess: () => {
                    setTarget(null);
                    toast('Split. They won’t be merged again automatically.');
                  },
                  onError: (e) => toast(e.message, 'error'),
                })
              }
            >
              <p className="caption">
                Their accounts and history move back to a separate person, and yeackbot remembers not to merge the two again. You can undo this from Today.
              </p>
            </ConfirmDialog>
          </>
        )
      }
    </QuerySection>
  );
}
