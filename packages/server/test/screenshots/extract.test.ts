import { describe, expect, it } from 'vitest';
import { extractContact, hasIdentifiers, parseCount, regionForTimeZone, type ExtractedContact } from '../../src/screenshots/extract';
import {
  BIZ_EMAIL,
  BIZ_NAME,
  BIZ_PHONE,
  businessCard,
  CARD_EMAIL,
  CARD_NAME,
  CARD_PHONE,
  CHAT_PHONE,
  chatWithNumber,
  contactCard,
  IG_HANDLE,
  IG_NAME,
  igProfile,
  line,
  MENTIONED_HANDLE,
  plainPhoto,
  SOCIAL_HANDLE,
  SOCIAL_NAME,
  socialProfile,
} from './fixtures';

const cases: { name: string; lines: ReturnType<typeof igProfile>; want: Partial<ExtractedContact> }[] = [
  {
    name: 'Instagram profile',
    lines: igProfile(),
    want: { kind: 'instagram_profile', handles: [IG_HANDLE], phones: [], emails: [], name: IG_NAME, followers: 1234 },
  },
  {
    name: 'Instagram profile with an abbreviated follower count',
    lines: igProfile('12.5K'),
    want: { kind: 'instagram_profile', handles: [IG_HANDLE], followers: 12_500 },
  },
  {
    name: 'iOS contact card',
    lines: contactCard(),
    want: { kind: 'contact_card', phones: [CARD_PHONE], emails: [CARD_EMAIL], handles: [], name: CARD_NAME, followers: null },
  },
  {
    name: 'business-card-like screen',
    lines: businessCard(),
    want: { kind: 'contact_card', phones: [BIZ_PHONE], emails: [BIZ_EMAIL], handles: [], name: BIZ_NAME },
  },
  {
    name: 'business card with office and mobile numbers',
    lines: businessCard({ secondPhone: true }),
    want: { kind: 'contact_card', phones: [BIZ_PHONE, '+12125550151'] },
  },
  {
    name: 'chat screenshot with a number',
    lines: chatWithNumber(),
    want: { kind: 'message', phones: [CHAT_PHONE], emails: [], handles: [], name: null },
  },
  {
    name: 'X-style profile',
    lines: socialProfile(),
    want: { kind: 'social_profile', handles: [SOCIAL_HANDLE], name: SOCIAL_NAME, followers: 1024 },
  },
  {
    name: 'plain photo with no contact',
    lines: plainPhoto(),
    want: { kind: 'other', phones: [], emails: [], handles: [], name: null, followers: null },
  },
];

