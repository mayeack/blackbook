/**
 * 🎲 "A suggestion kind not shown in 14 days": today's stored candidates (emitted by this run) of kinds that no
 * digest carried in the last 14 days. Runs after the stage has upserted the regular candidates, so it reads them
 * back from `suggestions` (same dedupe keys: picking one flags that row as the wildcard).
 */
import type { SuggestionKind } from '@yb/shared';
import type { DB } from '../../../db/connection';
import type { Candidate, CandidateLinks, GeneratorContext, WildcardSource } from '../types';
import { DAY } from './common';

export const UNSEEN_DAYS = 14;

interface Row {
  kind: SuggestionKind;
  subject_key: string;
  person_ids: string;
  base_score: number | null;
  evidence_ids: string;
  expires_at: number | null;
  time_critical: number;
  sensitive: number;
  signals: string;
  event_id: string | null;
  occasion_id: string | null;
  circle_id: string | null;
  commitment_id: string | null;
  reply_debt_id: string | null;
  trip_id: string | null;
  related_person_id: string | null;
}

/** Kinds some digest carried since `since`. */
export function kindsShownSince(db: DB, since: number): Set<SuggestionKind> {
  return new Set(db.prepare('SELECT DISTINCT kind FROM suggestions WHERE selected_at >= ?').pluck().all(since) as SuggestionKind[]);
}

export function rowToCandidate(r: Row): Candidate {
  const links: CandidateLinks = {
    eventId: r.event_id,
    occasionId: r.occasion_id,
    circleId: r.circle_id,
    commitmentId: r.commitment_id,
    replyDebtId: r.reply_debt_id,
    tripId: r.trip_id,
    relatedPersonId: r.related_person_id,
  };
  return {
    kind: r.kind,
    personIds: JSON.parse(r.person_ids) as string[],
    subjectKey: r.subject_key,
    base: r.base_score ?? 0,
    evidenceIds: JSON.parse(r.evidence_ids) as string[],
    expiresAt: r.expires_at,
    timeCritical: r.time_critical === 1,
    sensitive: r.sensitive === 1,
    links,
    payload: JSON.parse(r.signals) as Candidate['payload'],
  };
}

export const unseenKindWildcard: WildcardSource = {
  generator: 'unseen_kind',
  generate(ctx: GeneratorContext): Candidate[] {
    if (!ctx.runId) return [];
    const shown = kindsShownSince(ctx.db, ctx.now - UNSEEN_DAYS * DAY);
    const rows = ctx.db
      .prepare(
        `SELECT kind, subject_key, person_ids, base_score, evidence_ids, expires_at, time_critical, sensitive, signals,
                event_id, occasion_id, circle_id, commitment_id, reply_debt_id, trip_id, related_person_id
         FROM suggestions WHERE last_seen_run = ? AND status = 'candidate' AND subject_key IS NOT NULL ORDER BY dedupe_key`,
      )
      .all(ctx.runId) as Row[];
    return rows.filter((r) => !shown.has(r.kind) && r.kind !== 'wildcard').map(rowToCandidate);
  },
};
