/**
 * G4 Ask questions (intelligence §8): the owner's own finished Ask turns (web and iMessage `?`), one per distinct
 * question (the latest answer), web 60 % / iMessage 40 %. Predictions are the people the answer named, in order
 * (recall@10 against the expected set the owner enters) and the citations it kept (citation validity; ids the
 * model invented were already stripped and counted as violations).
 */
import type { AskCitation, PersonChip } from '@yb/shared';
import { maskText } from '../../routes/people';
import type { AskPayload, NewItem, StoredPrediction } from '../types';
import { shortDate, shuffle } from '../util';
import { fillStrata, type SampleContext, type SampleResult } from './context';

const CHANNEL_W: Record<string, number> = { web: 0.6, imessage: 0.4 };
export const ASK_TOP_K = 10;

interface TurnRow {
  id: string;
  conversation_id: string;
  channel: 'web' | 'imessage';
  question: string;
  answer: string | null;
  citations: string;
  people: string;
  violations: number;
  status: 'done' | 'degraded';
  prompt_version: string | null;
  created_at: number;
  finished_at: number | null;
}

export const normQuestion = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export async function sampleAsk(c: SampleContext): Promise<SampleResult> {
  const rows = c.db
    .prepare(
      `SELECT id, conversation_id, channel, question, answer, citations, people, violations, status, prompt_version, created_at, finished_at
       FROM ask_turns WHERE status IN ('done','degraded') AND finished_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 5000`,
    )
    .all() as TurnRow[];
  // Questions already in the set (any earlier answer to the same words counts).
  const taken = new Set<string>();
  const sampled = c.db.prepare(`SELECT payload FROM eval_items WHERE set_name = 'ask'`).pluck().all() as string[];
  for (const p of sampled) taken.add(normQuestion((JSON.parse(p) as AskPayload).question));
  const latest = new Map<string, TurnRow>();
  for (const r of rows) {
    const k = normQuestion(r.question);
    if (!k || taken.has(k) || latest.has(k) || c.exclude.has(`ask:${r.id}`)) continue;
    latest.set(k, r);
  }
  const pool = [...latest.values()];
  if (!pool.length || c.size <= 0) return { items: [], pool: 0 };
  const groups = new Map<string, TurnRow[]>();
  for (const r of shuffle(pool, c.rand)) {
    let g = groups.get(r.channel);
    if (!g) groups.set(r.channel, (g = []));
    g.push(r);
  }
  const items = await fillStrata(groups, (k) => CHANNEL_W[k] ?? 0.5, c.size, (r, stratum) => buildAsk(c, r, stratum));
  return { items, pool: pool.length };
}

function buildAsk(c: SampleContext, r: TurnRow, stratum: string): NewItem | null {
  let people: PersonChip[];
  let citations: AskCitation[];
  try {
    people = JSON.parse(r.people) as PersonChip[];
    citations = JSON.parse(r.citations) as AskCitation[];
  } catch {
    return null;
  }
  const predictions: StoredPrediction[] = [];
  let rank = 0;
  for (const p of people) {
    const v = c.visible(p.id);
    if (!v) continue; // hidden since: never shown, and doesn't count
    rank++;
    predictions.push({ id: `p:${v.id}`, kind: 'person', label: v.displayName, detail: `#${rank} in the answer`, refs: [`P:${v.id}`], m: { personId: v.id, rank } });
  }
  citations.forEach((ct, i) => {
    predictions.push({ id: `c:${i}`, kind: 'citation', label: maskText(ct.label), detail: ct.kind, refs: [ct.ref], m: { cat: ct.kind, subjectId: ct.ref } });
  });
  const payload: AskPayload = {
    kind: 'ask',
    turnId: r.id,
    conversationId: r.conversation_id,
    channel: r.channel,
    question: r.question,
    answer: r.answer,
    degraded: r.status === 'degraded',
    violations: r.violations,
    askedAt: r.created_at,
    finishedAt: r.finished_at,
  };
  const title = `${r.channel === 'web' ? 'Web' : 'iMessage'} · ${shortDate(r.created_at, c.tz, c.now)}${r.status === 'degraded' ? ' · without Claude' : ''}`;
  return { set: 'ask', subjectRef: `ask:${r.id}`, stratum, title, frozenAt: c.now, payload, predictions, promptVersion: r.prompt_version };
}
