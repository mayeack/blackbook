import { describe, expect, it } from 'vitest';
import type { AskCitation } from '@yb/shared';
import { answerForImessage, askForImessage, formatImessageAnswer, IMESSAGE_ANSWER_CHARS, NEEDS_KEY_MESSAGE } from '../../src/ask';
import { allowlistLinks } from '../../src/ask/imessage';
import { factRef } from '../../src/ask/refs';
import { BOT_MARKER, checkOutboundText, MAX_ANSWER_CHARS } from '../../src/delivery/types';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { buildAskWorld, NOW } from './world';

const CONV = '019a0000-0000-7000-8000-0000000000c1';
const cit = (ref: string, kind: AskCitation['kind'], label: string): AskCitation => ({ ref, kind, label, href: null, at: null });

describe('formatImessageAnswer', () => {
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
});
