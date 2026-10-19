import { Link } from 'react-router';
import { Avatar } from '../../components/Avatar';
import { PersonLink } from '../../components/PersonLink';
import { date, relativeDay } from '../../lib/format';
import { spendUsd } from '../settings/logic';
import {
  citationHref,
  citationPersonId,
  isActive,
  isNeedsKeyAnswer,
  parseAnswer,
  parsePeopleList,
  superscript,
  toolLabel,
  type Block,
  type Inline,
  type LiveTurn,
  type ParsedPeopleList,
} from './logic';

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

/** Paragraphs and bullet lists; the caret follows the last block while the answer streams. */
function Blocks({ blocks, caret = false }: { blocks: Block[]; caret?: boolean }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>
            <Inlines items={b.inlines} />
            {caret && i === blocks.length - 1 && <span className="ask-caret" aria-hidden />}
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
    </>
  );
}

/**
 * A people answer as a table: one row per person (name links to their page), where they live, the answer's
 * detail for them with its citations, circles and last contact. Columns nobody has a value for are left out; on
 * a phone each row stacks into a card (details first, empty fields hidden).
 */
function PeopleTable({ rows }: { rows: ParsedPeopleList['rows'] }) {
  const city = rows.some((r) => r.row.city);
  const circles = rows.some((r) => r.row.circles.length > 0);
  const last = rows.some((r) => r.row.lastContactAt != null);
  return (
    <div className="ask-table-wrap">
      <table className="ask-people-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            {city && <th scope="col">Lives in</th>}
            <th scope="col">Details</th>
            {circles && <th scope="col">Circles</th>}
            {last && <th scope="col">Last contact</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, detail }) => (
            <tr key={row.person.id}>
              <th scope="row">
                <PersonLink id={row.person.id} className="ask-table-person">
                  <Avatar id={row.person.id} name={row.person.displayName} size={24} />
                  <span>{row.person.displayName}</span>
                </PersonLink>
              </th>
              {city && (
                <td data-label="Lives in" className={row.city ? undefined : 'empty'}>
                  {row.city ?? <span className="muted">—</span>}
                </td>
              )}
              <td data-label="Details" className={detail.length ? undefined : 'empty'}>
                {detail.length ? <Inlines items={detail} /> : <span className="muted">—</span>}
              </td>
              {circles && (
                <td data-label="Circles" className={row.circles.length ? undefined : 'empty'}>
                  {row.circles.length ? row.circles.join(', ') : <span className="muted">—</span>}
                </td>
              )}
              {last && (
                <td data-label="Last contact" className={row.lastContactAt != null ? undefined : 'empty'}>
                  {row.lastContactAt != null ? (
                    <time dateTime={new Date(row.lastContactAt).toISOString()} title={date(row.lastContactAt)}>
                      {relativeDay(row.lastContactAt)}
                    </time>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

/**
 * One answer: tool steps, streamed text with footnote citations and person chips, sources, people. A finished
 * answer that lists people is a table instead (citations stay on their row; no separate footnote list).
 */
export function Answer({ t, onRetry }: { t: LiveTurn; onRetry?: () => void }) {
  const active = isActive(t);
  const table = !active && t.list && t.list.rows.length > 0 ? parsePeopleList(t.list, t.citations) : null;
  const parsed = table ? null : parseAnswer(t.text, t.citations);
  const inTable = new Set(table?.rows.map((r) => r.row.person.id));
  const otherPeople = t.people.filter((p) => !inTable.has(p.id));
  const degraded = t.status === 'degraded';
  return (
    <div className={`ask-answer status-${t.status}`} aria-live={active ? 'polite' : undefined} aria-busy={active}>
      <ToolSteps t={t} />
      {degraded && (
        <p className="ask-degraded">
          <span className="badge">{isNeedsKeyAnswer(t.text) ? 'Needs AI key' : 'Plain search'}</span> No AI wrote this; it’s a local search.
        </p>
      )}
      {parsed && parsed.blocks.length > 0 && (
        <div className="ask-text">
          <Blocks blocks={parsed.blocks} caret={active} />
        </div>
      )}
      {table && (
        <div className="ask-text">
          <Blocks blocks={table.intro} />
          <PeopleTable rows={table.rows} />
          <Blocks blocks={table.note} />
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
      {parsed && parsed.footnotes.length > 0 && (
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
      {!active && otherPeople.length > 0 && (
        <div className="chips ask-people" aria-label={table ? 'Also mentioned' : 'People in this answer'}>
          {otherPeople.slice(0, 12).map((p) => (
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
