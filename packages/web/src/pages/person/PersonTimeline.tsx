import { useState } from 'react';
import { useSessionMessages, useTimeline } from '../../api/hooks';
import type { InteractionItem, PersonDetail, SessionItem, SessionMessage } from '../../api/types';
import { EntityRow, IconTile } from '../../components/EntityRow';
import { Icons } from '../../components/icons';
import { Empty, PageState } from '../../components/PageState';
import { PersonLink } from '../../components/PersonLink';
import { SourceTile } from '../../components/SourceBadge';
import { plural, span, time } from '../../lib/format';
import { interactionLabel, sourceLabel } from '../../lib/labels';

const firstName = (p: PersonDetail) => p.firstName || p.displayName.split(/\s+/)[0] || p.displayName;

function sessionTitle(s: SessionItem, p: PersonDetail): string {
  if (s.title) return s.title;
  if (s.conversationKind === 'direct') return `Messages with ${firstName(p)}`;
  if (s.conversationKind === 'group') return s.memberCount ? `Group chat · ${s.memberCount} people` : 'Group chat';
  return sourceLabel(s.source);
}

function sessionMeta(s: SessionItem, p: PersonDetail): string {
  const parts = [span(s.startedAt, s.endedAt), plural(s.msgCount, 'message')];
  if (s.conversationKind === 'group') {
    if (s.fromThem > 0) parts.push(`${s.fromThem} from ${firstName(p)}`);
    if (s.fromMe > 0) parts.push(`${s.fromMe} from you`);
  }
  return parts.join(' · ');
}

const sameSender = (a: SessionMessage | undefined, b: SessionMessage) =>
  !!a && a.isFromMe === b.isFromMe && a.sender?.personId === b.sender?.personId && a.sender?.label === b.sender?.label;

function Bubbles({ messages, group }: { messages: SessionMessage[]; group: boolean }) {
  return (
    <div className="bubbles">
      {messages.map((m, i) => {
        if (m.kind === 'system' || m.kind === 'group_event')
          return (
            <div key={m.id} className="bubble system">
              {m.text ?? 'Group update'} · {time(m.sentAt)}
            </div>
          );
        const showSender = group && !m.isFromMe && !sameSender(messages[i - 1], m);
        const label = m.sender?.label ?? 'Someone';
        return (
          <div key={m.id} className={m.isFromMe ? 'bubble-row mine' : 'bubble-row'}>
            {showSender &&
              (m.sender?.personId ? (
                <PersonLink id={m.sender.personId} className="bubble-sender">
                  {label}
                </PersonLink>
              ) : (
                <span className="bubble-sender">{label}</span>
              ))}
            <div className="bubble">
              {m.retracted ? <em className="muted">Unsent</em> : (m.text ?? <em className="muted">{m.hasAttachments ? 'Attachment' : 'No text'}</em>)}
              <span className="meta">
                {time(m.sentAt)}
                {m.edited ? ' · edited' : ''}
              </span>
            </div>
            {m.reactions.length > 0 && (
              <div className="reactions" aria-label="Reactions">
                {m.reactions.map((r) => (
                  <span key={r.emoji}>
                    {r.emoji}
                    {r.count > 1 ? ` ${r.count}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SessionCard({ s, p }: { s: SessionItem; p: PersonDetail }) {
  const [open, setOpen] = useState(false);
  const msgs = useSessionMessages(p.id, s.id, open);
  return (
    <div className="tl-card">
      <button type="button" className="tl-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SourceTile source={s.source} />
        <span className="er-text">
          <span className="tl-title">{sessionTitle(s, p)}</span>
          <span className="tl-meta">{sessionMeta(s, p)}</span>
        </span>
        <span className={open ? 'chevron open' : 'chevron'}>{Icons.chevron}</span>
      </button>
      {open && (
        <div className="tl-body">
          {msgs.isPending || msgs.isError ? (
            <PageState error={msgs.error} onRetry={() => void msgs.refetch()} />
          ) : (
            <>
              <Bubbles messages={msgs.data.messages} group={s.conversationKind === 'group'} />
              {msgs.data.truncated && <p className="caption">Showing the first {msgs.data.messages.length} messages of this conversation.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const INTERACTION_ICONS: Record<string, keyof typeof Icons> = { call: 'call', event: 'calendar', occasion: 'calendar', meeting: 'calendar' };

function InteractionCard({ it }: { it: InteractionItem }) {
  return (
    <div className="tl-card">
      <EntityRow
        icon={<IconTile accent>{Icons[INTERACTION_ICONS[it.kind] ?? 'note']}</IconTile>}
        title={it.title ?? interactionLabel(it.kind)}
        subtitle={`${interactionLabel(it.kind)} · ${span(it.startedAt, it.endedAt)}`}
      />
    </div>
  );
}

export function PersonTimeline({ p }: { p: PersonDetail }) {
  const t = useTimeline(p.id);
  if (!t.data) return <PageState error={t.error} onRetry={() => void t.refetch()} />;
  const items = t.data.pages.flatMap((pg) => pg.items);
  if (items.length === 0)
    return (
      <div className="card-list">
        <Empty title="No conversations yet.">Messages, calls and get-togethers with {firstName(p)} show up here.</Empty>
      </div>
    );
  return (
    <>
      <div className="timeline">
        {items.map((it) => (it.type === 'session' ? <SessionCard key={it.id} s={it} p={p} /> : <InteractionCard key={it.id} it={it} />))}
      </div>
      {t.hasNextPage && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-block" disabled={t.isFetchingNextPage} onClick={() => void t.fetchNextPage()}>
            {t.isFetchingNextPage ? 'Loading…' : 'Load older'}
          </button>
        </p>
      )}
    </>
  );
}
