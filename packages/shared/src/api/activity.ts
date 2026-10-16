import { z } from 'zod';

/** Every error response: `{error:{code, message, details?}}`. */
export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Me = z.object({ email: z.string(), via: z.enum(['access', 'dev-bypass']) });
export type Me = z.infer<typeof Me>;

export const BatchActor = z.enum(['agent', 'user', 'system']);

export const ActivityBatch = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  title: z.string(),
  subjectPersonId: z.string().nullable(),
  confidence: z.number().nullable(),
  actor: BatchActor,
  undoable: z.boolean(),
  createdAt: z.number().int(),
  undoneAt: z.number().int().nullable(),
  undoneByBatchId: z.string().nullable(),
  revertsBatchId: z.string().nullable(),
  changeCount: z.number().int(),
});
export type ActivityBatch = z.infer<typeof ActivityBatch>;

export const ActivityRun = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  undoneAt: z.number().int().nullable(),
});
export type ActivityRun = z.infer<typeof ActivityRun>;

/** GET /api/v1/activity?cursor=&limit= — batches newest first, grouped by run within the page. */
export const ActivityPage = z.object({
  groups: z.array(z.object({ run: ActivityRun, batches: z.array(ActivityBatch) })),
  nextCursor: z.string().nullable(),
});
export type ActivityPage = z.infer<typeof ActivityPage>;

export const UndoRequest = z.object({
  /** Also undo later changes that depend on this one (the UI asks first). */
  cascade: z.boolean().optional(),
});
export type UndoRequest = z.infer<typeof UndoRequest>;

export const UndoneBatch = z.object({
  batchId: z.string(),
  kind: z.string(),
  title: z.string(),
  runId: z.string(),
  undoBatchId: z.string(),
});

export const UndoResult = z.object({
  dryRun: z.boolean(),
  runId: z.string().nullable(),
  /** In execution order (newest first). */
  undone: z.array(UndoneBatch),
  /** Undone only because a requested change depended on them (other runs for a run undo). */
  cascaded: z.array(z.string()),
  countsByKind: z.record(z.string(), z.number().int()),
});
export type UndoResult = z.infer<typeof UndoResult>;
