import { useState } from 'react';
import type { FactView } from '@yb/shared';
import { useToast } from '../../components/Toast';
import { date, percent } from '../../lib/format';
import { sourceLabel } from '../../lib/labels';
import { useFacts, useFactWrong } from './api';
import { EvidenceList } from './Evidence';
import { factPrefix, groupFacts, isTentative } from './logic';
import { QuerySection } from './Section';
import { Sheet } from './Sheet';

const STATUS: Record<FactView['status'], string> = {
  candidate: 'Unconfirmed',
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  invalidated: 'No longer true',
  rejected: 'Marked wrong',
};

const FROM: Record<string, string> = {
  llm: 'inferred from messages',
  user_log: 'from your text log',
  legacy: 'from Blackbook',
  addressbook: 'from Contacts',
  user: 'added by you',
};
const fromLabel = (source: string) => FROM[source] ?? `from ${sourceLabel(source)}`;

function factText(f: FactView): string {
  const prefix = factPrefix(f.type);
  return prefix ? `${prefix} ${f.value}` : f.value;
}

function validity(f: FactView): string | null {
  if (f.validFrom != null && f.validTo != null) return `${date(f.validFrom)} – ${date(f.validTo)}`;
  if (f.validFrom != null) return `since ${date(f.validFrom)}`;
  if (f.validTo != null) return `until ${date(f.validTo)}`;
  return null;
}

function FactSheet({ f, personId, onClose }: { f: FactView; personId: string; onClose: () => void }) {
  const wrong = useFactWrong(personId);
  const toast = useToast();
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const active = f.status !== 'invalidated' && f.status !== 'rejected' && f.retractedAt == null;
  const meta = [STATUS[f.status], f.confidence < 1 ? `${percent(f.confidence)} sure` : null, f.support > 1 ? `seen ${f.support}×` : null, validity(f), fromLabel(f.source)]
    .filter(Boolean)
    .join(' · ');
  return (
    <Sheet
      open
      title={factText(f)}
      onClose={onClose}
      actions={
        active ? (
          confirming ? (
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={wrong.isPending}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={wrong.isPending}
                onClick={() =>
                  wrong.mutate(
                    { factId: f.id, note: note.trim() || undefined },
                    {
                      onSuccess: () => {
                        toast('Removed. It won’t be added again. Undo from Today.');
                        onClose();
                      },
                      onError: (e) => toast(e.message, 'error'),
                    },
                  )
                }
              >
                {wrong.isPending ? 'Removing…' : 'Remove it'}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirming(true)}>
              Wrong
            </button>
          )
        ) : undefined
      }
    >
      <p className="caption">
        {meta}
        {f.sensitive && <span className="badge fact-lock"> Private</span>}
      </p>
      {confirming ? (
        <label className="field">
          <span className="caption">What’s wrong? (optional, helps the agent learn)</span>
          <textarea className="input textarea" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      ) : (
        <>
          <h3 className="sub-title">Evidence</h3>
          <EvidenceList items={f.evidence} empty="No quotes kept for this one." />
        </>
      )}
    </Sheet>
  );
}

function FactChip({ f, onOpen }: { f: FactView; onOpen: () => void }) {
  return (
    <button type="button" className={isTentative(f) ? 'chip plain fact-chip tentative' : 'chip plain fact-chip'} onClick={onOpen} title="Why yeackbot thinks this">
      <span>{factText(f)}</span>
      {f.sensitive && (
        <span className="fact-lock" aria-label="Private">
          ●
        </span>
      )}
    </button>
  );
}

/** Facts & interests as chips; tap one for its evidence and a Wrong button. Past facts sit under History. */
export function FactsSection({ personId }: { personId: string }) {
  const q = useFacts(personId);
  const [open, setOpen] = useState<FactView | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <QuerySection title="Facts & interests" query={q} hideWhenUnavailable>
      {(d) => (
        <>
          {d.active.length === 0 ? (
            <p className="caption">Nothing learned yet. Interests, work and places appear here after the nightly run.</p>
          ) : (
            <div className="fact-groups">
              {groupFacts(d.active).map((g) => (
                <div key={g.group} className="fact-group">
                  <div className="fact-group-title">{g.group}</div>
                  <div className="chips">
                    {g.facts.map((f) => (
                      <FactChip key={f.id} f={f} onOpen={() => setOpen(f)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {d.history.length > 0 && (
            <div className="fact-history">
              <button type="button" className="btn btn-sm btn-ghost" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
                History ({d.history.length})
              </button>
              {showHistory && (
                <div className="chips">
                  {d.history.map((f) => (
                    <button key={f.id} type="button" className="chip plain fact-chip past" onClick={() => setOpen(f)}>
                      <span>{factText(f)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {open && <FactSheet f={open} personId={personId} onClose={() => setOpen(null)} />}
        </>
      )}
    </QuerySection>
  );
}
