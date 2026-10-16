/**
 * Open-loop generators (intelligence §5 "Reply debt", "Commitments"): reply_debt from open reply_debts and
 * commitment_due from open/due commitments. The obligations pass owns those rows (detection, auto-close); these
 * only read them.
 *
 *   reply_debt      base = normalized priority, priority = urg · (0.3 + 0.7·T/100 + 0.3·priority) · age_w with
 *                   urg high 1.5 / normal 1.0 / low 0.6, age_w = min(1, age_h/48), ×0.5 after 14 days; normalized
 *                   by 1.3 (normal urgency, T = 100, priority) and clamped to [0, 1]. Heuristic debts below 0.6
 *                   confidence aren't shown. Expires 30 days after the question.
 *   commitment_due  base = 0.6 + 0.4·[owner me]; "waiting on them" items only for priority people or T ≥ 60, at
 *                   ×0.5. Due when status 'due', within 2 days of due_end, or vague and 21 days old; expires
 *                   30 days past due (lapsed).
 */
import type { Candidate, CandidateGenerator, GeneratorContext } from '../types';
import { clamp01, DAY, HOUR, round } from './common';

const URGENCY: Record<string, number> = { high: 1.5, normal: 1.0, low: 0.6 };
const REPLY_NORM = 1.3;
const COMMIT_DUE_SOON_MS = 2 * DAY;
const VAGUE_DUE_AFTER_MS = 21 * DAY;
const LAPSE_MS = 30 * DAY;

interface DebtRow {
  id: string;
  person_id: string;
  conversation_id: string;
  last_inbound_msg: number;
  asked_at: number;
  urgency: string | null;
  classifier: string;
  confidence: number | null;
  is_priority: number;
  tie_strength: number | null;
}

export function replyDebtPriority(r: Pick<DebtRow, 'urgency' | 'tie_strength' | 'is_priority' | 'asked_at'>, now: number): number {
  const urg = URGENCY[r.urgency ?? 'normal'] ?? 1;
  const ageH = Math.max(0, (now - r.asked_at) / HOUR);
  const ageW = Math.min(1, ageH / 48) * (ageH > 14 * 24 ? 0.5 : 1);
  return urg * (0.3 + (0.7 * (r.tie_strength ?? 0)) / 100 + 0.3 * r.is_priority) * ageW;
}

export const replyDebtGenerator: CandidateGenerator = {
  kind: 'reply_debt',
  generate(ctx: GeneratorContext): Candidate[] {
    const rows = ctx.db
      .prepare(
        `SELECT d.id, pv.id AS person_id, d.conversation_id, d.last_inbound_msg, d.asked_at, d.urgency, d.classifier, d.confidence,
                pv.is_priority, ps.tie_strength
         FROM reply_debts d
         JOIN person_canon pc ON pc.person_id = d.person_id
         JOIN person_visible pv ON pv.id = pc.canonical_id
         JOIN conversations c ON c.id = d.conversation_id AND c.agent_excluded = 0
         LEFT JOIN person_stats ps ON ps.person_id = pv.id
         WHERE (d.status = 'open' OR (d.status = 'snoozed' AND coalesce(d.snoozed_until, 0) <= ?))
           AND NOT (d.classifier = 'heuristic' AND coalesce(d.confidence, 1) < 0.6)
         ORDER BY d.id`,
      )
      .all(ctx.now) as DebtRow[];
    return rows.map((r) => {
      const ageH = Math.max(0, (ctx.now - r.asked_at) / HOUR);
      return {
        kind: 'reply_debt' as const,
        personIds: [r.person_id],
        subjectKey: r.id,
        base: clamp01(replyDebtPriority(r, ctx.now) / REPLY_NORM),
        evidenceIds: [`m:${r.last_inbound_msg}`],
        expiresAt: r.asked_at + 30 * DAY,
        links: { replyDebtId: r.id },
        payload: {
          ageH: Math.round(ageH),
          ageD: round(ageH / 24, 0),
          urgency: r.urgency ?? 'normal',
          likely: r.classifier === 'heuristic',
          tie: round(r.tie_strength, 0),
          conversationId: r.conversation_id,
        },
      };
    });
  },
};

interface CommitRow {
  id: string;
  person_id: string;
  owner: 'me' | 'them' | 'both';
  kind: string;
  due_at: number | null;
  due_start: number | null;
  due_end: number | null;
  due_precision: string | null;
  status: string;
  conversation_id: string | null;
  created_at: number;
  is_priority: number;
  tie_strength: number | null;
  sensitive: number;
}

/** When the commitment counts as due (null = not yet). */
export function commitmentDueAt(r: Pick<CommitRow, 'status' | 'due_at' | 'due_end' | 'due_precision' | 'created_at'>): number | null {
  const end = r.due_end ?? r.due_at;
  if (end !== null && r.due_precision !== 'vague' && r.due_precision !== 'none') return end;
  return r.created_at + VAGUE_DUE_AFTER_MS;
}

export const commitmentGenerator: CandidateGenerator = {
  kind: 'commitment_due',
  generate(ctx: GeneratorContext): Candidate[] {
    const rows = ctx.db
      .prepare(
        `SELECT k.id, pv.id AS person_id, k.owner, k.kind, k.due_at, k.due_start, k.due_end, k.due_precision, k.status,
                k.conversation_id, k.created_at, k.sensitive, pv.is_priority, ps.tie_strength
         FROM commitments k
         JOIN person_canon pc ON pc.person_id = k.person_id
         JOIN person_visible pv ON pv.id = pc.canonical_id
         LEFT JOIN person_stats ps ON ps.person_id = pv.id
         WHERE k.status IN ('open','due') OR (k.status = 'snoozed' AND coalesce(k.snoozed_until, 0) <= ?)
         ORDER BY k.id`,
      )
      .all(ctx.now) as CommitRow[];
    const out: Candidate[] = [];
    for (const r of rows) {
      const dueAt = commitmentDueAt(r);
      const isDue = r.status === 'due' || (dueAt !== null && dueAt - COMMIT_DUE_SOON_MS <= ctx.now);
      if (!isDue) continue;
      const mine = r.owner === 'me' || r.owner === 'both';
      if (!mine && !(r.is_priority === 1 || (r.tie_strength ?? 0) >= 60)) continue;
      const base = clamp01((0.6 + (mine ? 0.4 : 0)) * (mine ? 1 : 0.5));
      const expiresAt = dueAt === null ? null : dueAt + LAPSE_MS;
      if (expiresAt !== null && expiresAt <= ctx.now) continue; // lapsed: the obligations pass asks "did this happen?"
      out.push({
        kind: 'commitment_due',
        personIds: [r.person_id],
        subjectKey: r.id,
        base,
        evidenceIds: [`K${r.id}`],
        expiresAt,
        // A sensitive promise reads "Something personal — open the app" outside the web.
        sensitive: r.sensitive === 1,
        links: { commitmentId: r.id },
        payload: {
          owner: r.owner,
          commitmentKind: r.kind,
          dueAt,
          overdueD: dueAt === null ? null : round(Math.max(0, ctx.now - dueAt) / DAY, 0),
          precision: r.due_precision ?? 'none',
          conversationId: r.conversation_id,
        },
      });
    }
    return out;
  },
};
