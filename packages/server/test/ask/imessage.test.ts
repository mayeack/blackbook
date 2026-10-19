import { describe, expect, it } from 'vitest';
import type { AskCitation, AskPeopleList } from '@yb/shared';
import { answerForImessage, askForImessage, formatImessageAnswer, IMESSAGE_ANSWER_CHARS, NEEDS_KEY_MESSAGE } from '../../src/ask';
import { shortDate } from '../../src/ask/citations';
import { allowlistLinks } from '../../src/ask/imessage';
import { factRef } from '../../src/ask/refs';
import { BOT_MARKER, checkOutboundText, MAX_ANSWER_CHARS } from '../../src/delivery/types';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { T0 } from '../helpers';
import { buildAskWorld, DAY, NOW } from './world';

const CONV = '019a0000-0000-7000-8000-0000000000c1';
const cit = (ref: string, kind: AskCitation['kind'], label: string): AskCitation => ({ ref, kind, label, href: null, at: null });

const row = (id: string, displayName: string): AskPeopleList['rows'][number] => ({
  person: { id, displayName, firstName: null, state: null },
  detail: '',
  city: null,
  circles: [],
  lastContactAt: null,
});

describe('formatImessageAnswer', () => {
  it('a list of people: one line each with the details on it, no footnotes, whole lines cut with "+N more"', () => {
    const list: AskPeopleList = { intro: '2 people in Austin:', rows: [row('p1', 'Sam R.'), row('p2', 'Jess K.')], note: '' };
    const text = formatImessageAnswer({
      conversationId: CONV,
      answer: '2 people in Austin:\n- Sam R. — lives in Austin [F1] · Climbing crew circle · last contact Oct 14\n- Jess K. [P2] — East Austin [F3]; talked about Acme [m:2]',
      citations: [cit('F1', 'fact', 'Sam — lives in Austin'), cit('P2', 'person', 'Jess Kim'), cit('F3', 'fact', 'Jess — lives in East Austin'), cit('m:2', 'message', 'Jess · iMessage Oct 3')],
      list,
    });
    expect(text).toBe(
      [
        '2 people in Austin:',
        '• Sam R. — lives in Austin · Climbing crew circle · last contact Oct 14',
        '• Jess K. — East Austin; talked about Acme',
        `Full answer: https://yeackbot.com/ask/${CONV}`,
      ].join('\n'),
    );

    const many = Array.from({ length: 12 }, (_, i) => `- Person ${i + 1} — lives in Springfield · Board games circle · last contact Oct ${i + 1}`);
    const long = formatImessageAnswer({ conversationId: CONV, answer: ['12 people:', ...many].join('\n'), citations: [], list: { ...list, rows: many.map((_, i) => row(`p${i}`, `Person ${i + 1}`)) } });
    const lines = long.split('\n');
    expect(long.length).toBeLessThanOrEqual(IMESSAGE_ANSWER_CHARS);
    expect(lines.filter((l) => l.startsWith('• ')).every((l) => l.endsWith(`Oct ${l.match(/Person (\d+)/)![1]}`))).toBe(true); // whole lines only
    const kept = lines.filter((l) => l.startsWith('• ')).length;
    expect(lines).toContain(`+${12 - kept} more`);
    expect(lines.at(-1)).toBe(`Full answer: https://yeackbot.com/ask/${CONV}`);
    expect(checkOutboundText(`${BOT_MARKER} ${long}`)).toEqual([]);
  });

  it('footnotes citations (≤ 3, no person footnotes), strips markdown, ends with the full-answer link', () => {
    const text = formatImessageAnswer({
      conversationId: CONV,
      answer: '**Sam Rivera** lives in Austin [F1] and climbs [m:2]. Jess Kim [P2] too [F3][F4].',
      citations: [cit('F1', 'fact', 'Sam — lives in Austin'), cit('m:2', 'message', 'Sam · iMessage Oct 3'), cit('P2', 'person', 'Jess Kim'), cit('F3', 'fact', 'Jess — lives in Austin'), cit('F4', 'fact', 'Jess — into climbing')],
    });
    expect(text).toBe(
      ['Sam Rivera lives in Austin¹ and climbs². Jess Kim too³.', '¹ Sam — lives in Austin', '² Sam · iMessage Oct 3', '³ Jess — lives in Austin', `Full answer: https://yeackbot.com/ask/${CONV}`].join('\n'),
    );
    expect(checkOutboundText(`${BOT_MARKER} ${text}`)).toEqual([]);
  });

  it('drops sensitive sentences, masks identifiers, allows only yeackbot.com links, fits 600 with the marker', () => {
    const long = 'Sam is great. '.repeat(80);
    const text = formatImessageAnswer({
      conversationId: CONV,
      answer: `Sam has been in therapy lately [F1]. Call 555-555-0123 or mail sam@example.com, see https://evil.example.net/x and acme.io. ${long}`,
      citations: [cit('F1', 'fact', 'Sam — starting therapy')],
    });
    expect(text).not.toMatch(/therapy|555-555-0123|sam@example\.com|evil\.example|https:\/\/evil|acme\.io/);
    expect(text.startsWith('Call ••• 23 or mail s•••@example, see evil and acme.')).toBe(true);
    expect(text).toContain('Call •••');
    expect(text.length).toBeLessThanOrEqual(IMESSAGE_ANSWER_CHARS);
    expect(`${BOT_MARKER} ${text}`.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    expect(text.endsWith(`https://yeackbot.com/ask/${CONV}`)).toBe(true);
    expect(checkOutboundText(`${BOT_MARKER} ${text}`)).toEqual([]);
    expect(allowlistLinks('go to https://yeackbot.com/ask/x or www.example.org')).toBe('go to https://yeackbot.com/ask/x or www');
  });
});

function services(llm: FakeLlmClient, egress = new FakeEgress()): AgentServices {
  return { llm, egress, outbound: new FakeOutboundSender(), push: new FakePushSender() };
}

describe('answerForImessage', () => {
  it('without the key: the needs-key message plus a short plain search, short names, sendable', async () => {
    const w = buildAskWorld();
    const text = await answerForImessage('Who do I know in Austin?', { db: w.db, services: () => services(new FakeLlmClient({ configured: false })), now: NOW });
    expect(text.startsWith(NEEDS_KEY_MESSAGE)).toBe(true);
    expect(text).toContain('Sam R.');
    expect(text).not.toContain('Rivera');
    expect(text).toMatch(/Full answer: https:\/\/yeackbot\.com\/ask\/[0-9a-f-]{36}$/);
    expect(text.length).toBeLessThanOrEqual(IMESSAGE_ANSWER_CHARS);
    expect(checkOutboundText(`${BOT_MARKER} ${text}`)).toEqual([]);
  });

  it('with the model: effort low, iMessage format in the user turn, footnoted answer, nothing sent', async () => {
    const w = buildAskWorld();
    const egress = new FakeEgress();
    const sam = egress.tokenFor(w.sam);
    const f = factRef(w.facts.samAustin);
    const llm = new FakeLlmClient().on('ask', {
      toolCalls: [{ name: 'search_people', input: { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: 5 } }],
      then: { text: `${sam} lives in Austin [${f}] [${sam}].` },
    });
    const outbound = new FakeOutboundSender();
    const out = await askForImessage('Who do I know in Austin?', { db: w.db, services: () => ({ ...services(llm, egress), outbound }), now: NOW });
    expect(llm.calls[0]).toMatchObject({ effort: 'low', kind: 'ask' });
    expect(llm.calls[0]!.userText).toContain('Channel: iMessage');
    expect(out.text.split('\n')[0]).toBe('Sam R. lives in Austin¹.');
    expect(out.text).toContain('¹ Sam — lives in Austin');
    expect(out.degraded).toBe(false);
    expect(outbound.sent).toEqual([]);
  });

  it('"who do I know in …" with the model: one line per person, details on the line, no footnote list', async () => {
    const w = buildAskWorld();
    const egress = new FakeEgress();
    const sam = egress.tokenFor(w.sam);
    const jess = egress.tokenFor(w.jess);
    const f = factRef(w.facts.samAustin);
    const fj = factRef(w.facts.jessAustin);
    const llm = new FakeLlmClient().on('ask', {
      toolCalls: [{ name: 'search_people', input: { city: 'Austin', limit: null } }],
      then: { text: `- ${sam} — lives in Austin [${f}]\n- ${jess} — East Austin [${fj}]` },
    });
    const out = await askForImessage('who do I know in Austin', { db: w.db, services: () => services(llm, egress), now: NOW });
    const tz = 'America/Los_Angeles';
    expect(out.text.split('\n').slice(0, 2)).toEqual([
      `• Sam R. — lives in Austin · Climbing crew circle · last contact ${shortDate(T0, NOW, tz)}`,
      `• Jess K. — East Austin · Climbing crew circle · last contact ${shortDate(T0 + DAY, NOW, tz)}`,
    ]);
    expect(out.text).not.toMatch(/[¹²³]/);
    expect(out.text).not.toContain('Rivera');
    expect(out.engine.list?.rows.map((r) => r.person.id)).toEqual([w.sam, w.jess]);
    expect(checkOutboundText(`${BOT_MARKER} ${out.text}`)).toEqual([]);
  });
});
