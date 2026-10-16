import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CollectionChip, PairView, PersonChip as PersonChipDto } from '@yb/shared';
import { isApiError } from '../api/client';
import { isNotImplemented, useUndo } from '../api/hooks';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, PageState } from '../components/PageState';
import { PersonLink, personPath } from '../components/PersonLink';
import { useToast } from '../components/Toast';
import { date, percent } from '../lib/format';
import { sourceLabel } from '../lib/labels';
import { CollectionDot } from './circles/CollectionIcon';
import { collectionPath } from './circles/logic';
import { useConnectionWrong, usePair } from './person/api';
import { EdgeChipView, RelationChip } from './person/PersonConnections';
import { edgeTypeLabel, evidenceHref, gaugeArc, relationLabel, strengthPct, tierLabel } from './person/logic';
import './person/person.css';

function Gauge({ value, label }: { value: number; label: string }) {
  const w = 160;
  const r = 64;
  const cx = w / 2;
  const cy = 76;
  return (
    <svg className="pair-gauge" width={w} height={90} viewBox={`0 0 ${w} 90`} role="img" aria-label={label}>
      <path d={gaugeArc(1, cx, cy, r)} fill="none" stroke="var(--border)" strokeWidth={10} strokeLinecap="round" />
      {value > 0.005 && <path d={gaugeArc(value, cx, cy, r)} fill="none" stroke="var(--accent)" strokeWidth={10} strokeLinecap="round" />}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize={24} fontWeight={700} fill="var(--text-primary)">
        {strengthPct(value)}
      </text>
    </svg>
  );
}

function PersonBlock({ p }: { p: PersonChipDto }) {
  return (
    <PersonLink id={p.id} className="pair-person">
      <Avatar id={p.id} name={p.displayName} size={56} />
      <span className="pair-name">{p.displayName}</span>
    </PersonLink>
  );
}

function CollChips({ items }: { items: CollectionChip[] }) {
  if (!items.length) return <span className="caption muted">None</span>;
  return (
    <span className="chips">
      {items.map((c) => (
        <Link key={`${c.type}:${c.id}`} to={collectionPath(c.type, c.id)} className="chip plain">
          <CollectionDot color={c.color} />
          <span>{c.name}</span>
        </Link>
      ))}
    </span>
  );
}

/** Two overlapping circles with counts: only A · both · only B. */
function Venn({ v }: { v: PairView }) {
  const { both, onlyA, onlyB } = v.sharedCircles;
  const a = v.a.firstName ?? v.a.displayName;
  const b = v.b.firstName ?? v.b.displayName;
  return (
    <div className="venn-wrap">
      <svg className="venn" viewBox="0 0 220 120" role="img" aria-label={`${onlyA.length} circles only ${a}, ${both.length} shared, ${onlyB.length} only ${b}`}>
        <circle cx={82} cy={60} r={52} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1.5} opacity={0.85} />
        <circle cx={138} cy={60} r={52} fill="var(--surface-sunken)" stroke="var(--border-strong)" strokeWidth={1.5} opacity={0.85} />
        <text x={58} y={66} textAnchor="middle" fontSize={18} fontWeight={700} fill="var(--text-primary)">
          {onlyA.length}
        </text>
        <text x={110} y={66} textAnchor="middle" fontSize={20} fontWeight={800} fill="var(--accent-text)">
          {both.length}
        </text>
        <text x={162} y={66} textAnchor="middle" fontSize={18} fontWeight={700} fill="var(--text-primary)">
          {onlyB.length}
        </text>
      </svg>
      <dl className="venn-lists">
        <dt>Both</dt>
        <dd>
          <CollChips items={both} />
        </dd>
        <dt>Only {a}</dt>
        <dd>
          <CollChips items={onlyA} />
        </dd>
        <dt>Only {b}</dt>
        <dd>
          <CollChips items={onlyB} />
        </dd>
      </dl>
    </div>
  );
}

