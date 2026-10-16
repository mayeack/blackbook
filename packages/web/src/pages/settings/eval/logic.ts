/** Eval labeling + report helpers (pure; test/eval.test.ts). */
import type { EvalItem, EvalLabelInput, EvalMetric, EvalSet, EvalSetCount, EvalVerdict } from '@yb/shared';

export const SET_LABELS: Record<EvalSet, string> = {
  extraction: 'Extraction',
  identity: 'Identity pairs',
  reply_debt: 'Reply debt',
  ask: 'Ask',
};
export const SETS = Object.keys(SET_LABELS) as EvalSet[];

const SET_HINTS: Record<EvalSet, string> = {
  extraction: 'Is each fact, promise or relation really in these messages? Add anything it missed.',
  identity: 'Are these two the same person?',
  reply_debt: 'Did you owe a reply at this point in the conversation?',
  ask: 'Who should the answer have found?',
};
export const setHint = (s: EvalSet) => SET_HINTS[s];

export type Verdicts = Record<string, EvalVerdict>;

/** The saved verdicts of an item (empty when unlabeled). */
export function initialVerdicts(item: EvalItem): Verdicts {
  const out: Verdicts = {};
  for (const v of item.label?.verdicts ?? []) out[v.predictionId] = v.verdict;
  return out;
}

/** "Missing" textarea → items: one per line, trimmed, de-duplicated, ≤300 chars each, at most 50. */
export function parseMissing(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().slice(0, 300);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length === 50) break;
  }
  return out;
}

/** Every prediction needs a verdict ("unsure" counts); an item with no predictions can be saved as-is. */
export function canSave(item: EvalItem, verdicts: Verdicts): boolean {
  return item.predictions.every((p) => verdicts[p.id] != null);
}

export function buildLabelInput(item: EvalItem, verdicts: Verdicts, missingText: string, note: string, expectedPersonIds: readonly string[]): EvalLabelInput {
  const n = note.trim().slice(0, 1000);
  return {
    itemId: item.id,
    verdicts: item.predictions.filter((p) => verdicts[p.id] != null).map((p) => ({ predictionId: p.id, verdict: verdicts[p.id]! })),
    missing: parseMissing(missingText),
    ...(n ? { note: n } : {}),
    ...(item.set === 'ask' ? { expectedPersonIds: [...new Set(expectedPersonIds)].slice(0, 50) } : {}),
  };
}

/** labeled / target for a set's progress bar (0..1). */
export const progress = (c: EvalSetCount) => (c.target > 0 ? Math.min(1, c.labeled / c.target) : c.labeled > 0 ? 1 : 0);

const RATE_HINT = /rate|precision|recall|valid|grounded|share|accuracy|±|within|@/i;

/** "93.5%" for rates and shares, plain numbers otherwise; "—" without a value. */
export function metricText(m: Pick<EvalMetric, 'name' | 'value' | 'target'>, v: number | null = m.value): string {
  if (v == null) return '—';
  if (RATE_HINT.test(m.name) || (v >= 0 && v <= 1 && m.target >= 0 && m.target <= 1)) return `${(v * 100).toFixed(v * 100 >= 99.5 && v < 1 ? 2 : 1)}%`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** The server's pass flag, else computed from target and direction; null without a value. */
export function metricPass(m: EvalMetric): boolean | null {
  if (m.pass != null) return m.pass;
  if (m.value == null) return null;
  return m.higherIsBetter ? m.value >= m.target : m.value <= m.target;
}

/** "precision.interest" → "Precision · interest". */
export function metricLabel(name: string): string {
  const [head, ...rest] = name.split('.');
  const h = (head ?? name).replace(/_/g, ' ');
  const title = h ? h[0]!.toUpperCase() + h.slice(1) : name;
  return rest.length ? `${title} · ${rest.join(' ').replace(/_/g, ' ')}` : title;
}
