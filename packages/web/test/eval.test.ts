import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvalItem, EvalMetric } from '@yb/shared';
import { buildLabelInput, canSave, initialVerdicts, metricLabel, metricPass, metricText, parseMissing, progress } from '../src/pages/settings/eval/logic';

// Nothing in these tests may reach the network.
beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const item = (o: Partial<EvalItem> = {}): EvalItem => ({
  id: 'it-1',
  set: 'extraction',
  title: 'Group chat · Oct 3',
  lines: [
    { ref: 'm:1', at: 1, author: 'Avery Q.', text: 'Moving to Springfield next month!', context: false },
    { ref: 'm:0', at: 0, author: 'You', text: 'earlier context', context: true },
  ],
  predictions: [
    { id: 'p1', kind: 'fact', label: 'Avery Q. · moving to Springfield', detail: null, refs: ['m:1'] },
    { id: 'p2', kind: 'commitment', label: 'You: send the gym link', detail: 'due Thu', refs: ['m:1'] },
  ],
  expectedPersonIds: [],
  label: null,
  promptVersion: 'x1',
  createdAt: 1,
  ...o,
});

const metric = (o: Partial<EvalMetric> = {}): EvalMetric => ({ name: 'precision.interest', value: 0.9, target: 0.85, higherIsBetter: true, pass: null, n: 40, ...o });

describe('eval labeling', () => {
  it('starts from the saved verdicts', () => {
    expect(initialVerdicts(item())).toEqual({});
    const labeled = item({ label: { verdicts: [{ predictionId: 'p1', verdict: 'incorrect' }], missing: [], note: null, labeledAt: 5 } });
    expect(initialVerdicts(labeled)).toEqual({ p1: 'incorrect' });
  });

  it('every prediction needs a verdict; an empty window can be saved as-is', () => {
    expect(canSave(item(), { p1: 'correct' })).toBe(false);
    expect(canSave(item(), { p1: 'correct', p2: 'unsure' })).toBe(true);
    expect(canSave(item({ predictions: [] }), {})).toBe(true);
  });

  it('missing lines are trimmed, de-duplicated and capped', () => {
    expect(parseMissing(' likes climbing \n\nLikes climbing\nhas a dog\r\n')).toEqual(['likes climbing', 'has a dog']);
    expect(parseMissing('x'.repeat(400))[0]).toHaveLength(300);
    expect(parseMissing(Array.from({ length: 80 }, (_, i) => `m${i}`).join('\n'))).toHaveLength(50);
  });

  it('builds the label input (expected people only for the ask set)', () => {
    expect(buildLabelInput(item(), { p1: 'correct', p2: 'incorrect' }, 'has a dog', '  ', ['x'])).toEqual({
      itemId: 'it-1',
      verdicts: [
        { predictionId: 'p1', verdict: 'correct' },
        { predictionId: 'p2', verdict: 'incorrect' },
      ],
      missing: ['has a dog'],
    });
    const ask = buildLabelInput(item({ set: 'ask', predictions: [] }), {}, '', 'good one', ['a', 'b', 'a']);
    expect(ask).toEqual({ itemId: 'it-1', verdicts: [], missing: [], note: 'good one', expectedPersonIds: ['a', 'b'] });
  });

  it('progress toward each set’s target', () => {
    expect(progress({ set: 'identity', total: 300, labeled: 150, target: 300 })).toBe(0.5);
    expect(progress({ set: 'identity', total: 300, labeled: 400, target: 300 })).toBe(1);
    expect(progress({ set: 'ask', total: 0, labeled: 0, target: 0 })).toBe(0);
  });
});

describe('eval report formatting', () => {
  it('rates as percentages, counts as numbers', () => {
    expect(metricText(metric())).toBe('90.0%');
    expect(metricText(metric({ name: 'groundedness', value: 0.996, target: 0.99 }))).toBe('99.60%');
    expect(metricText(metric({ name: 'items', value: 12, target: 10 }))).toBe('12');
    expect(metricText(metric({ value: null }))).toBe('—');
  });

  it('pass: the server’s flag, else from target and direction', () => {
    expect(metricPass(metric({ pass: false }))).toBe(false);
    expect(metricPass(metric())).toBe(true);
    expect(metricPass(metric({ name: 'refusal_rate', value: 0.01, target: 0.005, higherIsBetter: false }))).toBe(false);
    expect(metricPass(metric({ value: null }))).toBeNull();
  });

  it('labels', () => {
    expect(metricLabel('precision.interest')).toBe('Precision · interest');
    expect(metricLabel('schema_valid')).toBe('Schema valid');
  });
});
