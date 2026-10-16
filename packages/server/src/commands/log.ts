/**
 * `log: …` effects (PLAN "Two-way texting"): for each named person an interaction (kind text_log, 1.5 touch
 * units in ties), a note with his words (origin text_log, linked to the command's message) and, from the intent
 * parser only, facts at confidence 0.95 with source user_log. One journal batch in the command's run, so `undo`
 * (or the web feed) reverts it. Facts the owner already rejected (fact_blocks) are never re-added.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { withBatch } from '../journal/batch';
import { normText } from '../migration/convert';
import type { LogFactCat, LogKind } from './intent';

export const LOG_UNITS = 1.5;
export const LOG_FACT_CONFIDENCE = 0.95;
/** facts.type values whose content is personal enough to stay out of iMessage and push. */
const SENSITIVE_CATS = new Set<LogFactCat>(['relationship_status', 'family']);

const KIND_WORDS: [LogKind, RegExp][] = [
  ['coffee', /\b(coffee|espresso|latte|cafe|café|tea)\b/i],
  ['drinks', /\b(drinks?|beers?|wine|cocktails?|bar|pub|happy hour)\b/i],
  ['meal', /\b(lunch|dinner|breakfast|brunch|meal|ate|food|pizza|tacos|sushi)\b/i],
  ['call', /\b(call(?:ed)?|phone|facetime|zoom|video chat|rang)\b/i],
  ['party', /\b(party|birthday party|bbq|barbecue|gathering)\b/i],
  ['met', /\b(met|meet|saw|see|ran into|hung out|hang|visited|walk|hike|gym|climb(?:ing)?)\b/i],
];

export function deterministicKind(text: string): LogKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return 'other';
}

const KIND_TITLE: Record<LogKind, string> = {
  coffee: 'Coffee',
  meal: 'Meal',
  drinks: 'Drinks',
  call: 'Call',
  party: 'Party',
  met: 'Met up',
  other: 'Logged',
};
export const logKindTitle = (k: LogKind): string => KIND_TITLE[k];

export interface LogFact {
  personId: string;
  cat: LogFactCat;
  value: string;
}

export interface LogPlan {
  /** His words (after "log:"). */
  text: string;
  kind: LogKind;
  at: number;
  date: string;
  personIds: string[];
  /** false = add_fact: notes (and facts) only, no interaction. */
  interaction: boolean;
  facts: LogFact[];
}

export interface LogApplied {
  batchId: string | null;
  interactions: number;
  notes: number;
  facts: { personId: string; value: string; sensitive: boolean }[];
}

export function applyLog(
  db: DB,
  plan: LogPlan,
  o: { runId: string; now: number; messageId: number; title: string },
): LogApplied {
  const people = [...new Set(plan.personIds)];
  const factBlocked = db.prepare('SELECT 1 FROM fact_blocks WHERE person_id = ? AND type = ? AND value_norm = ?');
  const factLive = db.prepare(`SELECT 1 FROM facts WHERE person_id = ? AND type = ? AND value_norm = ? AND status IN ('candidate','tentative','confirmed')`);
  const evidence = db.prepare('INSERT OR IGNORE INTO evidence (subject_type, subject_id, message_id, quote) VALUES (?, ?, ?, ?)');
  const applied: LogApplied = { batchId: null, interactions: 0, notes: 0, facts: [] };
  const { batchId, changes } = withBatch(
    db,
    { runId: o.runId, kind: 'text_log', title: o.title, subjectPersonId: people[0] ?? null, confidence: 1, actor: 'user' },
    (t) => {
      for (const personId of people) {
        if (plan.interaction) {
          t.insert('interactions', {
            id: uuidv7(o.now),
            person_id: personId,
            kind: 'text_log',
            channel: null,
            started_at: plan.at,
            ended_at: null,
            units: LOG_UNITS,
            summary: KIND_TITLE[plan.kind],
            origin: 'user',
            created_by_run: o.runId,
          });
          applied.interactions++;
        }
        t.insert('notes', {
          id: uuidv7(o.now),
          person_id: personId,
          content: plan.text,
          category: 'text_log',
          origin: 'text_log',
          source_message_id: o.messageId,
        });
        applied.notes++;
      }
      for (const f of plan.facts) {
        if (!people.includes(f.personId)) continue;
        const value = f.value.trim().slice(0, 120);
        const valueNorm = normText(value);
        if (!valueNorm || factBlocked.get(f.personId, f.cat, valueNorm) || factLive.get(f.personId, f.cat, valueNorm)) continue;
        const id = uuidv7(o.now);
        const sensitive = SENSITIVE_CATS.has(f.cat);
        t.insert('facts', {
          id,
          person_id: f.personId,
          type: f.cat,
          value,
          value_norm: valueNorm,
          sensitive: sensitive ? 1 : 0,
          confidence: LOG_FACT_CONFIDENCE,
          support: 1,
          status: 'confirmed',
          valid_from: plan.at,
          recorded_at: o.now,
          source: 'user_log',
          run_id: o.runId,
        });
        evidence.run('fact', id, o.messageId, null);
        applied.facts.push({ personId: f.personId, value, sensitive });
      }
    },
    { now: o.now },
  );
  applied.batchId = changes ? batchId : null;
  return applied;
}
