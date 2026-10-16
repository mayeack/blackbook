import { Link } from 'react-router';
import { Avatar } from '../../components/Avatar';
import { PersonLink } from '../../components/PersonLink';
import { spendUsd } from '../settings/logic';
import { citationHref, citationPersonId, isActive, isNeedsKeyAnswer, parseAnswer, superscript, toolLabel, type Inline, type LiveTurn } from './logic';

function InlineView({ x }: { x: Inline }) {
  if (x.kind === 'text') return <>{x.text}</>;
  if (x.kind === 'person') {
    const pid = citationPersonId(x.citation);
    return pid ? (
      <PersonLink id={pid} className="chip ask-person">
        <Avatar id={pid} name={x.citation.label} size={18} />
        <span>{x.citation.label}</span>
      </PersonLink>
    ) : (
      <strong>{x.citation.label}</strong>
    );
  }
  const href = citationHref(x.citation);
  const mark = superscript(x.n);
  return (
    <sup className="ask-cite">
      {href ? (
        <Link to={href} title={x.citation.label} aria-label={`Source ${x.n}: ${x.citation.label}`}>
          {mark}
        </Link>
      ) : (
        <span title={x.citation.label}>{mark}</span>
      )}
    </sup>
  );
}

const Inlines = ({ items }: { items: Inline[] }) => (
  <>
    {items.map((x, i) => (
      <InlineView key={i} x={x} />
    ))}
  </>
);

function ToolSteps({ t }: { t: LiveTurn }) {
  if (!t.tools.length) return t.status === 'pending' ? <p className="ask-tools caption">Thinking…</p> : null;
  const active = isActive(t);
  return (
    <ul className={active ? 'ask-tools' : 'ask-tools settled'} aria-label="What Ask looked at">
      {t.tools.map((s, i) => (
        <li key={i} className={`tool-${s.status}`}>
          <span className="tool-icon" aria-hidden>
            {s.status === 'running' ? <span className="spinner" /> : s.status === 'done' ? '✓' : '!'}
          </span>
          <span>
            {toolLabel(s)}
            {s.count != null && s.status === 'done' && !/\d/.test(s.summary ?? '') && <span className="muted"> · {s.count}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One answer: tool steps, streamed text with footnote citations and person chips, sources, people. */
export function Answer({ t, onRetry }: { t: LiveTurn; onRetry?: () => void }) {
  const parsed = parseAnswer(t.text, t.citations);
  const active = isActive(t);
  const degraded = t.status === 'degraded';
  return (
    <div className={`ask-answer status-${t.status}`} aria-live={active ? 'polite' : undefined} aria-busy={active}>
      <ToolSteps t={t} />
      {degraded && (
        <p className="ask-degraded">
          <span className="badge">{isNeedsKeyAnswer(t.text) ? 'Needs AI key' : 'Plain search'}</span> No AI wrote this; it’s a local search.
        </p>
      )}
      {parsed.blocks.length > 0 && (
        <div className="ask-text">
          {parsed.blocks.map((b, i) =>
            b.kind === 'p' ? (
              <p key={i}>
                <Inlines items={b.inlines} />
                {active && i === parsed.blocks.length - 1 && <span className="ask-caret" aria-hidden />}
              </p>
            ) : (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines items={it} />
                  </li>
                ))}
              </ul>
            ),
          )}
        </div>
      )}
      {t.status === 'error' && (
        <div className="error-box" role="alert">
          {t.error?.message ?? 'Ask hit a problem.'}{' '}
          {onRetry && (
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Ask again
            </button>
          )}
        </div>
      )}
      {t.status === 'stopped' && <p className="caption">Stopped.</p>}
      {parsed.footnotes.length > 0 && (
        <ol className="ask-footnotes" aria-label="Sources">
          {parsed.footnotes.map((f) => {
            const href = citationHref(f.citation);
            const label = (
              <>
                <span className="fn-n">{superscript(f.n)}</span> {f.citation.label}
              </>
            );
            return <li key={f.n}>{href ? <Link to={href}>{label}</Link> : <span>{label}</span>}</li>;
          })}
        </ol>
      )}
      {!active && t.people.length > 0 && (
        <div className="chips ask-people" aria-label="People in this answer">
          {t.people.slice(0, 12).map((p) => (
            <PersonLink key={p.id} id={p.id} className="chip">
              <Avatar id={p.id} name={p.displayName} size={22} />
              <span>{p.displayName}</span>
            </PersonLink>
          ))}
        </div>
      )}
      {!active && t.usage && t.usage.toolCalls > 0 && (
        <p className="caption ask-usage">
          {t.usage.toolCalls} lookup{t.usage.toolCalls === 1 ? '' : 's'}
          {t.usage.costUsd > 0 ? ` · ${t.usage.costUsd < 0.0001 ? '<$0.0001' : spendUsd(t.usage.costUsd)}` : ''}
        </p>
      )}
    </div>
  );
}
