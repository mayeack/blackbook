import { Link } from 'react-router';
import type { EvidenceRef } from '@yb/shared';
import { date } from '../../lib/format';
import { sourceLabel } from '../../lib/labels';
import { evidenceHref, evidenceLabel } from './logic';

/** One piece of evidence: label, short quote, source and date; links into the timeline / event / circle. */
export function EvidenceItem({ e }: { e: EvidenceRef }) {
  const href = evidenceHref(e);
  const label = evidenceLabel(e);
  // Don't repeat the source when the label already names it ("iMessage · Aug 3").
  const source = e.source && !label.includes(sourceLabel(e.source)) ? sourceLabel(e.source) : null;
  const meta = [source, e.at != null ? date(e.at) : null].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="ev-label">{label}</span>
      {e.quote && <span className="ev-quote">“{e.quote}”</span>}
      {meta && <span className="ev-meta-line">{meta}</span>}
    </>
  );
  return <li className="evidence-item">{href ? <Link to={href}>{body}</Link> : <span>{body}</span>}</li>;
}

export function EvidenceList({ items, empty = 'No evidence recorded.' }: { items: readonly EvidenceRef[]; empty?: string }) {
  if (!items.length) return <p className="caption">{empty}</p>;
  return (
    <ul className="evidence-list">
      {items.map((e) => (
        <EvidenceItem key={`${e.kind}:${e.ref}`} e={e} />
      ))}
    </ul>
  );
}
