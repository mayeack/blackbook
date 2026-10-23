/**
 * Synthetic OCR output for contact screenshots (the collector's OcrLine shape: normalized 0–1 boxes, origin
 * top-left). Every name, handle and address is invented; phones are NANP 555-01xx; emails are on example.com or
 * *.example. Shaped like the real screens: an Instagram profile, an iOS contact card, a business card, a chat, an
 * X-style profile and a plain photo.
 */
import type { OcrLine } from '@yb/shared/collector/v1';

export const line = (text: string, y: number, o: { x?: number; w?: number; h?: number; conf?: number } = {}): OcrLine => ({
  text,
  confidence: o.conf ?? 0.95,
  x: o.x ?? 0.1,
  y,
  w: o.w ?? 0.5,
  h: o.h ?? 0.02,
});

export const IG_HANDLE = 'rileyquinn_demo';
export const IG_NAME = 'Riley Quinn';

/** Another account an Instagram bio or a tweet mentions (not the profile's owner). */
export const MENTIONED_HANDLE = 'avery_mentioned_demo';

/** Instagram profile: nav-bar username, stats block, display name, bio, buttons. `bioMention` adds a bio line that
 * mentions another account (@handle and an instagram.com link). */
export const igProfile = (followers = '1,234', o: { bioMention?: boolean } = {}): OcrLine[] => [
  line('9:41', 0.01, { x: 0.08, w: 0.1, h: 0.015 }),
  line(`${IG_HANDLE} ⌄`, 0.06, { x: 0.05, w: 0.4, h: 0.025 }),
  line('128', 0.15, { x: 0.36, w: 0.06 }),
  line(followers, 0.15, { x: 0.55, w: 0.08 }),
  line('389', 0.15, { x: 0.76, w: 0.06 }),
  line('posts', 0.18, { x: 0.34, w: 0.1, h: 0.015 }),
  line('followers', 0.18, { x: 0.52, w: 0.14, h: 0.015 }),
  line('following', 0.18, { x: 0.73, w: 0.13, h: 0.015 }),
  line(IG_NAME, 0.24, { x: 0.05, w: 0.25, h: 0.02 }),
  line('Coffee, climbing and synth pop', 0.27, { x: 0.05, w: 0.5, h: 0.018 }),
  ...(o.bioMention
    ? [
        line(`Designer at @${MENTIONED_HANDLE}`, 0.29, { x: 0.05, w: 0.5, h: 0.018 }),
        line(`instagram.com/${MENTIONED_HANDLE}`, 0.31, { x: 0.05, w: 0.5, h: 0.018 }),
      ]
    : []),
  line('Follow', 0.33, { x: 0.1, w: 0.2 }),
  line('Message', 0.33, { x: 0.5, w: 0.2 }),
];

export const CARD_NAME = 'Jordan Ellis';
export const CARD_PHONE_TEXT = '(212) 555-0142';
export const CARD_PHONE = '+12125550142';
export const CARD_EMAIL = 'jordan.ellis@example.com';

/** iOS Contacts card: big centered name, the action row, labelled fields. */
export const contactCard = (o: { phone?: string; email?: string; name?: string } = {}): OcrLine[] => [
  line('9:41', 0.01, { x: 0.08, w: 0.1, h: 0.015 }),
  line('Contacts', 0.05, { x: 0.05, w: 0.2 }),
  line('Edit', 0.05, { x: 0.85, w: 0.1 }),
  line(o.name ?? CARD_NAME, 0.22, { x: 0.3, w: 0.4, h: 0.04 }),
  line('message', 0.3, { x: 0.08, w: 0.15, h: 0.013 }),
  line('call', 0.3, { x: 0.3, w: 0.1, h: 0.013 }),
  line('video', 0.3, { x: 0.5, w: 0.1, h: 0.013 }),
  line('mail', 0.3, { x: 0.7, w: 0.1, h: 0.013 }),
  line('mobile', 0.4, { w: 0.15, h: 0.014 }),
  line(o.phone ?? CARD_PHONE_TEXT, 0.42, { w: 0.4 }),
  line('home', 0.5, { w: 0.15, h: 0.014 }),
  line(o.email ?? CARD_EMAIL, 0.52, { w: 0.6 }),
  line('Notes', 0.6, { w: 0.15 }),
  line('Share Contact', 0.7, { w: 0.3 }),
];

export const BIZ_NAME = 'Morgan Avery';
export const BIZ_PHONE = '+12125550150';
export const BIZ_EMAIL = 'morgan@averystudio.example';

/** A business card photographed and screenshotted: name, title, company, phone, email, site. */
export const businessCard = (o: { secondPhone?: boolean } = {}): OcrLine[] => [
  line(BIZ_NAME, 0.2, { x: 0.15, w: 0.5, h: 0.05 }),
  line('Principal Designer', 0.28, { x: 0.15, w: 0.4, h: 0.025 }),
  line('Avery Studio', 0.33, { x: 0.15, w: 0.3, h: 0.025 }),
  line('T +1 212 555 0150', 0.6, { x: 0.15, w: 0.4 }),
  ...(o.secondPhone ? [line('M +1 212 555 0151', 0.63, { x: 0.15, w: 0.4 })] : []),
  line(BIZ_EMAIL, 0.67, { x: 0.15, w: 0.5 }),
  line('averystudio.example', 0.71, { x: 0.15, w: 0.4 }),
];

export const CHAT_PHONE = '+12125550177';

/** An iMessage thread where the other side typed a number. */
export const chatWithNumber = (): OcrLine[] => [
  line('9:41', 0.01, { x: 0.08, w: 0.1, h: 0.015 }),
  line('Sam', 0.08, { x: 0.45, w: 0.1, h: 0.015 }),
  line('iMessage', 0.12, { x: 0.4, w: 0.2, h: 0.012 }),
  line('Today 9:12 PM', 0.15, { x: 0.35, w: 0.3, h: 0.012 }),
  line('great meeting you tonight!', 0.2, { x: 0.05, w: 0.6 }),
  line('my cell is 212-555-0177', 0.25, { x: 0.05, w: 0.55 }),
  line('Delivered', 0.3, { x: 0.75, w: 0.2, h: 0.012 }),
];

export const SOCIAL_HANDLE = 'caseylin_demo';
export const SOCIAL_NAME = 'Casey Lin';

/** An X-style profile: '@handle' under the name, following / followers, no posts grid. `bioMention` adds a bio
 * that mentions another account. */
export const socialProfile = (o: { bioMention?: boolean } = {}): OcrLine[] => [
  line('9:41', 0.01, { x: 0.08, w: 0.1, h: 0.015 }),
  line(SOCIAL_NAME, 0.2, { x: 0.05, w: 0.3, h: 0.03 }),
  line(`@${SOCIAL_HANDLE}`, 0.24, { x: 0.05, w: 0.3, h: 0.018 }),
  ...(o.bioMention ? [line(`Product at @${MENTIONED_HANDLE} · opinions mine`, 0.27, { x: 0.05, w: 0.6, h: 0.016 })] : []),
  line('Joined March 2020', 0.3, { x: 0.05, w: 0.3, h: 0.015 }),
  line('210 Following', 0.33, { x: 0.05, w: 0.2, h: 0.015 }),
  line('1,024 Followers', 0.33, { x: 0.35, w: 0.25, h: 0.015 }),
];

/** A photo of a pier at sunset: some text, nothing to contact. */
export const plainPhoto = (): OcrLine[] => [line('PIER 7', 0.4, { h: 0.05 }), line('Sunset Pier Walk', 0.7, { h: 0.03 }), line('No fishing', 0.8)];
