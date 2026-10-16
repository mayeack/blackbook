/**
 * Settings → "What I've learned": per-kind propensity + trend, the 🎲 wildcard hit rate, muted and cooled people,
 * the adaptive item cap, and resets. Learning only tunes the ranker; thresholds never move from feedback.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import type { LearnerReset, LearnerState, SuggestionKind } from '@yb/shared';
import { isNotImplemented } from '../../api/hooks';
import { Avatar } from '../../components/Avatar';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntityRow } from '../../components/EntityRow';
import { Empty, PageHeader, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { date, dateTime, percent, plural } from '../../lib/format';
import { kindLabel, wildcardLabel } from '../today/logic';
import { useLearner, useLearnerReset, useLearnerUnmute } from './api';
import { sortKinds, trendText } from './learnedLogic';
import './settings.css';

function Bar({ value, muted }: { value: number; muted?: boolean }) {
  return (
    <span className={muted ? 'st-bar muted' : 'st-bar'} aria-hidden>
      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  );
}

function Kinds({ s, onReset, onUnmute, busy }: { s: LearnerState; onReset: (r: LearnerReset, label: string) => void; onUnmute: (kind: SuggestionKind) => void; busy: boolean }) {
  const kinds = sortKinds(s.kinds);
  if (kinds.length === 0)
    return (
      <div className="card-list">
        <Empty title="Nothing learned yet.">Done, Skip and Wrong on Today (or replies to the brief) teach the ranker what you act on.</Empty>
      </div>
    );
  return (
    <div className="card st-card st-kinds">
      {kinds.map((k) => {
        const t = trendText(k.trend, k.trendDelta);
        return (
          <div key={k.kind} className="st-kind">
            <div className="st-kind-head">
              <span className="st-kind-name">
                {kindLabel(k.kind)}
                {k.muted && <span className="pill pill-bad st-inline-pill">muted</span>}
              </span>
              <span className="st-kind-val">{percent(k.propensity)}</span>
              <span className={`st-trend ${k.trend}`} title="Change over the last 14 days">
                {t}
              </span>
            </div>
            <Bar value={k.propensity} muted={k.muted} />
            <div className="st-kind-meta">
              <span className="caption">
                {k.shown30d ? `acted on ${k.acted30d} of ${k.shown30d} in 30 days` : 'not shown in 30 days'}
              </span>
              {k.muted ? (
                <button type="button" className="st-linkbtn" disabled={busy} onClick={() => onUnmute(k.kind)}>
                  Unmute
                </button>
              ) : (
                <button type="button" className="st-linkbtn" disabled={busy} onClick={() => onReset({ scope: 'kind', kind: k.kind }, `what it learned about “${kindLabel(k.kind)}”`)}>
                  Reset
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Wildcards({ s, onReset, busy }: { s: LearnerState; onReset: (r: LearnerReset, label: string) => void; busy: boolean }) {
  const w = s.wildcard;
  return (
    <div className="card st-card">
      <div className="st-kv-line">
        <span>Chance per brief</span>
        <strong>{percent(w.epsilon)}</strong>
      </div>
      <div className="st-kv-line">
        <span>Hit rate</span>
        <strong>{w.hitRate == null ? 'none shown yet' : `${percent(w.hitRate)} (${w.acted} of ${w.shown})`}</strong>
      </div>
      {w.lastShownDate && (
        <div className="st-kv-line">
          <span>Last wildcard</span>
          <strong>{w.lastShownDate}</strong>
        </div>
      )}
      {w.generators.length > 0 && (
        <div className="st-gens">
          {w.generators.map((g) => (
            <div key={g.generator} className="st-gen">
              <span className="st-gen-name">🎲 {wildcardLabel(g.generator)}</span>
              <Bar value={g.propensity} />
              <span className="caption">
                {g.shown ? `${g.acted}/${g.shown}` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="caption st-lead">
        Never two days in a row. Change the chance in <Link to="/settings/agent">Agent</Link>.{' '}
        <button type="button" className="st-linkbtn" disabled={busy} onClick={() => onReset({ scope: 'wildcard' }, 'what it learned about wildcards')}>
          Reset wildcards
        </button>
      </p>
    </div>
  );
}

function People({ s, onReset, onUnmutePerson, busy }: {
  s: LearnerState;
  onReset: (r: LearnerReset, label: string) => void;
  onUnmutePerson: (personId: string, kind?: string) => void;
  busy: boolean;
}) {
  if (s.mutedPeople.length === 0 && s.cooledPeople.length === 0)
    return (
      <div className="card-list">
        <Empty title="No one muted or resting.">People you mute, or keep skipping, show up here so you can bring them back.</Empty>
      </div>
    );
  const avatar = (id: string, name: string) => (
    <PersonLink id={id} title={name}>
      <Avatar id={id} name={name} />
    </PersonLink>
  );
  const name = (id: string, n: string) => (
    <PersonLink id={id} className="st-plain-link">
      {n}
    </PersonLink>
  );
  return (
    <div className="card-list">
      {s.mutedPeople.map((m) => (
        <EntityRow
          key={`m:${m.person.id}`}
          icon={avatar(m.person.id, m.person.displayName)}
          title={name(m.person.id, m.person.displayName)}
          subtitle={`Muted${m.kinds.length ? ` for ${m.kinds.map((k) => kindLabel(k).toLowerCase()).join(', ')}` : ' for everything'}${m.since != null ? ` · since ${date(m.since)}` : ''}`}
          trailing={
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onUnmutePerson(m.person.id)}>
              Unmute
            </button>
          }
        />
      ))}
      {s.cooledPeople.map((c) => (
        <EntityRow
          key={`c:${c.person.id}`}
          icon={avatar(c.person.id, c.person.displayName)}
          title={name(c.person.id, c.person.displayName)}
          subtitle={`Resting until ${date(c.cooldownUntil)} · ${plural(c.consecutiveIgnores, 'ignore')} in a row`}
          trailing={
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onReset({ scope: 'person', personId: c.person.id }, `what it learned about ${c.person.firstName ?? c.person.displayName}`)}
            >
              Reset
            </button>
          }
        />
      ))}
    </div>
  );
}

export function LearnedPage() {
  const q = useLearner();
  const reset = useLearnerReset();
  const unmute = useLearnerUnmute();
  const toast = useToast();
  const [ask, setAsk] = useState<{ body: LearnerReset; label: string } | null>(null);
  const busy = reset.isPending || unmute.isPending;

  const doUnmute = (body: Parameters<typeof unmute.mutate>[0]) =>
    unmute.mutate(body, { onSuccess: () => toast('Unmuted.'), onError: (e) => toast(e.message, 'error') });

  const s = q.data;
  return (
    <>
      <Link to="/settings" className="back-link">
        ‹ Settings
      </Link>
      <PageHeader title="What I’ve learned" sub={s?.updatedAt != null ? `From your feedback · updated ${dateTime(s.updatedAt)}` : 'From your feedback on suggestions'} />
      {!s ? (
        isNotImplemented(q.error) ? (
          <div className="card-list">
            <Empty title="Not available on this server yet." />
          </div>
        ) : (
          <PageState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : (
        <>
          <p className="caption st-lead">
            Learning only changes the order of suggestions. Fading thresholds and merge rules never move on their own.
          </p>
          <h2 className="section-title">Kinds of suggestions</h2>
          <Kinds s={s} busy={busy} onReset={(body, label) => setAsk({ body, label })} onUnmute={(kind) => doUnmute({ kind })} />

          <h2 className="section-title">🎲 Wildcards</h2>
          <Wildcards s={s} busy={busy} onReset={(body, label) => setAsk({ body, label })} />

          <h2 className="section-title">Muted and resting people</h2>
          <People s={s} busy={busy} onReset={(body, label) => setAsk({ body, label })} onUnmutePerson={(personId) => doUnmute({ personId })} />

          <h2 className="section-title">Brief length</h2>
          <div className="card st-card">
            <div className="st-kv-line">
              <span>Items per brief now</span>
              <strong>{s.adaptiveCap.current}</strong>
            </div>
            <div className="st-kv-line">
              <span>Later items acted on (3 weeks)</span>
              <strong>{s.adaptiveCap.lateActRate == null ? 'not enough data' : percent(s.adaptiveCap.lateActRate)}</strong>
            </div>
            <p className="caption st-lead">Drops to 3 when items after the third are rarely acted on; rises to 5 when they often are.</p>
          </div>

          <p className="st-foot">
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => setAsk({ body: { scope: 'all' }, label: 'everything it learned' })}>
              Reset everything
            </button>
          </p>
        </>
      )}

      <ConfirmDialog
        open={ask != null}
        title="Reset?"
        confirmLabel="Reset"
        danger
        busy={reset.isPending}
        onCancel={() => setAsk(null)}
        onConfirm={() =>
          ask &&
          reset.mutate(ask.body, {
            onSuccess: (r) => {
              setAsk(null);
              toast(r.reset ? `Reset ${plural(r.reset, 'learned value')}.` : 'Nothing to reset.');
            },
            onError: (e) => {
              setAsk(null);
              toast(e.message, 'error');
            },
          })
        }
      >
        <p>This forgets {ask?.label} and starts again from neutral. Mutes stay as they are.</p>
      </ConfirmDialog>
    </>
  );
}
