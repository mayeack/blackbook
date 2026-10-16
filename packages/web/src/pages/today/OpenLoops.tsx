import { useState } from 'react';
import type { LoopAction, OpenLoop, OpenLoopCounts } from '@yb/shared';
import { Avatar } from '../../components/Avatar';
import { EntityRow } from '../../components/EntityRow';
import { Icons } from '../../components/icons';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { useToast } from '../../components/Toast';
import { date, relativeDay } from '../../lib/format';
import { useLoopAction, useLoops } from './api';
import { loopsLine, snoozeUntil } from './logic';
import { ActionMenu } from './Menu';

function dueText(l: OpenLoop): string | null {
  if (!l.due || l.due.precision === 'none') return null;
  const at = l.due.end ?? l.due.start;
  if (at == null) return l.due.precision === 'vague' ? 'no set date' : null;
  return `due ${l.due.precision === 'vague' ? '~' : ''}${date(at)}`;
}

function LoopRow({ loop }: { loop: OpenLoop }) {
  const act = useLoopAction();
  const toast = useToast();
  const isDebt = loop.type === 'reply_debt';
  const run = (body: LoopAction, done: string) =>
    act.mutate(
      { type: loop.type, id: loop.id, body },
      { onSuccess: () => toast(`${done} Undo it from the feed below.`), onError: (e) => toast(e.message, 'error') },
    );
  const others = loop.otherPeople.slice(0, 3);
  const due = dueText(loop);
  return (
    <EntityRow
      icon={
        <PersonLink id={loop.person.id} title={loop.person.displayName}>
          <Avatar id={loop.person.id} name={loop.person.displayName} />
        </PersonLink>
      }
      title={
        <>
          {loop.title}
          {loop.likely && <span className="pill td-inline-pill">likely</span>}
          {loop.urgency === 'high' && <span className="pill pill-warn td-inline-pill">urgent</span>}
        </>
      }
      subtitle={
        <>
          <PersonLink id={loop.person.id} className="td-plain-link">
            {loop.person.displayName}
          </PersonLink>
          {others.map((p) => (
            <span key={p.id}>
              {', '}
              <PersonLink id={p.id} className="td-plain-link">
                {p.displayName}
              </PersonLink>
            </span>
          ))}
          {' · '}
          {isDebt ? `asked ${relativeDay(loop.since)}` : loop.owner === 'them' ? `they said ${relativeDay(loop.since)}` : `you said ${relativeDay(loop.since)}`}
          {due ? ` · ${due}` : ''}
        </>
      }
      trailing={
        <>
          <button type="button" className="btn btn-sm" disabled={act.isPending} onClick={() => run({ action: 'done' }, isDebt ? 'Marked replied.' : 'Marked done.')}>
            {isDebt ? 'Replied' : 'Done'}
          </button>
          <ActionMenu
            label="⋯"
            ariaLabel="More"
            className="btn btn-sm btn-ghost"
            items={[
              { label: 'Snooze 1 week', onSelect: () => run({ action: 'snooze', until: snoozeUntil('1w') }, 'Snoozed for a week.') },
              { label: isDebt ? 'No reply needed' : 'Not happening', onSelect: () => run({ action: 'dismiss' }, 'Dismissed.') },
              { label: 'Wrong', danger: true, onSelect: () => run({ action: 'wrong' }, 'Thanks — taken back.') },
            ]}
          />
        </>
      }
    />
  );
}

function AllLoops() {
  const q = useLoops(true);
  if (!q.data) return <PageState error={q.error} onRetry={() => void q.refetch()} />;
  const pages = q.data.pages;
  const debts = pages.flatMap((p) => p.replyDebts);
  const mine = pages.flatMap((p) => p.commitments);
  const theirs = pages.flatMap((p) => p.waitingOn);
  const section = (title: string, xs: OpenLoop[]) =>
    xs.length > 0 && (
      <>
        <h3 className="sub-title td-loops-sub">{title}</h3>
        <div className="td-loops-list">
          {xs.map((l) => (
            <LoopRow key={`${l.type}:${l.id}`} loop={l} />
          ))}
        </div>
      </>
    );
  if (debts.length + mine.length + theirs.length === 0)
    return (
      <Empty title="No open loops.">Replies you owe and promises you made show up here.</Empty>
    );
  return (
    <>
      {section('Replies you owe', debts)}
      {section('Your promises', mine)}
      {section('Waiting on them', theirs)}
      {q.hasNextPage && (
        <p className="td-loops-more">
          <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </p>
      )}
    </>
  );
}

/** The Open loops strip: "2 replies owed · 1 promise", expanding to the list. */
export function OpenLoopsStrip({ counts, preview }: { counts: OpenLoopCounts; preview: OpenLoop[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const line = loopsLine(counts);
  const total = counts.replyDebts + counts.commitments + counts.waitingOn;
  return (
    <section className="td-loops" aria-label="Open loops">
      <button type="button" className="td-loops-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={total === 0}>
        <span className="td-loops-title">Open loops</span>
        <span className="td-loops-line">{line ?? 'nothing open'}</span>
        {total > 0 && <span className={open ? 'chevron open' : 'chevron'}>{Icons.chevron}</span>}
      </button>
      {open && total > 0 && (
        <div className="td-loops-body">
          {all || preview.length === 0 ? (
            <AllLoops />
          ) : (
            <>
              <div className="td-loops-list">
                {preview.map((l) => (
                  <LoopRow key={`${l.type}:${l.id}`} loop={l} />
                ))}
              </div>
              {total > preview.length && (
                <p className="td-loops-more">
                  <button type="button" className="btn btn-block" onClick={() => setAll(true)}>
                    Show all {total}
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
