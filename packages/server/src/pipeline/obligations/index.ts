/**
 * Public API of the obligations module (reply debts + commitments, intelligence §5). Other builders import only
 * from here:
 *
 *   extraction   upsertCommitmentFromExtraction(t, item)       one `commitments[]` item, inside the window batch
 *                recordNeedsReplyFromExtraction(t, verdict)    the window's `needs_reply`, inside the window batch
 *                recordNeedsReplyVerdict(db, verdict)          store only (the hourly pass applies it)
 *                openCommitmentsForPeople(db, personIds)       "open commitment ids" for people cards (K refs)
 *   person page  personOpenLoops(db, personId)                 GET /people/:id/loops
 *   today        todayOpenLoops(db) / openLoops(db, {cursor})   Today's strip / GET /loops
 *   routes       applyLoopAction(db, type, id, action, ctx)     POST /loops/:type/:id (journaled; undoable)
 *   suggestions  loopFeedbackFromSuggestion(db, sid, action)    done/snooze/dismiss/wrong on a digest card
 *   intel / ask  openLoopsByPerson(db, personIds)               brief attendees, get_person
 *   jobs         obligationsJobs (reply-debt, commitments hourly; obligations 07:00)
 */
export { applyLoopAction, loopFeedbackFromSuggestion, type LoopActionContext, type LoopActionResult } from './actions';
export {
  applyExtractedCommitments,
  COMMITMENT_KINDS,
  dueMoment,
  lapseMoment,
  openCommitmentsForPeople,
  upsertCommitmentFromExtraction,
  type CommitmentKind,
  type CommitmentOwner,
  type ExtractedCommitmentInput,
  type UpsertCommitmentResult,
} from './commitments';
export { COMMITMENT, REPLY_DEBT } from './constants';
export { commitmentCandidates, generators, replyDebtCandidates, wildcardSources } from './generators';
export { obligationsJobs } from './jobs';
export {
  openLoopCounts,
  openLoops,
  openLoopsByPerson,
  personOpenLoops,
  todayOpenLoops,
  waitingOnSurfaces,
  type LoopQuery,
} from './loops';
export { debtPriority, evaluateConversation } from './replyDebt';
export { runCommitments, runCommitmentsAsync, runReplyDebts, runReplyDebtsAsync } from './run';
export { scoreMessage } from './text';
export { recordNeedsReplyFromExtraction, recordNeedsReplyVerdict, type NeedsReplyInput, type NeedsReplyOutcome } from './verdicts';
