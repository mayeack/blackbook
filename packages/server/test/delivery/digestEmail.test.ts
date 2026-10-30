/**
 * The morning brief as an email (delivery/digestEmail.ts): the same lines as the text, the same outbound rules,
 * everything HTML-escaped, and yeackbot.com/today as the only link.
 */
import { describe, expect, it } from 'vitest';
import { briefEmail } from '../../src/delivery/digestEmail';

const item = (ordinal: number, o: { line?: string; body?: string | null; details?: string[]; openers?: string[]; copy?: 'llm' | 'template'; sensitive?: boolean } = {}) => ({
  ordinal,
  line: o.line ?? `${ordinal}. Check in with Ava Q.`,
  body: o.body === undefined ? 'It’s been 6 weeks.' : o.body,
  details: o.details ?? [],
  openers: o.openers ?? [],
  copy: o.copy ?? ('template' as const),
  sensitive: o.sensitive ?? false,
});
const links = (s: string) => [...s.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);

describe('briefEmail', () => {
  it('one item: "Just one thing", its lines, the opener draft, the health line, the Today link', () => {
    const m = briefEmail({
      localDate: '2026-10-30',
      items: [item(1, { copy: 'llm', openers: ['Hey! How’s the new place?'], details: ['Sam R.: You talked 2 days ago.'] })],
      health: "Heads up: WhatsApp hasn't synced in 4 days.",
    });
    expect(m.subject).toBe('Your brief for Fri Oct 30: 1 thing');
    expect(m.text).toBe(
      [
        'Good morning! Just one thing today.',
        '',
        '1. Check in with Ava Q.',
        'It’s been 6 weeks.',
        'Sam R.: You talked 2 days ago.',
        'Maybe: “Hey! How’s the new place?”',
        '',
        "Heads up: WhatsApp hasn't synced in 4 days.",
        '',
        "That's it! It's all at https://yeackbot.com/today",
      ].join('\n'),
    );
    expect(links(m.html)).toEqual(['https://yeackbot.com/today']);
  });

  it('lines that break the outbound rules fall back to "in the app"; a bad health line is dropped', () => {
    const m = briefEmail({
      localDate: '2026-10-30',
      items: [item(1, { body: 'Call her at (202) 555-0123.' }), item(2, { body: 'See example.org/tickets' }), item(3)],
      health: 'Heads up: check evil.example.net now.',
    });
    expect(m.text).toContain('\n\n1. One for you in the app.\n\n2. One for you in the app.\n\n3. Check in with Ava Q.\n');
    expect(`${m.text}${m.html}`).not.toMatch(/555|example\.org|evil/);
    expect(links(`${m.text}\n${m.html}`)).toEqual(['https://yeackbot.com/today', 'https://yeackbot.com/today']);
  });

  it('HTML-escapes every line; a sensitive item stays vague', () => {
    const m = briefEmail({
      localDate: '2026-10-30',
      items: [item(1, { line: '1. Dinner <b>& "drinks"</b>', body: null }), item(2, { sensitive: true, line: '2. Something personal' })],
      health: null,
      digestTime: '18:00',
    });
    expect(m.text.startsWith('Evening! 2 things for today.\n\n1. Dinner <b>& "drinks"</b>\n\n2. Something personal\nThe details are in the app.\n\n')).toBe(true);
    expect(m.html).toContain('1. Dinner &lt;b&gt;&amp; &quot;drinks&quot;&lt;/b&gt;');
    expect(m.html).not.toContain('<b>&');
    expect(m.html).not.toContain('6 weeks');
  });
});
