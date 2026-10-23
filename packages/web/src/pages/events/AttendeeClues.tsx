import { useId, useRef, useState, type ReactNode } from 'react';
import { useAttendeeClues } from '../../api/hooks';
import type { AttendeeClues, Clue, ClueMessage } from '../../api/types';
import { relativeToEvent } from '../../lib/events';
import { dateTime, percent } from '../../lib/format';
import { clueLabel } from '../../lib/labels';
import './clues.css';

const MESSAGES_PER_CLUE = 3;
/** Hover intent: a pointer passing over a row doesn't open its card. */
const OPEN_DELAY_MS = 180;

function MessageLine({ m, c }: { m: ClueMessage; c: AttendeeClues }) {
  const who = m.fromMe ? 'You' : (m.sender ?? (m.where === 'dm' ? c.displayName : 'Someone'));
  const where = m.where === 'group' ? ` in ${m.chat ? `“${m.chat}”` : 'a group chat'}` : '';
  return (
    <li className="clue-msg">
      <span className="clue-msg-meta">
        {who}
        {where} · {dateTime(m.sentAt)} · {relativeToEvent(m.sentAt, c.startsAt, c.endsAt)}
      </span>
      <span className="clue-msg-text">{m.text ? `“${m.text}”` : m.attachment ? 'A photo or attachment' : 'Unsent message'}</span>
    </li>
  );
}

function ClueItem({ clue, c }: { clue: Clue; c: AttendeeClues }) {
  const shown = clue.messages.slice(-MESSAGES_PER_CLUE);
  return (
    <li className="clue">
      <span className="clue-head">
        <span className="clue-label">{clueLabel(clue.type)}</span>
        <span className="clue-weight" title="How much this clue counts on its own">
          {percent(clue.weight)}
        </span>
      </span>
      {clue.refTitle && <span className="clue-ref">{clue.refTitle}</span>}
      {shown.length > 0 && (
        <ul className="clue-msgs">
          {shown.map((m) => (
            <MessageLine key={m.id} m={m} c={c} />
          ))}
        </ul>
      )}
      {clue.messages.length > shown.length && <span className="clue-more">+{clue.messages.length - shown.length} earlier</span>}
    </li>
  );
}

function CardBody({ eventId, personId }: { eventId: string; personId: string }) {
  const q = useAttendeeClues(eventId, personId, true);
  if (q.isPending) return <p className="clue-note">Loading the clues…</p>;
  if (q.isError) return <p className="clue-note">The clues couldn’t be loaded.</p>;
  const c = q.data;
  const review = c.clues.find((x) => x.type === 'llm');
  const clues = c.clues.filter((x) => x.type !== 'llm').sort((a, b) => b.weight - a.weight);
  return (
    <>
      <p className="clue-title">Why {c.displayName} is listed</p>
      {clues.length ? (
        <ul className="clue-list">
          {clues.map((clue, i) => (
            <ClueItem key={`${clue.type}${i}`} clue={clue} c={c} />
          ))}
        </ul>
      ) : (
        <p className="clue-note">No clues are stored for this row.</p>
      )}
      {review && (
        <p className="clue-review">
          {clueLabel('llm')}: {review.weight > 0 ? `${percent(review.weight)} sure` : 'not there'}
        </p>
      )}
    </>
  );
}

/**
 * An attendee row with its clues: the card opens while the pointer rests on the row (or the row has focus), and
 * the "Clues" button pins it open (touch screens, keyboards). The row itself still links to the person. Every row
 * of a list goes through here (with or without clues) so the dividers stay even.
 */
export function WithClues({ eventId, personId, enabled, children }: { eventId: string; personId: string | null; enabled: boolean; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();
  if (!enabled || !personId) return <div className="attendee">{children}</div>;
  const open = hover || pinned;
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div
      className={open ? 'attendee clues-open' : 'attendee'}
      onMouseEnter={() => {
        clear();
        timer.current = setTimeout(() => setHover(true), OPEN_DELAY_MS);
      }}
      onMouseLeave={() => {
        clear();
        setHover(false);
      }}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setHover(false);
          setPinned(false);
        }
      }}
    >
      <div className="attendee-line">
        {children}
        <button type="button" className="clue-toggle" aria-expanded={open} aria-controls={cardId} onClick={() => setPinned((p) => !p)}>
          Clues
        </button>
      </div>
      {open && (
        <div className="clue-card" id={cardId} role="region" aria-label="Clues">
          <CardBody eventId={eventId} personId={personId} />
        </div>
      )}
    </div>
  );
}
