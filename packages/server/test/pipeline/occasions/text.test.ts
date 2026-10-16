import { describe, expect, it } from 'vitest';
import { classifyOccasion, type ClassifyInput } from '../../../src/pipeline/occasions/classify';
import { isLogistics, messageDates, tzOffsetMinutes } from '../../../src/pipeline/occasions/messages';
import { combine, mergeSignals } from '../../../src/pipeline/occasions/signals';
import {
  distinctiveTokens,
  parseMentions,
  partifulIdFromUid,
  partifulIdsIn,
  plainText,
  reservationVenue,
  ticketCount,
  venueFromTitle,
  venueKey,
} from '../../../src/pipeline/occasions/text';
import { partifulUid } from './world';

const people = (title: string | null, notes: string | null = null) => parseMentions(title, notes).map((m) => `${m.surface}/${m.role}`);

describe('names in titles and notes', () => {
  it('"w/" lists, with venues and times cut off', () => {
    expect(people('Drinks w/ Quill')).toEqual(['Quill/companion']);
    expect(people('Dinner w/ Quill, Romy & Tavi at Lupine Room')).toEqual(['Quill/companion', 'Romy/companion', 'Tavi/companion']);
    expect(people('drinks w/ quill tonight')).toEqual(['quill/companion']);
    expect(people('Coffee with Sol (catch up)')).toEqual(['Sol/companion']);
    expect(people('Lunch w/Romy 12:30')).toEqual(['Romy/companion']);
  });

  it('"A & B" pairs, ticket holders and name lists in notes; event words are not names', () => {
    expect(people('Quill & Romy Dinner')).toEqual(['Quill/companion', 'Romy/companion']);
    expect(people('Fernhollow concert', 'Tavi has my ticket\n4 tickets')).toEqual(['Tavi/ticket_holder']);
    expect(people('Show', 'Quill & Romy<br>Ticket for Ines').sort()).toEqual(['Ines/ticket_holder', 'Quill/companion', 'Romy/companion']);
    expect(people('Brunch', 'Romy, Tavi, Quill')).toEqual(['Romy/companion', 'Tavi/companion', 'Quill/companion']);
  });

  it('drops generic companions but keeps possible group nicknames', () => {
    expect(people('Dinner w/ friends')).toEqual([]);
    expect(people('Drinks w/ my friends & family')).toEqual([]);
    // "the …" survives only as a possible group-chat / circle name (it never becomes a person)
    expect(people('Drinks w/ the team')).toEqual(['the team/companion']);
    expect(people('Dinner w/ the Climbing Crew')).toEqual(['the Climbing Crew/companion']);
  });
});

describe('venues, tickets, Partiful ids, tokens', () => {
  it('venue keys and reservation titles', () => {
    expect(venueKey('The Lupine Room, 12 Example St, Springfield')).toBe('lupine room');
    expect(venueKey('Moss & Fern')).toBe('moss and fern');
    expect(reservationVenue('Reservation at Lupine Room for 4')).toBe('Lupine Room');
    expect(reservationVenue('Dinner w/ Quill')).toBeNull();
    expect(venueFromTitle('Dinner w/ Quill at Lupine Room')).toBe('Lupine Room');
    expect(venueFromTitle('Drinks @ Moss & Fern')).toBe('Moss & Fern');
  });

  it('ticket counts', () => {
    expect(ticketCount('4 tickets')).toBe(4);
    expect(ticketCount('tix x3')).toBe(3);
    expect(ticketCount('two tickets')).toBe(2);
    expect(ticketCount('Your ticket order\nQuantity: 2')).toBe(2);
    expect(ticketCount('Quantity: 2')).toBeNull();
    expect(ticketCount('see you at 4')).toBeNull();
  });

  it('Partiful links and feed UIDs', () => {
    expect(partifulIdsIn('RSVP https://partiful.com/e/AbCdEf123456?c=1', null)).toEqual(['AbCdEf123456']);
    expect(partifulIdFromUid(partifulUid('AbCdEf123456'))).toBe('AbCdEf123456');
    expect(partifulIdFromUid('event-1@example.com')).toBeNull();
  });

  it('Google HTML descriptions become plain text', () => {
    expect(plainText('Tavi &amp; Romy<br>bring <b>snacks</b>')).toBe('Tavi & Romy\nbring snacks');
  });

  it('distinctive tokens skip stopwords, event words and the people in it', () => {
    expect(distinctiveTokens(['Fernhollow concert w/ Tavi', 'Copperline Hall'], ['Tavi'])).toEqual(['copperline', 'fernhollow', 'hall']);
  });
});

