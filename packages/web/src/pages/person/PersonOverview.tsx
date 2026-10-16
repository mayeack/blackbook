import { useState } from 'react';
import { useReveal } from '../../api/hooks';
import type { PersonDetail } from '../../api/types';
import { EntityRow } from '../../components/EntityRow';
import { Empty } from '../../components/PageState';
import { SourceTile } from '../../components/SourceBadge';
import { useToast } from '../../components/Toast';
import { accountSubtitle, confidenceTone, orderAccounts } from '../../lib/accounts';
import { percent, plural } from '../../lib/format';
import { identityNetwork } from '../../lib/labels';
import { PersonCollectionsSection } from './Collections';
import { FactsSection } from './Facts';
import { OpenLoopsSection } from './Loops';
import { MergeHistorySection } from './Merges';
import { NotesSection } from './Notes';
import { StartersSection } from './Starters';

export function LinkedAccounts({ p }: { p: PersonDetail }) {
  const reveal = useReveal(p.id);
  const toast = useToast();
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  if (p.identities.length === 0)
    return (
      <div className="card-list">
        <Empty title="No linked accounts yet." />
      </div>
    );

  return (
    <div className="card-list">
      {orderAccounts(p.identities).map((i) => {
        const shown = revealed[i.id];
        const name = i.displayName && i.displayName !== i.value ? i.displayName : null;
        return (
          <EntityRow
            key={i.id}
            icon={<SourceTile source={identityNetwork(i.kind, i.source)} />}
            title={
              <>
                <span className="wrap-anywhere">{shown ?? i.value}</span>
                {name && <span className="muted"> · {name}</span>}
              </>
            }
            subtitle={accountSubtitle(i)}
            trailing={
              <>
                {i.confidence < 1 && (
                  <span className={`pill ${confidenceTone(i.confidence)}`} title="Match confidence">
                    {percent(i.confidence)}
                  </span>
                )}
                {i.revealable ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={reveal.isPending && reveal.variables === i.id}
                    onClick={() => {
                      if (shown) {
                        setRevealed(({ [i.id]: _gone, ...rest }) => rest);
                        return;
                      }
                      reveal.mutate(i.id, {
                        onSuccess: (r) => setRevealed((m) => ({ ...m, [r.id]: r.value })),
                        onError: (e) => toast((e as Error).message, 'error'),
                      });
                    }}
                  >
                    {shown ? 'Hide' : 'Reveal'}
                  </button>
                ) : null}
              </>
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Overview, in order: open loops, conversation starters (copy-only), facts & interests, linked accounts, circles /
 * tags / places, notes, merge history. Each section loads on its own; one that isn't available yet stays out.
 */
export function PersonOverview({ p }: { p: PersonDetail }) {
  return (
    <>
      <OpenLoopsSection personId={p.id} />
      <StartersSection personId={p.id} />
      <FactsSection personId={p.id} />

      <section className="person-section">
        <h2 className="section-title">Linked accounts</h2>
        <LinkedAccounts p={p} />
        {p.mergedCount > 0 && <p className="caption">Combined from {plural(p.mergedCount + 1, 'record')}.</p>}
      </section>

      <PersonCollectionsSection p={p} />
      <NotesSection personId={p.id} />
      {p.mergedCount > 0 && <MergeHistorySection personId={p.id} displayName={p.displayName} />}
    </>
  );
}
