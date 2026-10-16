import { useState } from 'react';
import { Link } from 'react-router';
import type { ConnectionEdge, EdgeChip, EdgeLabelView } from '@yb/shared';
import { isNotImplemented } from '../../api/hooks';
import type { PersonDetail } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { percent, relativeDay } from '../../lib/format';
import { stateLabel } from '../../lib/labels';
import { useConnections, useConnectionWrong } from './api';
import { EgoGraph } from './EgoGraph';
import { evidenceHref, pairPath, relationLabel, strengthPct, tierLabel } from './logic';

const TIERS = ['close', 'know', 'acquainted', 'faint'] as const;

/** An evidence chip ("11 shared group chats · most active 'Ski Trip 2026'") with its own inline Wrong. */
export function EdgeChipView({ chip, onWrong, busy }: { chip: EdgeChip; onWrong?: () => void; busy?: boolean }) {
  const href = chip.latest ? evidenceHref(chip.latest) : null;
  return (
    <span className={`edge-chip type-${chip.type}`}>
      {href ? (
        <Link to={href} className="edge-chip-text">
          {chip.text}
        </Link>
      ) : (
        <span className="edge-chip-text">{chip.text}</span>
      )}
      {chip.wrongable && onWrong && (
        <button type="button" className="chip-x" title="Wrong: remove this" aria-label={`Wrong: ${chip.text}`} disabled={busy} onClick={onWrong}>
          ✕
        </button>
      )}
    </span>
  );
}

export function RelationChip({ label, onWrong, busy }: { label: EdgeLabelView; onWrong?: () => void; busy?: boolean }) {
  return (
    <span className="edge-chip relation">
      <span className="edge-chip-text">
        {relationLabel(label.label)}
        {label.confidence < 0.9 && <span className="muted"> · {percent(label.confidence)}</span>}
        {label.origin === 'user' && <span className="muted"> · you</span>}
      </span>
      {onWrong && (
        <button type="button" className="chip-x" title="Wrong: remove this relationship" aria-label={`Wrong: ${relationLabel(label.label)}`} disabled={busy} onClick={onWrong}>
          ✕
        </button>
      )}
    </span>
  );
}

function ConnectionRow({ e, personId }: { e: ConnectionEdge; personId: string }) {
  const wrong = useConnectionWrong(personId);
  const toast = useToast();
  const retract = (body: { type?: string; labelId?: string }, what: string) =>
    wrong.mutate(
      { otherId: e.person.id, body },
      { onSuccess: () => toast(`Removed “${what}”. Undo from Today.`), onError: (err) => toast(err.message, 'error') },
    );
  const sub = [tierLabel(e.tier), strengthPct(e.strength), e.lastAt != null ? `latest ${relativeDay(e.lastAt)}` : null].filter(Boolean).join(' · ');
  return (
    <div className="conn-row">
      <div className="conn-head">
        <PersonLink id={e.person.id} className="conn-person">
          <Avatar id={e.person.id} name={e.person.displayName} />
          <span className="er-text">
            <span className="er-title">{e.person.displayName}</span>
            <span className="er-subtitle">
              {sub}
              {e.person.state ? ` · ${stateLabel(e.person.state)}` : ''}
            </span>
          </span>
        </PersonLink>
        <Link to={pairPath(personId, e.person.id)} className="btn btn-sm btn-ghost" aria-label={`How they know ${e.person.displayName}`}>
          How →
        </Link>
      </div>
      <div className="strength-bar" aria-hidden>
        <span style={{ width: strengthPct(e.strength) }} />
      </div>
      {(e.label || e.chips.length > 0) && (
        <div className="edge-chips">
          {e.label && <RelationChip label={e.label} busy={wrong.isPending} onWrong={() => retract({ labelId: e.label!.id }, relationLabel(e.label!.label))} />}
          {e.chips.map((c) => (
            <EdgeChipView key={`${c.type}:${c.text}`} chip={c} busy={wrong.isPending} onWrong={() => retract({ type: c.type }, c.text)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Connections tab: a mini ego graph, then everyone they're connected to by strength, with the evidence. */
export function PersonConnections({ p }: { p: PersonDetail }) {
  const q = useConnections(p.id);
  const [showFaint, setShowFaint] = useState(false);
  if (q.isError && isNotImplemented(q.error))
    return (
      <div className="card-list">
        <Empty title="Connections aren’t available yet.">Shared group chats and events between people appear here once the graph is built.</Empty>
      </div>
    );
  if (!q.data) return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  const edges = [...q.data.edges].sort((a, b) => b.strength - a.strength);
  if (edges.length === 0)
    return (
      <div className="card-list">
        <Empty title="No connections found yet.">When {p.firstName ?? p.displayName} shares group chats or events with people you know, they show up here.</Empty>
      </div>
    );
  const visible = showFaint ? edges : edges.filter((e) => e.tier !== 'faint');
  const faint = edges.length - edges.filter((e) => e.tier !== 'faint').length;
  return (
    <>
      <div className="card ego-card">
        <EgoGraph
          center={{ id: p.id, name: p.displayName }}
          neighbors={edges.map((e) => ({ id: e.person.id, name: e.person.displayName, strength: e.strength }))}
          among={q.data.among}
        />
        <p className="caption ego-caption">Closer to the middle = stronger connection. Tap anyone to open them.</p>
      </div>
      {TIERS.map((tier) => {
        const rows = visible.filter((e) => e.tier === tier);
        if (!rows.length) return null;
        return (
          <section key={tier} className="person-section">
            <h2 className="section-title">
              {tierLabel(tier)} · {rows.length}
            </h2>
            <div className="card-list">
              {rows.map((e) => (
                <ConnectionRow key={e.person.id} e={e} personId={p.id} />
              ))}
            </div>
          </section>
        );
      })}
      {faint > 0 && !showFaint && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-block" onClick={() => setShowFaint(true)}>
            Show {faint} faint connection{faint === 1 ? '' : 's'}
          </button>
        </p>
      )}
    </>
  );
}
