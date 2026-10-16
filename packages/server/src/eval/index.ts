/**
 * The evaluation harness (intelligence §8, PLAN Phase 4 "Verify"; golden sets scaled down per critic §5).
 * Public surface — other modules import only from here:
 *
 *   golden sets   sampleSet(db, set, o)            G1 extraction windows · G2 identity pairs · G3 reply-debt cases
 *                                                  frozen at a fixed time · G4 Ask questions, stratified, snapshotted
 *                                                  in the local database (eval_items; never in git, never sent)
 *                 ensureSampled(db, sets)          lazy top-up behind GET /eval/items
 *   labeling      itemPage(db, query)              GET /eval/items (rendered lines + predictions + progress)
 *                 saveLabel(db, input)             POST /eval/labels (per prediction correct / incorrect / unsure,
 *                                                  what was missed, Ask expected people)
 *   report        buildReport(db)                  GET /eval/report and `yb eval report`: per-field precision /
 *                                                  recall, groundedness, identity pairwise precision + duplicate
 *                                                  recall, reply-debt P/R, Ask recall@10 + citation validity, online
 *                                                  rates. Counts and rates only.
 *   comparison    planShadow(o) / runShadow(o)     prompt_version shadow replay of the last 7 days (+ G1) through
 *                                                  the fake or real LLM into eval_shadow_* (nothing applied), with
 *                                                  the diff and the promotion gate
 *   CLI           evalCommand(args, paths, io)     `yb eval …` (scripts/eval.mjs runs it standalone)
 *
 * No scheduled job: golden sets are built on demand from local data. The only LLM use is the explicit shadow
 * replay; every LLM-free metric works without an API key.
 */
export { evalCommand, EVAL_USAGE } from './cli';
export { buildReport, EVAL_TARGETS, shadowSummary, type ShadowSummary } from './metrics';
export { itemPage } from './page';
export { saveLabel } from './labels';
export { ensureSampled, sampleSet, type SampleOutcome } from './sample';
export { planShadow, runShadow, SHADOW_DEFAULTS, type ShadowOptions, type ShadowOutcome, type ShadowPlan } from './shadow';
export { latestShadowRun, getShadowRun } from './shadowStore';
export { EVAL_SET_TARGET_SIZES, resetSet, setCounts } from './store';
