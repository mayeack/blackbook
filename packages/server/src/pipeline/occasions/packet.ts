/**
 * The seam for the nightly LLM adjudication (PLAN step 4, a later phase). The deterministic run leaves every
 * candidate in occasion_candidates; this module turns one occasion into the packet the adjudicator sends and
 * defines the answer it must parse. Nothing here calls a model or leaves the Mac: the packet still carries raw
 * refs (p:<person id>, m:<message id>) and first names, and llm/egress.ts must pseudonymize it (P… tokens) before
 * any request is built. Applying an answer writes event_attendees rows with source 'llm' through the journal;
 * the deterministic step never overwrites those.
 */
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { plainText } from './text';

export const ADJUDICATION_PROMPT_VERSION = 'occ1';

const Evidence = z.object({ type: z.string(), weight: z.number(), evidence_ids: z.array(z.string()), ref: z.string().optional() });

export const AdjudicationPacket = z.object({
  version: z.literal(ADJUDICATION_PROMPT_VERSION),
  occasion: z.object({
    ref: z.string(),
    title: z.string().nullable(),
    venue: z.string().nullable(),
    starts_at: z.number(),
    ends_at: z.number().nullable(),
    all_day: z.boolean(),
    kind: z.string(),
    ticket_count: z.number().nullable(),
    /** Notes of every calendar copy, plain text, truncated. Untrusted data. */
    notes: z.array(z.string()),
  }),
  candidates: z.array(
    z.object({
      ref: z.string(),
      kind: z.enum(['person', 'name', 'group']),
      /** First name (persons) or the name as written (unresolved names, group nicknames). */
      label: z.string().nullable(),
      role: z.string().nullable(),
      score: z.number(),
      alternatives: z.array(z.string()),
      evidence: z.array(Evidence),
    }),
  ),
});
export type AdjudicationPacket = z.infer<typeof AdjudicationPacket>;

/** What the adjudicator must answer (PLAN: attendees[{ref, role, confidence, evidence_ids}] + is_social + kind). */
export const AdjudicationResult = z.object({
  is_social: z.boolean(),
  kind: z.enum(['social', 'logistics', 'appointment', 'work', 'lodging', 'travel', 'unknown']),
  attendees: z.array(
    z.object({
      ref: z.string(),
      role: z.enum(['companion', 'host', 'guest', 'ticket_holder', 'mentioned_only']),
      confidence: z.number().min(0).max(1),
      evidence_ids: z.array(z.string()),
    }),
  ),
});
export type AdjudicationResult = z.infer<typeof AdjudicationResult>;

interface CandRow {
  cand_key: string;
  kind: 'person' | 'name' | 'group';
  person_id: string | null;
  surface: string | null;
  role: string | null;
  score: number;
  signals: string;
  alternatives: string;
}

/** The packet for one occasion, or null when it isn't a live social occasion with candidates. */
export function buildAdjudicationPacket(db: DB, occasionId: string): AdjudicationPacket | null {
  const occ = db
    .prepare(`SELECT * FROM occasions WHERE id = ? AND merged_into_id IS NULL AND status = 'active' AND is_social = 1 AND sensitive = 0`)
    .get(occasionId) as
    | { id: string; title: string | null; venue_text: string | null; starts_at: number; ends_at: number | null; all_day: number; kind: string; ticket_count: number | null }
    | undefined;
  if (!occ) return null;
  const rows = db.prepare('SELECT * FROM occasion_candidates WHERE occasion_id = ? ORDER BY score DESC, cand_key').all(occasionId) as CandRow[];
  if (!rows.length) return null;
  const notes = (
    db
      .prepare(
        `SELECT ce.description FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref
         WHERE s.occasion_id = ? AND s.source = 'calendar' AND ce.description IS NOT NULL ORDER BY s.role, ce.id`,
      )
      .pluck()
      .all(occasionId) as string[]
  )
    .map((d) => plainText(d, 1000))
    .filter(Boolean);
  // Only visible people may be named in the packet (hidden/merged ones never were candidates).
  const firstName = db.prepare('SELECT coalesce(first_name, display_name) FROM person_visible WHERE id = ?').pluck();
  return AdjudicationPacket.parse({
    version: ADJUDICATION_PROMPT_VERSION,
    occasion: {
      ref: `o:${occ.id}`,
      title: occ.title,
      venue: occ.venue_text,
      starts_at: occ.starts_at,
      ends_at: occ.ends_at,
      all_day: occ.all_day === 1,
      kind: occ.kind,
      ticket_count: occ.ticket_count,
      notes,
    },
    candidates: rows.map((r) => ({
      ref: r.cand_key,
      kind: r.kind,
      label: r.kind === 'person' ? ((r.person_id && (firstName.get(r.person_id) as string | undefined)) ?? null) : r.surface,
      role: r.role,
      score: r.score,
      alternatives: (JSON.parse(r.alternatives) as string[]).map((id) => `p:${id}`),
      evidence: (JSON.parse(r.signals) as { t: string; w: number; m?: number[]; ref?: string }[]).map((s) => ({
        type: s.t,
        weight: s.w,
        evidence_ids: (s.m ?? []).map((id) => `m:${id}`),
        ...(s.ref ? { ref: s.ref } : {}),
      })),
    })),
  });
}

/** Live social occasions with candidates that the adjudicator hasn't seen since their last inference. */
export function occasionsAwaitingAdjudication(db: DB, limit = 100): string[] {
  return db
    .prepare(
      `SELECT id FROM occasions
       WHERE merged_into_id IS NULL AND status = 'active' AND is_social = 1 AND sensitive = 0 AND candidate_count > 0
         AND (adjudicated_at IS NULL OR (inferred_at IS NOT NULL AND inferred_at > adjudicated_at))
       ORDER BY starts_at DESC LIMIT ?`,
    )
    .pluck()
    .all(limit) as string[];
}
