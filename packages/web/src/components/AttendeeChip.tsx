import type { AttendeeView } from '../api/types';
import { attendeeLine } from '../lib/events';
import { Avatar } from './Avatar';
import { PersonLink } from './PersonLink';

/**
 * An attendee on an event card. Known people are PersonLink chips with their avatar; "possible" attendees
 * (confidence 0.5–0.75) get a dashed, dimmed chip and a "?" so they never read as confirmed. Guests yeackbot
 * can't place are plain text chips (no avatar, nothing to link to).
 */
export function AttendeeChip({ a }: { a: AttendeeView }) {
  const cls = `chip attendee tier-${a.tier}`;
  const line = attendeeLine(a);
  const mark = a.tier === 'possible' && (
    <span className="tier-mark" aria-hidden>
      ?
    </span>
  );
  if (a.personId)
    return (
      <PersonLink id={a.personId} className={cls} title={line}>
        <Avatar id={a.personId} name={a.name} size={22} />
        <span>{a.name}</span>
        {mark}
        <span className="sr-only"> ({line})</span>
      </PersonLink>
    );
  return (
    <span className={`${cls} plain`} title={line}>
      <span>{a.name}</span>
      {mark}
      <span className="sr-only"> ({line})</span>
    </span>
  );
}
