/**
 * The labeling API's write (POST /eval/labels): one label per item — a verdict per prediction (correct /
 * incorrect / unsure), what the system missed in the owner's words, a note, and (Ask) the people the answer
 * should have found. Relabeling replaces the label. Missing items may start with a tag ("interest: climbing",
 * "commitment: …", "reply: …", "relation: …") so recall can be split by kind; untagged ones count overall.
 */
import type { EvalLabelInput, EvalLabelResult } from '@yb/shared';
import type { DB } from '../db/connection';
import { badRequest, notFound } from '../http/errors';
import { getItem, writeLabel } from './store';
import type { StoredLabel } from './types';
import { canonFn, visibleFn } from './util';

export function saveLabel(db: DB, input: EvalLabelInput, now = Date.now()): EvalLabelResult {
  const item = getItem(db, input.itemId);
  if (!item) throw notFound('Eval item');
  const ids = new Set(item.predictions.map((p) => p.id));
  const unknown = input.verdicts.filter((v) => !ids.has(v.predictionId)).map((v) => v.predictionId);
  if (unknown.length) throw badRequest('Some verdicts name predictions this item does not have.', { predictionIds: unknown.slice(0, 10) });
  const seen = new Set<string>();
  for (const v of input.verdicts) {
    if (seen.has(v.predictionId)) throw badRequest('One verdict per prediction.');
    seen.add(v.predictionId);
  }
  let expected: string[] | null = null;
  if (input.expectedPersonIds) {
    if (item.set !== 'ask') throw badRequest('Expected people apply to Ask questions only.');
    const canon = canonFn(db);
    const visible = visibleFn(db);
    expected = [];
    for (const raw of input.expectedPersonIds) {
      const id = raw.toLowerCase();
      if (!visible(id)) throw badRequest('An expected person is unknown or hidden.');
      const c = canon(id);
      if (!expected.includes(c)) expected.push(c);
    }
  }
  const label: StoredLabel = {
    verdicts: input.verdicts.map((v) => ({ predictionId: v.predictionId, verdict: v.verdict })),
    missing: [...new Set(input.missing.map((m) => m.trim()).filter(Boolean))],
    note: input.note?.trim() ? input.note.trim() : null,
    labeledAt: now,
  };
  writeLabel(db, item.id, label, expected, now);
  return { itemId: item.id, labeledAt: now };
}
