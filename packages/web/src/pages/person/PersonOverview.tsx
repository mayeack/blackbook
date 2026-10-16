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

function LinkedAccounts({ p }: { p: PersonDetail }) {
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

export function PersonOverview({ p }: { p: PersonDetail }) {
  return (
    <>
      <h2 className="section-title">Linked accounts</h2>
      <LinkedAccounts p={p} />
      {p.mergedCount > 0 && <p className="caption">Combined from {plural(p.mergedCount + 1, 'record')}.</p>}

      {(p.tags.length > 0 || p.locations.length > 0) && (
        <>
          <h2 className="section-title">Tags & places</h2>
          <div className="chips">
            {p.tags.map((t) => (
              <span key={`t:${t}`} className="chip plain">
                {t}
              </span>
            ))}
            {p.locations.map((l) => (
              <span key={`l:${l}`} className="chip plain">
                {l}
              </span>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Facts & open loops</h2>
      <div className="card-list">
        <Empty title="Nothing learned yet.">Interests, promises and replies you owe appear here once the nightly agent runs.</Empty>
      </div>
    </>
  );
}
