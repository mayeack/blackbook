import { useState } from 'react';
import type { EvalItem, EvalVerdict } from '@yb/shared';
import { useToast } from '../../../components/Toast';
import { date, dateTime } from '../../../lib/format';
import { useEvalLabel } from '../api';
import { PersonPicker, PickedPerson } from '../PersonPicker';
import { buildLabelInput, canSave, initialVerdicts, SET_LABELS, setHint, type Verdicts } from './logic';

const VERDICTS: { id: EvalVerdict; label: string }[] = [
  { id: 'correct', label: 'Correct' },
  { id: 'incorrect', label: 'Incorrect' },
  { id: 'unsure', label: 'Unsure' },
];

/** One golden item: the window (context lines greyed), each prediction with Correct / Incorrect / Unsure, and what's missing. */
export function EvalItemCard({ item }: { item: EvalItem }) {
  const save = useEvalLabel();
  const toast = useToast();
  const [verdicts, setVerdicts] = useState<Verdicts>(() => initialVerdicts(item));
  const [missing, setMissing] = useState(() => (item.label?.missing ?? []).join('\n'));
  const [note, setNote] = useState(item.label?.note ?? '');
  const [expected, setExpected] = useState<string[]>(() => [...item.expectedPersonIds]);
  const ready = canSave(item, verdicts);
  const judged = item.predictions.filter((p) => verdicts[p.id] != null).length;

  return (
    <article className="card st-eval">
      <div className="st-eval-head">
        <div>
          <h3 className="st-eval-title">{item.title}</h3>
          <div className="caption">
            {SET_LABELS[item.set]}
            {item.promptVersion ? ` · prompt ${item.promptVersion}` : ''} · {date(item.createdAt)}
            {item.label ? ` · labeled ${dateTime(item.label.labeledAt)}` : ''}
          </div>
        </div>
        {item.label && <span className="pill pill-ok">Labeled</span>}
      </div>
      <p className="caption st-eval-hint">{setHint(item.set)}</p>

      {item.lines.length > 0 && (
        <ol className="st-lines" aria-label="Messages">
          {item.lines.map((l) => (
            <li key={l.ref} className={l.context ? 'context' : undefined}>
              <span className="st-line-author">{l.author}</span>
              <span className="st-line-text">{l.text}</span>
              <span className="st-line-ref mono">
                {l.ref}
                {l.at != null ? ` · ${dateTime(l.at)}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}

      <h4 className="sub-title">What it predicted {item.predictions.length > 0 && <span className="caption">({judged}/{item.predictions.length} judged)</span>}</h4>
      {item.predictions.length === 0 ? (
        <p className="caption">Nothing. If something should have been found, add it below.</p>
      ) : (
        <ul className="st-preds">
          {item.predictions.map((p) => (
            <li key={p.id} className="st-pred">
              <div className="st-pred-text">
                <span className="pill">{p.kind.replace(/_/g, ' ')}</span> <strong>{p.label}</strong>
                {p.detail && <div className="caption">{p.detail}</div>}
                {p.refs.length > 0 && <div className="caption mono">{p.refs.join(' ')}</div>}
              </div>
              <div className="st-verdicts" role="group" aria-label={`Verdict for ${p.label}`}>
                {VERDICTS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={`chip plain st-verdict ${v.id}`}
                    aria-pressed={verdicts[p.id] === v.id}
                    onClick={() => setVerdicts((cur) => ({ ...cur, [p.id]: v.id }))}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {item.set === 'ask' && (
        <>
          <h4 className="sub-title">People the answer should find</h4>
          {expected.length > 0 && (
            <div className="card-list st-sublist">
              {expected.map((id) => (
                <PickedPerson key={id} id={id} onRemove={() => setExpected((xs) => xs.filter((x) => x !== id))} />
              ))}
            </div>
          )}
          <PersonPicker exclude={expected} onPick={(id) => setExpected((xs) => (xs.includes(id) ? xs : [...xs, id]))} placeholder="Add an expected person…" />
        </>
      )}

      <label className="sub-title st-block-label" htmlFor={`miss-${item.id}`}>
        Missing <span className="caption">(one per line)</span>
      </label>
      <textarea id={`miss-${item.id}`} className="input st-textarea" rows={2} value={missing} onChange={(e) => setMissing(e.target.value)} />
      <label className="sub-title st-block-label" htmlFor={`note-${item.id}`}>
        Note <span className="caption">(optional)</span>
      </label>
      <textarea id={`note-${item.id}`} className="input st-textarea" rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />

      <div className="st-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || save.isPending}
          onClick={() =>
            save.mutate(buildLabelInput(item, verdicts, missing, note, expected), {
              onSuccess: () => toast('Label saved.'),
              onError: (e) => toast(e.message, 'error'),
            })
          }
        >
          {save.isPending ? 'Saving…' : item.label ? 'Update label' : 'Save label'}
        </button>
        {!ready && <span className="caption">Judge every prediction first (“Unsure” is fine).</span>}
      </div>
    </article>
  );
}
