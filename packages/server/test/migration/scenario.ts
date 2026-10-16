/**
 * The shared synthetic legacy store (invented people, 555-01xx numbers, example.com/.org emails):
 *   1  Alex Rivera        live; tags Friends+Work(via 3), group Climbing, location Springfield
 *   2  Alex Rivera        merged-away → 1 (pointer); duplicate phone/tag/group (de-duplicated)
 *   3  Alexander Rivera   merged-away → 2 → chain resolves to 1 (depth 2); own unused email
 *   4  Jordan Lee         live; shares a landline with 5 (incompatible names → shared=1, no merge)
 *   5  Casey Morgan       live
 *   6  Sam Taylor         live; same email as 7 (compatible names → auto-merge)
 *   7  Samuel Taylor      live
 *   8  Pat Kim            merged-away, NO pointer; same phone + name as 9 → recovered target
 *   9  Pat Kim            live
 *   10 Robin Park         merged-away, NO pointer, no keys; same name as 11 → name-only (audited)
 *   11 Robin Park         live; instagram / x / linkedin
 *   12 Drew Quinn         merged-away, NO pointer, no match → stays active + hidden (orphan)
 *   13 Taylor Brooks      live, hidden, priority; no-year birthday; unparseable phone; invalid email
 *   14 (unnamed)          live; company only
 */
import { cd, type Fixture } from './fixture';

export const TZ = 'America/Los_Angeles';
export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
export const T = Date.UTC(2026, 0, 10, 12, 0, 0);

/** Swift: Calendar(gregorian, LA).date(from: DateComponents(month: 3, day: 15)) — year 1, Julian. */
export const SWIFT_NO_YEAR_MAR_15 = -63107741222;
/** 1990-03-15 00:00 in Los Angeles (PST). */
export const BIRTHDAY_1990_03_15 = cd(Date.UTC(1990, 2, 15, 8));

export function scenario(overrides: Partial<Fixture> = {}): Fixture {
  return {
    contacts: [
      {
        pk: 1,
        first: 'Alex',
        last: 'Rivera',
        phones: ['(212) 555-0101'],
        emails: ['Alex.Rivera@Example.com'],
        addresses: ['12 Example St, Springfield, IL 62701'],
        interests: ['climbing', 'jazz'],
        birthday: BIRTHDAY_1990_03_15,
        custom: { nickname: 'Al', lastEnriched: '2025-01-01' },
        company: 'Example Co',
      },
      { pk: 2, first: 'Alex', last: 'Rivera', phones: ['212-555-0101'], interests: ['Jazz'], mergedAway: true, mergedInto: 1, jobTitle: 'Engineer' },
      { pk: 3, first: 'Alexander', last: 'Rivera', emails: ['alex.r@example.org'], mergedAway: true, mergedInto: 2, encoding: 'plain' },
      { pk: 4, first: 'Jordan', last: 'Lee', phones: ['(415) 555-0123'] },
      { pk: 5, first: 'Casey', last: 'Morgan', phones: ['415.555.0123'] },
      { pk: 6, first: 'Sam', last: 'Taylor', emails: ['sam.t@example.com'], metVia: 1 },
      { pk: 7, first: 'Samuel', last: 'Taylor', emails: ['SAM.T@example.com'], phones: ['(646) 555-0177'] },
      { pk: 8, first: 'Pat', last: 'Kim', phones: ['(646) 555-0142'], mergedAway: true },
      { pk: 9, first: 'Pat', last: 'Kim', phones: ['+1 646 555 0142'] },
      { pk: 10, first: 'Robin', last: 'Park', mergedAway: true },
      { pk: 11, first: 'Robin', last: 'Park', instagram: '@Robin.Park', twitter: 'https://x.com/RobinP', linkedin: 'linkedin.com/in/Robin-Park-0101/' },
      { pk: 12, first: 'Drew', last: 'Quinn', phones: ['555-0100'], mergedAway: true },
      {
        pk: 13,
        first: 'Taylor',
        last: 'Brooks',
        phones: ['5550199'],
        emails: ['not-an-email'],
        hidden: true,
        priority: true,
        birthday: SWIFT_NO_YEAR_MAR_15,
      },
      { pk: 14, company: 'Example Co' },
    ],
    tags: [
      { pk: 1, name: 'Friends' },
      { pk: 2, name: 'Work' },
      { pk: 3, name: 'friends' },
    ],
    groups: [
      { pk: 1, name: 'Climbing', icon: 'figure.climbing' },
      { pk: 2, name: 'Book Club' },
    ],
    locations: [{ pk: 1, name: 'Springfield', icon: 'mappin' }],
    // (contact, tag): 2 duplicates 1 after canonicalization; 3 re-points to 1; tag 3 collapses onto tag 1; 99 is unknown
    tagLinks: [
      [1, 1],
      [2, 1],
      [3, 2],
      [6, 3],
      [99, 1],
    ],
    groupLinks: [
      [1, 1],
      [2, 1],
      [4, 2],
      [5, 2],
    ],
    locationLinks: [
      [1, 1],
      [3, 1],
    ],
    notes: [
      { pk: 1, contact: 2, content: 'Met at the climbing gym', category: 'Personal' },
      { pk: 2, content: 'Orphan note without a contact' },
    ],
    activities: [{ pk: 1, name: 'Synthetic Picnic', date: cd(Date.UTC(2025, 5, 1, 18)), googleEventId: 'evt-synthetic-1' }],
    activityContacts: [
      [1, 1],
      [1, 3],
      [1, 4],
    ],
    activityGroups: [[1, 1]],
    reminders: [
      { pk: 1, contact: 6, title: 'Send the book list', due: cd(Date.UTC(2026, 10, 1)) },
      { pk: 2, title: 'Reminder without a contact' },
    ],
    relationships: [{ pk: 1, from: 4, to: 5, label: 'Roommate', strength: 0.8 }],
    notifications: [
      { pk: 1, contact: 6, dismissed: true },
      { pk: 2, contact: 9, dismissed: false },
    ],
    ...overrides,
  };
}
