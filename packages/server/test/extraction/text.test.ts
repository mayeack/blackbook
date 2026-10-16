import { describe, expect, it } from 'vitest';
import { findRawIdentifiers } from '../../src/llm/egress';
import { promptVersion } from '../../src/llm/types';
import {
  CONSOLIDATION_PROMPT_VERSION,
  CONSOLIDATION_SYSTEM,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_JSON,
  EXTRACTION_SYSTEM,
  estimateTokens,
} from '../../src/extraction/prompt';
import { Extraction } from '../../src/extraction/schema';
import {
  attachmentToken,
  checkQuote,
  isLifeEventText,
  isSensitiveText,
  isTrivialMessage,
  jaroWinkler,
  lineText,
  normQuote,
  normValue,
  replaceLinks,
  truncateAtSentence,
} from '../../src/extraction/text';
import { chronoDates } from '../../src/extraction/validate';
import { localDateEndMs, localDateToMs } from '../../src/extraction/env';

describe('the system prompt', () => {
  it('is byte-stable (~5k tokens), has no identifiers, timestamps of "now" or flags; the version is stable', () => {
    expect(estimateTokens(EXTRACTION_SYSTEM)).toBeGreaterThan(3500);
    expect(estimateTokens(EXTRACTION_SYSTEM)).toBeLessThan(7000);
    expect(findRawIdentifiers(EXTRACTION_SYSTEM)).toEqual([]);
    expect(findRawIdentifiers(CONSOLIDATION_SYSTEM)).toEqual([]);
    expect(EXTRACTION_SYSTEM).not.toMatch(/\$\{|undefined|NaN/);
    expect(EXTRACTION_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(EXTRACTION_PROMPT_VERSION).toBe(promptVersion(EXTRACTION_SYSTEM, EXTRACTION_SCHEMA_JSON, 'low'));
    expect(CONSOLIDATION_PROMPT_VERSION).not.toBe(EXTRACTION_PROMPT_VERSION);
    // Op semantics, exclusions, the injection notice and the mode rules are all in it.
    for (const s of ['ADD', 'UPDATE', 'INVALIDATE', 'NOOP', 'birthdays', 'untrusted data', 'mode=historical', 'sensitive: true', 'next week']) {
      expect(EXTRACTION_SYSTEM).toContain(s);
    }
  });

  it('the few-shot outputs are valid Extraction objects (structured outputs: every field present)', () => {
    const outputs = [...EXTRACTION_SYSTEM.matchAll(/^Output:\n(\{.*\})$/gm)].map((m) => JSON.parse(m[1]!));
    expect(outputs).toHaveLength(3);
    for (const o of outputs) expect(Extraction.safeParse(o).success).toBe(true);
    // No numeric bounds in the schema (the API drops them; code validates).
    expect(EXTRACTION_SCHEMA_JSON).not.toMatch(/"(minimum|maximum|minLength|maxLength)"/);
  });
});

describe('quotes', () => {
  it('normalizes NFKC, case, curly quotes, whitespace and edge punctuation', () => {
    expect(normQuote('  “Moving to  DENVER!” ')).toBe('moving to denver');
    expect(checkQuote('moving to Denver', 'big news: I’m moving to Denver on April 1')).toBe('ok');
    expect(checkQuote('I’m moving', "big news: I'm moving to Denver")).toBe('ok');
    expect(checkQuote('moving to Boston', 'moving to Denver')).toBe('not_found');
    expect(checkQuote('ok', 'ok')).toBe('too_short');
    expect(checkQuote('x'.repeat(201), 'x'.repeat(300))).toBe('too_long');
  });

  it('long quotes pass at token-set ratio ≥0.9 (one dropped filler word)', () => {
    const text = 'we should really grab tacos after the pottery class next week for sure';
    expect(checkQuote('we should grab tacos after the pottery class next week for sure', text)).toBe('ok');
    expect(checkQuote('we should grab burgers before the ceramics workshop on monday', text)).toBe('not_found');
  });
});

describe('triage', () => {
  it('drops tapbacks, emoji, short closers, OTP codes, bare links and attachment-only rows', () => {
    const t = (text: string | null, kind = 'text') => isTrivialMessage({ kind, text, attachments: null });
    expect(t('Loved “see you then”')).toBe(true);
    expect(t('😂😂')).toBe(true);
    expect(t('ok cool')).toBe(true);
    expect(t('Your verification code is 482913')).toBe(true);
    expect(t('https://example.org/some/page')).toBe(true);
    expect(t(null, 'attachment')).toBe(true);
    expect(t('I started pottery classes')).toBe(false);
  });
});

describe('values and screens', () => {
  it('normalizes values and folds interest synonyms', () => {
    expect(normValue('Rock Climbing!')).toBe('climbing');
    expect(normValue('The Denver', 'location_current')).toBe('denver');
    expect(normValue('Bouldering', 'interest')).toBe('climbing');
    expect(jaroWinkler('denver', 'denver co')).toBeGreaterThan(0.9);
    expect(jaroWinkler('climbing', 'cooking')).toBeLessThan(0.92);
  });

  it('flags life events (never facts) and sensitive topics', () => {
    expect(isLifeEventText('birthday on May 3')).toBe(true);
    expect(isLifeEventText('pregnant with twins')).toBe(true);
    expect(isLifeEventText('turns 40 next month')).toBe(true);
    expect(isLifeEventText('climbing')).toBe(false);
    expect(isSensitiveText('sees a therapist weekly')).toBe(true);
    expect(isSensitiveText('loves jazz')).toBe(false);
  });

  it('renders links, attachments and long text for lines', () => {
    expect(replaceLinks('look https://www.example.org/a?b=1 ok')).toBe('look <link:example.org> ok');
    expect(attachmentToken({ mime: 'image/heic' })).toBe('<image>');
    expect(attachmentToken({ kind: 'video' })).toBe('<video>');
    expect(attachmentToken({ name: 'menu.PDF' })).toBe('<file:pdf>');
    expect(attachmentToken({ is_sticker: true })).toBe('<sticker>');
    expect(lineText('a\nb')).toBe('a / b');
    expect(lineText('x'.repeat(2000)).length).toBe(1200);
    expect(truncateAtSentence('One. Two. Three is long.', 12)).toBe('One. Two.');
  });
});

describe('dates', () => {
  it('local dates ↔ ms in the configured zone', () => {
    const start = localDateToMs('2026-10-16', 'America/Chicago')!;
    expect(new Date(start).toISOString()).toBe('2026-10-16T05:00:00.000Z');
    expect(localDateEndMs('2026-10-16', 'America/Chicago')! - start).toBe(86_400_000 - 1);
    expect(localDateToMs('2026-02-30', 'America/Chicago')).toBeNull();
    expect(localDateToMs('next week', 'America/Chicago')).toBeNull();
  });

  it('chrono reads quotes against the message time, forward', () => {
    // Sunday 2026-03-08 18:06 Chicago → "thursday" is 2026-03-12.
    const at = Date.UTC(2026, 2, 8, 23, 6);
    expect(chronoDates('dinner thursday?', at, 'America/Chicago')).toMatchObject({ start: '2026-03-12', explicit: true });
    expect(chronoDates('see you tomorrow', at, 'America/Chicago')?.start).toBe('2026-03-09');
    expect(chronoDates('sounds fun', at, 'America/Chicago')).toBeNull();
  });
});
