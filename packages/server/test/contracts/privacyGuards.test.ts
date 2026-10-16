/**
 * The last-line privacy guards, with synthetic values only (555-01xx, example.com, 203.0.113.x documentation IPs):
 *   - the egress scrubber + fail-closed scanner catch @handles in any position ("ig:@x", quoted, after a comma);
 *   - outbound text rejects bare 10–11 digit phones and IP-literal links; the commands / Ask scrubbers remove them;
 *   - the web "draft" action never sends an LLM-excluded person to Claude.
 */
import { describe, expect, it } from 'vitest';
import { scrub } from '../../src/commands/text';
import { allowlistLinks } from '../../src/ask/imessage';
import { BOT_MARKER, checkOutboundText } from '../../src/delivery/types';
import { createEgress, findRawIdentifiers } from '../../src/llm/egress';
import { applySuggestionFeedback } from '../../src/pipeline/suggestions/feedback';
import { generators as defaultGenerators } from '../../src/pipeline/suggestions/generators';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { memDb } from '../helpers';
import { fadingFriend, setSetting, suggestionRow, suggestionsDb, T0 } from '../pipeline/suggestions/world';

describe('egress: @handles anywhere', () => {
  const variants = ['ig:@jane.doe', 'ask "@jdoe" about it', 'ask “@jdoe” about it', 'thx,@other_one', '(@paren)', 'dm @plain'];
  it('the scanner finds every one; emails are not handles', () => {
    for (const v of variants) expect(findRawIdentifiers(v), v).toEqual([{ kind: 'handle', count: 1 }]);
    expect(findRawIdentifiers('mail owner@example.com')).toEqual([{ kind: 'email', count: 1 }]);
    expect(findRawIdentifiers('brunch@11 maybe')).toEqual([]);
  });

  it('the scrubber replaces every one, and its output passes the scanner', () => {
    const egress = createEgress(memDb());
    const p = egress.pseudonymize({ purpose: 'extract', sections: variants.map((text, i) => ({ name: `s${i}`, text })) });
    expect(p.text).not.toMatch(/@[A-Za-z]/);
    expect(p.replaced.handle).toBe(variants.length);
    expect(() => egress.scan(p.text)).not.toThrow();
    const fake = new FakeEgress().pseudonymize({ purpose: 'extract', sections: [{ name: 'x', text: variants.join(' ') }] });
    expect(fake.text).not.toMatch(/@[A-Za-z]/);
  });
});

describe('outbound text: bare phones and IP-literal links', () => {
  it('checkOutboundText rejects them', () => {
    expect(checkOutboundText(`${BOT_MARKER} call 2125550199`)).toContain('contains_identifier');
    expect(checkOutboundText(`${BOT_MARKER} call 12125550199`)).toContain('contains_identifier');
    expect(checkOutboundText(`${BOT_MARKER} see http://203.0.113.9/x`)).toContain('url_not_allowed');
    expect(checkOutboundText(`${BOT_MARKER} see 203.0.113.9`)).toContain('url_not_allowed');
    expect(checkOutboundText(`${BOT_MARKER} see https://yeackbot.com.evil.example/x`)).toContain('url_not_allowed');
    expect(checkOutboundText(`${BOT_MARKER} see https://yeackbot.com/today and www.yeackbot.com/p/1`)).toEqual([]);
    expect(checkOutboundText(`${BOT_MARKER} Wed Oct 14 · 4 for today\nyeackbot.com/today`)).toEqual([]);
  });

  it('the commands and Ask scrubbers remove them', () => {
    const out = scrub('call 2125550199 or see http://203.0.113.9/x and https://yeackbot.com/today');
    expect(out).not.toMatch(/2125550199|203\.0\.113/);
    expect(out).toContain('yeackbot.com/today');
    const ask = allowlistLinks('see http://203.0.113.9/x, 198.51.100.7 or https://yeackbot.com/ask/1');
    expect(ask).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect(ask).toContain('https://yeackbot.com/ask/1');
  });
});

describe('web draft openers respect LLM exclusions', () => {
  it('an excluded person gets template drafts and Claude is never called', async () => {
    const db = suggestionsDb();
    setSetting(db, 'learner.enabled', false);
    const f = fadingFriend(db, 'Bram', 'Ostrow');
    const r = await runSuggestionsStage(db, { now: T0, seed: 2, generators: defaultGenerators, wildcardSources: [] });
    const id = r.selectedIds.find((x) => suggestionRow(db, x).kind === 'fading')!;
    setSetting(db, 'llm.excluded_person_ids', [f.id]);
    const llm = new FakeLlmClient().on('digest', { json: { openers: ['Hey Bram!'] } });
    const services = () => ({ llm, egress: new FakeEgress(), outbound: new FakeOutboundSender(), push: new FakePushSender() });
    const out = await applySuggestionFeedback(db, id, { action: 'draft' }, { channel: 'web', now: T0 + 1000, services });
    expect(out.openers?.length).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(0);
    // …and without the exclusion the same request goes to Claude
    setSetting(db, 'llm.excluded_person_ids', []);
    await applySuggestionFeedback(db, id, { action: 'draft' }, { channel: 'web', now: T0 + 2000, services });
    expect(llm.calls).toHaveLength(1);
  });
});
