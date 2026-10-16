import { Link } from 'react-router';
import type { LoopAction, OpenLoop } from '@yb/shared';
import { Avatar } from '../../components/Avatar';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { usePersonLoops, useLoopAction } from './api';
import { evidenceHref, loopSubtitle } from './logic';
import { MoreMenu } from './MoreMenu';
import { QuerySection } from './Section';

const WEEK = 7 * 86_400_000;

const DONE_TOAST: Record<LoopAction['action'], string> = {
  done: 'Marked done.',
  snooze: 'Snoozed for a week.',
  dismiss: 'Dismissed.',
  wrong: 'Thanks — marked wrong.',
};

function LoopRow({ l, personId }: { l: OpenLoop; personId: string }) {
  const act = useLoopAction(personId);
  const toast = useToast();
  const run = (body: LoopAction) =>
    act.mutate(
      { type: l.type, id: l.id, body },
      {
        onSuccess: () => toast(`${DONE_TOAST[body.action]} Undo from Today.`),
        onError: (e) => toast(e.message, 'error'),
      },
    );
  const link = l.evidence.map(evidenceHref).find((h): h is string => !!h);
  return (
    <div className={l.likely ? 'loop-row likely' : 'loop-row'}>
      <span className={`loop-kind ${l.type}`} aria-hidden>
        {l.type === 'reply_debt' ? '↩' : '✓'}
      </span>
      <div className="loop-text">
        <div className="loop-title">
          {l.title}
          {l.urgency === 'high' && <span className="pill pill-bad new-badge">Soon</span>}
        </div>
        <div className="loop-sub">{loopSubtitle(l)}</div>
        {(l.otherPeople.length > 0 || link) && (
          <div className="chips loop-extra">
            {l.otherPeople.map((o) => (
              <PersonLink key={o.id} id={o.id} className="chip">
                <Avatar id={o.id} name={o.displayName} size={22} />
                <span>{o.displayName}</span>
              </PersonLink>
            ))}
            {link && (
              <Link to={link} className="chip plain">
                <span>Open message</span>
              </Link>
            )}
          </div>
        )}
      </div>
      <div className="loop-actions">
        <button type="button" className="btn btn-sm" disabled={act.isPending} onClick={() => run({ action: 'done' })}>
          Done
        </button>
        <MoreMenu
          items={[
            { label: 'Snooze 1 week', onSelect: () => run({ action: 'snooze', until: Date.now() + WEEK }) },
            { label: l.type === 'reply_debt' ? 'No reply needed' : 'Not happening', onSelect: () => run({ action: 'dismiss' }) },
            { label: 'Wrong', onSelect: () => run({ action: 'wrong' }), danger: true },
          ]}
        />
      </div>
    </div>
  );
}

/** Reply owed, promises (yours) and what you're waiting on from them, each with Done. */
export function OpenLoopsSection({ personId }: { personId: string }) {
  const q = usePersonLoops(personId);
  return (
    <QuerySection title="Open loops" query={q} hideWhenUnavailable>
      {(d) => {
        const groups: { title: string; items: OpenLoop[] }[] = [
          { title: 'Reply owed', items: d.replyDebts },
          { title: 'Promises', items: d.commitments },
          { title: 'Waiting on them', items: d.waitingOn },
        ].filter((g) => g.items.length > 0);
        if (!groups.length) return <p className="caption">Nothing open. No replies owed or promises pending.</p>;
        return (
          <div className="card-list">
            {groups.map((g) => (
              <div key={g.title} className="loop-group">
                {groups.length > 1 && <div className="loop-group-title">{g.title}</div>}
                {g.items.map((l) => (
                  <LoopRow key={`${l.type}:${l.id}`} l={l} personId={personId} />
                ))}
              </div>
            ))}
          </div>
        );
      }}
    </QuerySection>
  );
}
