/**
 * Public API of the extraction module (PLAN "LLM extraction", intelligence §4). Other builders import only from
 * here:
 *
 *   jobs        extractionJobs: extract-submit (daily), extract-collect (5 min), extract-backfill (manual only)
 *   CLI         backfillExtractCommand (`yb backfill-extract [--plan] [--json]`)
 *   on demand   consolidatePerson(deps, personId)      dedupe/normalize one person's facts + a 2-sentence summary
 *   person page personSummary(db, personId)            that summary (display-ready), or null
 *   eval / UI   loadPacket(db, windowId)               a window's lines as sent (pseudonymized), refs and result
 *               backfillStatus(db) / planBackfill(db)  progress / a read-only estimate (counts only)
 *   batch hook  collect(deps)                          consumes this module's batches (purpose extract /
 *                                                       historical / consolidate); the generic LLM collector
 *                                                       should leave those to it
 *   contracts   Extraction / Consolidation (zod), EXTRACTION_PROMPT_VERSION, GATES
 */
export { backfillExtractCommand, BACKFILL_EXTRACT_USAGE } from './cli';
export { consolidatePerson, personSummary, type ConsolidateOutcome } from './consolidate';
export { extractionJobs } from './jobs';
export { loadPacket, type Packet, type PacketLine } from './packet';
export { CONSOLIDATION_PROMPT_VERSION, EXTRACTION_PROMPT_VERSION } from './prompt';
export {
  advanceBackfill,
  backfillStatus,
  collect,
  planBackfill,
  startBackfill,
  submitSteady,
  type BackfillPlan,
  type BackfillReport,
  type BackfillStatus,
  type ExtractionDeps,
} from './run';
export { Consolidation, Extraction, FACT_CATS, RELATION_LABELS } from './schema';
export { GATES, validateExtraction, type ValidatedWindow } from './validate';