describe('extractContact', () => {
  for (const c of cases) {
    it(c.name, () => {
      const ex = extractContact(c.lines, { region: 'US' });
      expect(ex).toMatchObject(c.want);
    });
  }

  it('a plain photo has no identifiers; the others do', () => {
    expect(hasIdentifiers(extractContact(plainPhoto()))).toBe(false);
    for (const l of [igProfile(), contactCard(), businessCard(), chatWithNumber(), socialProfile()]) expect(hasIdentifiers(extractContact(l))).toBe(true);
  });

  it('no lines → other, nothing found', () => {
    expect(extractContact([])).toEqual({ kind: 'other', phones: [], emails: [], handles: [], name: null, followers: null });
  });

  it('an email address is never read as an @handle', () => {
    const ex = extractContact([line('write to dana.park@example.com', 0.5)]);
    expect(ex.emails).toEqual(['dana.park@example.com']);
    expect(ex.handles).toEqual([]);
  });

  it('finds instagram.com links and @handles, skipping reserved paths', () => {
    const ex = extractContact([
      line('ig: instagram.com/blake.rowe_demo', 0.5),
      line('also @blake.rowe_demo.', 0.55),
      line('https://www.instagram.com/p/ABC123', 0.6),
      line('find me @quinn_demo2', 0.65),
    ]);
    expect(ex.handles).toEqual(['blake.rowe_demo', 'quinn_demo2']);
  });

  it('dedupes phones written several ways and drops toll-free and short codes', () => {
    const ex = extractContact([
      line('cell (212) 555-0123', 0.4),
      line('+1 212 555 0123', 0.45),
      line('support 1-800-555-0100', 0.5),
      line('text 24273', 0.55),
    ]);
    expect(ex.phones).toEqual(['+12125550123']);
  });

  it('reads numbers without a country code in the default region', () => {
    const ex = extractContact([line('mobile 020 7946 0123', 0.5)], { region: 'GB' });
    expect(ex.phones).toEqual(['+442079460123']);
  });

  it('a profile without the posts label is not an Instagram profile', () => {
    const ex = extractContact([
      line('kai.demo', 0.06, { h: 0.025 }),
      line('Kai Morrow', 0.2, { h: 0.03 }),
      line('120 followers', 0.25),
      line('80 following', 0.25, { x: 0.5 }),
    ]);
    expect(ex.kind).not.toBe('instagram_profile');
    expect(ex.handles).toEqual([]);
  });

  it('the name is the tallest name-like line in the top 45%, never a UI line', () => {
    const ex = extractContact([
      line('Share Contact', 0.1, { h: 0.06 }),
      line('Avery Lane', 0.2, { h: 0.03 }),
      line('Taylor Brooks', 0.25, { h: 0.04 }),
      line('Much Taller Line Below', 0.6, { h: 0.08 }),
      line('Low Confidence Name', 0.3, { h: 0.07, conf: 0.3 }),
      line('mobile (212) 555-0161', 0.5),
    ]);
    expect(ex.name).toBe('Taylor Brooks');
  });

  it("an Instagram profile's identifier is its nav-bar username, never a bio @mention or link", () => {
    const ex = extractContact(igProfile('1,234', { bioMention: true }));
    expect(ex).toMatchObject({ kind: 'instagram_profile', handles: [IG_HANDLE], name: IG_NAME, followers: 1234 });
    expect(ex.handles).not.toContain(MENTIONED_HANDLE);
  });

  it("an X-style profile's identifier is its own @handle line, never a mention in the bio", () => {
    const ex = extractContact(socialProfile({ bioMention: true }));
    expect(ex).toMatchObject({ kind: 'social_profile', handles: [SOCIAL_HANDLE], name: SOCIAL_NAME });
  });

  it('a social profile with only a mention in running text has no handle of its own', () => {
    const ex = extractContact([
      line('Kai Morrow', 0.2, { h: 0.03 }),
      line(`Building things with @${MENTIONED_HANDLE}`, 0.25),
      line('120 Followers', 0.3),
    ]);
    expect(ex.kind).toBe('social_profile');
    expect(ex.handles).toEqual([]);
    expect(hasIdentifiers(ex)).toBe(false);
  });

  it('a chat keeps @handles typed in it (people share their handle that way)', () => {
    const ex = extractContact([
      line('iMessage', 0.12, { x: 0.4, w: 0.2, h: 0.012 }),
      line(`follow me @${MENTIONED_HANDLE}`, 0.25),
      line('Delivered', 0.3, { x: 0.75, w: 0.2, h: 0.012 }),
    ]);
    expect(ex).toMatchObject({ kind: 'message', handles: [MENTIONED_HANDLE] });
  });

  it('ignores the status-bar clock and low-lying UI lines when naming', () => {
    const ex = extractContact(contactCard({ name: 'Rowan Hale' }));
    expect(ex.name).toBe('Rowan Hale');
  });

  it('the follower count comes only with a profile layout', () => {
    expect(extractContact(contactCard()).followers).toBeNull();
  });
});

describe('extract helpers', () => {
  it('parses counts', () => {
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount('12.5K')).toBe(12_500);
    expect(parseCount('1.2M')).toBe(1_200_000);
    expect(parseCount('987')).toBe(987);
    expect(parseCount('1.234.567')).toBe(1_234_567);
    expect(parseCount('posts')).toBeNull();
  });

  it('maps the owner time zone to a phone region, US by default', () => {
    expect(regionForTimeZone('Europe/London')).toBe('GB');
    expect(regionForTimeZone('America/New_York')).toBe('US');
    expect(regionForTimeZone(null)).toBe('US');
  });
});
