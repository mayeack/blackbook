/**
 * Open loops: reply debts and commitments (intelligence §5). Shown in Today's strip and on Person → Overview.
 *
 *   GET  /api/v1/people/:id/loops        → OpenLoopList (that person)
 *   GET  /api/v1/loops?cursor=&limit=    → OpenLoopList (everyone; Today's expanded strip)
 *   POST /api/v1/loops/:type/:id         LoopAction → BatchRef      (journaled; undoable)
 */
import { z } from 'zod';
import { DueWindow, EvidenceRef, Ms, PersonChip } from './common';

export const OpenLoopType = z.enum(['reply_debt', 'commitment']);
export type OpenLoopType = z.infer<typeof OpenLoopType>;

export const OpenLoop = z.object({
  type: OpenLoopType,
  id: z.string(),
  person: PersonChip,
  /** Commitments: the other people it involves. */
  otherPeople: z.array(PersonChip),
  /** "Asked if you're free Sat", "Send the gym link". Never sensitive text. */
  title: z.string(),
  detail: z.string().nullable(),
  /** reply_debt: when they asked; commitment: when it was made. */
  since: Ms,
  due: DueWindow.nullable(),
  /** commitment owner ('me' = you promised; 'them' = waiting on them). reply_debt: 'me'. */
  owner: z.enum(['me', 'them', 'both']),
  /** reply_debts.status / commitments.status */
  status: z.string(),
  /** reply_debt seen only by the heuristic (no LLM verdict yet): shown as "likely". */
  likely: z.boolean(),
  urgency: z.enum(['low', 'normal', 'high']).nullable(),
  confidence: z.number().nullable(),
  conversationId: z.string().nullable(),
  evidence: z.array(EvidenceRef),
});
export type OpenLoop = z.infer<typeof OpenLoop>;

export const OpenLoopList = z.object({
  replyDebts: z.array(OpenLoop),
  /** owner me/both */
  commitments: z.array(OpenLoop),
  /** owner them (surfaced for priority people or T ≥ 60 only) */
  waitingOn: z.array(OpenLoop),
  nextCursor: z.string().nullable(),
});
export type OpenLoopList = z.infer<typeof OpenLoopList>;

/** Today's collapsed strip: "reply debt n · promises n". */
export const OpenLoopCounts = z.object({ replyDebts: z.number().int(), commitments: z.number().int(), waitingOn: z.number().int() });
export type OpenLoopCounts = z.infer<typeof OpenLoopCounts>;

/** POST /loops/:type/:id */
export const LoopAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('done') }),
  z.object({ action: z.literal('snooze'), until: Ms }),
  /** reply_debt: "no reply needed"; commitment: cancelled/not happening. */
  z.object({ action: z.literal('dismiss') }),
  /** The agent got it wrong (retracts it; feeds the eval labels). */
  z.object({ action: z.literal('wrong') }),
]);
export type LoopAction = z.infer<typeof LoopAction>;