describe('date phrases (chrono-node) resolve to local days', () => {
  it('relative to when the message was sent, in the configured zone', () => {
    const sent = Date.UTC(2026, 9, 16, 2, 0); // Oct 15, 19:00 at UTC−7
    expect(tzOffsetMinutes(sent, 'America/Los_Angeles')).toBe(-420);
    expect([...messageDates('drinks tmrw?', sent, 'America/Los_Angeles')]).toEqual(['2026-10-16']);
    expect([...messageDates('see you saturday!', sent, 'America/Los_Angeles')]).toEqual(['2026-10-17']);
    expect([...messageDates('drinks tmrw?', sent, 'UTC')]).toEqual(['2026-10-17']);
    expect([...messageDates('sounds good', sent, 'UTC')]).toEqual([]);
  });
});

describe('logistics texts', () => {
  it('arrival and where-are-you texts, not every "here"', () => {
    for (const t of ['here!', 'ok here', 'omw', 'on my way, 5 min away', 'where are you?', 'wya', 'running late sorry', 'grabbed a table in the back']) {
      expect(isLogistics(t), t).toBe(true);
    }
    for (const t of ['here is the link', 'the photos are here', 'see you next week maybe']) expect(isLogistics(t), t).toBe(false);
  });
});

describe('rule classification', () => {
  const base: ClassifyInput = {
    titles: [],
    notes: [],
    location: null,
    allDay: false,
    startsAt: 0,
    endsAt: 2 * 3_600_000,
    hasPartiful: false,
    hasReservation: false,
    mentions: [],
    explicitAttendees: 0,
  };
  const kind = (title: string, extra: Partial<ClassifyInput> = {}) => {
    const c = classifyOccasion({ ...base, titles: [title], mentions: parseMentions(title, null), ...extra });
    return `${c.kind}${c.sensitive ? '!' : ''}`;
  };

  it('social: meals, drinks, shows, parties, people in the title, Partiful, reservations', () => {
    expect(kind('Drinks w/ Quill')).toBe('social');
    expect(kind('Fernhollow concert')).toBe('social');
    expect(kind('Quill', { mentions: parseMentions('w/ Quill', null) })).toBe('social');
    expect(kind('Housewarming', { hasPartiful: true })).toBe('social');
    expect(kind('Reservation at Lupine Room', { hasReservation: true })).toBe('social');
  });

  it('logistics, appointments (medical is sensitive), work, lodging and travel are not social', () => {
    expect(kind('Maid service')).toBe('logistics');
    expect(kind('HOA meeting')).toBe('logistics');
    expect(kind('Plumber - kitchen sink repair')).toBe('logistics');
    expect(kind('Dentist cleaning')).toBe('appointment!');
    expect(kind('Annual physical')).toBe('appointment!');
    expect(kind('Haircut')).toBe('appointment');
    expect(kind('Weekly team sync')).toBe('work');
    expect(kind('Flight to Springfield')).toBe('travel');
    expect(kind('Stay at Example Inn')).toBe('lodging');
    expect(kind('Lakeside', { allDay: true, endsAt: 3 * 86_400_000 })).toBe('travel');
    expect(kind("Romy's birthday", { allDay: true, endsAt: 86_400_000 })).toBe('unknown');
  });
});

describe('scoring', () => {
  it('noisy-OR over the strongest signal per type', () => {
    expect(combine([{ type: 'title_name', weight: 0.85 * 0.92 }])).toBe(0.78);
    expect(combine([{ type: 'logistics_dm', weight: 0.5 }])).toBe(0.5);
    expect(combine([{ type: 'logistics_dm', weight: 0.5 }, { type: 'logistics_dm', weight: 0.3 }, { type: 'mention_dm', weight: 0.45 }])).toBe(0.73);
    expect(mergeSignals([{ type: 'mention_dm', weight: 0.45, m: [3] }, { type: 'mention_dm', weight: 0.45, m: [1, 3] }])).toEqual([{ type: 'mention_dm', weight: 0.45, m: [1, 3] }]);
  });
});
