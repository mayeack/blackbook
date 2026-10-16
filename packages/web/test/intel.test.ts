import { describe, expect, it } from 'vitest';
import { attendeeSubtitle, dayRange, daysUntil, lastContactLine, loopLine, orderAttendees, tieWord, tripPersonLine, tripReasonLabel, whenLabel } from '../src/lib/intel';

const today = new Date(2026, 9, 16);
const DAY = 86_400_000;

describe('trips helpers', () => {
  it('formats local date ranges compactly', () => {
    expect(dayRange('2026-10-20', '2026-10-24', today)).toBe('Oct 20 – 24');
    expect(dayRange('2026-10-30', '2026-11-02', today)).toBe('Oct 30 – Nov 2');
    expect(dayRange('2026-10-20', null, today)).toBe('Oct 20');
    expect(dayRange('2026-10-20', '2026-10-20', today)).toBe('Oct 20');
    expect(dayRange('2026-12-30', '2027-01-03', today)).toBe('Dec 30, 2026 – Jan 3, 2027');
  });

  it('says when a trip starts', () => {
    expect(daysUntil('2026-10-21', today)).toBe(5);
    expect(whenLabel('2026-10-21', '2026-10-23', today)).toBe('in 5 days');
    expect(whenLabel('2026-10-17', '2026-10-18', today)).toBe('tomorrow');
    expect(whenLabel('2026-10-16', '2026-10-18', today)).toBe('today');
    expect(whenLabel('2026-10-14', '2026-10-18', today)).toBe('now');
    expect(whenLabel('2026-10-01', '2026-10-03', today)).toBe('');
    expect(tripReasonLabel('location_current')).toBe('Lives there');
    expect(tripReasonLabel('something_new')).toBe('something new');
    expect(tripPersonLine('location_current', 'lives there')).toBe('Lives there');
    expect(tripPersonLine('location_current', 'lives there since Mar')).toBe('Lives there since Mar');
    expect(tripPersonLine('travel_plan', 'Oct 20 – 22')).toBe('Will be there too · Oct 20 – 22');
    expect(tripPersonLine('partiful', null)).toBe('Partiful events there');
  });
});

describe('brief helpers', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  it('last contact and tie words', () => {
    expect(lastContactLine(null, now)).toBe('no messages yet');
    expect(lastContactLine(now - 2 * 3_600_000, now)).toBe('talked today');
    expect(lastContactLine(now - DAY, now)).toBe('talked yesterday');
    expect(lastContactLine(now - 12 * DAY, now)).toBe('talked 12 days ago');
    expect(lastContactLine(now - 120 * DAY, now)).toBe('talked 4 months ago');
    expect(tieWord(80)).toBe('close');
    expect(tieWord(null)).toBeNull();
    expect(attendeeSubtitle({ status: 'going', lastContactAt: now - 12 * DAY, tieStrength: 50 }, now)).toBe('Going · talked 12 days ago · good friend');
  });

  it('loop lines and attendee order (open loops first, then tie strength)', () => {
    expect(loopLine({ type: 'reply_debt', title: 'Asked you something', owner: 'me' })).toBe('↩ Asked you something');
    expect(loopLine({ type: 'commitment', title: 'send the trail map', owner: 'me' })).toBe('✓ You promised: send the trail map');
    expect(loopLine({ type: 'commitment', title: 'book the cabin', owner: 'them' })).toBe('✓ They promised: book the cabin');
    const p = (id: string, displayName: string) => ({ id, displayName, firstName: null, state: null });
    const xs = [
      { person: p('a', 'Avery Quill'), tieStrength: 90, openLoops: [] },
      { person: p('b', 'Bram Ostrow'), tieStrength: 20, openLoops: [{}] },
      { person: p('c', 'Cleo Marsh'), tieStrength: 60, openLoops: [] },
    ] as unknown as Parameters<typeof orderAttendees>[0];
    expect(orderAttendees(xs).map((x) => x.person.id)).toEqual(['b', 'a', 'c']);
  });
});