/** /p/:a/with/:b — how two people know each other: strength, relation, shared circles and the evidence. */
export function PairPage() {
  const { a = '', b = '' } = useParams();
  const q = usePair(a, b);
  const wrong = useConnectionWrong(a);
  const undo = useUndo('batch');
  const toast = useToast();
  const [confirmUndo, setConfirmUndo] = useState(false);

  if (q.isPending) return <PageState error={null} />;
  if (q.isError) {
    if (isNotImplemented(q.error))
      return (
        <div className="card-list">
          <Empty title="Connection pages aren’t available yet.">
            <Link to={personPath(a)}>Back to the person</Link>
          </Empty>
        </div>
      );
    if (isApiError(q.error) && (q.error.status === 404 || q.error.status === 400))
      return (
        <div className="card-list">
          <Empty title="No connection found between these two.">
            <Link to={personPath(a)}>Back to the person</Link>
          </Empty>
        </div>
      );
    return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const v = q.data;
  const retract = (body: { type?: string; labelId?: string }, what: string) =>
    wrong.mutate(
      { otherId: v.b.id, body },
      { onSuccess: () => toast(`Removed “${what}”. Undo from Today.`), onError: (e) => toast(e.message, 'error') },
    );
  // Batch ids are UUIDv7 (time-ordered): the greatest is the most recent change.
  const lastBatch = [...v.batchIds].sort().pop();

  return (
    <>
      <Link to={`${personPath(v.a.id)}?tab=connections`} className="back-link">
        ← {v.a.displayName}’s connections
      </Link>
      <div className="pair-header">
        <PersonBlock p={v.a} />
        <div className="pair-mid">
          <Gauge value={v.strength} label={`Connection strength ${strengthPct(v.strength)}`} />
          <span className="pill pill-accent">{tierLabel(v.tier)}</span>
        </div>
        <PersonBlock p={v.b} />
      </div>

      {(v.label || v.chips.length > 0) && (
        <section className="person-section">
          <h2 className="section-title">How they know each other</h2>
          <div className="edge-chips">
            {v.label && <RelationChip label={v.label} busy={wrong.isPending} onWrong={() => retract({ labelId: v.label!.id }, relationLabel(v.label!.label))} />}
            {v.chips.map((c) => (
              <EdgeChipView key={`${c.type}:${c.text}`} chip={c} busy={wrong.isPending} onWrong={() => retract({ type: c.type }, c.text)} />
            ))}
          </div>
          {v.label && v.label.confidence < 1 && (
            <p className="caption">
              {relationLabel(v.label.label)} · {percent(v.label.confidence)} sure · {v.label.origin === 'user' ? 'set by you' : v.label.origin === 'legacy' ? 'from Blackbook' : 'inferred'}
            </p>
          )}
        </section>
      )}

      <section className="person-section">
        <h2 className="section-title">Shared circles</h2>
        <Venn v={v} />
      </section>

      <section className="person-section">
        <h2 className="section-title">Evidence</h2>
        {v.timeline.length === 0 ? (
          <p className="caption">No evidence items kept.</p>
        ) : (
          <ol className="pair-timeline">
            {v.timeline.map((it, i) => {
              const href = evidenceHref(it.ref);
              const meta = [edgeTypeLabel(it.type), it.ref.source ? sourceLabel(it.ref.source) : null, it.at != null ? date(it.at) : null].filter(Boolean).join(' · ');
              const body = (
                <>
                  <span className="pt-title">{it.title}</span>
                  {it.quote && <span className="ev-quote">“{it.quote}”</span>}
                  <span className="ev-meta-line">{meta}</span>
                </>
              );
              return (
                <li key={`${it.ref.ref}:${i}`} className={`pt-item type-${it.type}`}>
                  <span className="pt-dot" aria-hidden />
                  {href ? (
                    <Link to={href} className="pt-body">
                      {body}
                    </Link>
                  ) : (
                    <span className="pt-body">{body}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {lastBatch && (
        <p className="pair-undo">
          <button type="button" className="btn btn-sm" onClick={() => setConfirmUndo(true)}>
            Undo the latest change to this connection
          </button>
        </p>
      )}
      <ConfirmDialog
        open={confirmUndo}
        title="Undo the latest change?"
        confirmLabel="Undo"
        busy={undo.isPending}
        onCancel={() => setConfirmUndo(false)}
        onConfirm={() =>
          lastBatch &&
          undo.mutate(
            { id: lastBatch },
            {
              onSuccess: (r) => {
                setConfirmUndo(false);
                toast(r.undone.length ? 'Undone. You can redo it from Today.' : 'Nothing to undo.');
              },
              onError: (e) => toast(e.message, 'error'),
            },
          )
        }
      >
        <p className="caption">This reverts the most recent agent change that wrote this relationship or its evidence. You can redo it from Today.</p>
      </ConfirmDialog>
    </>
  );
}
