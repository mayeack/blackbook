import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@yb/shared';
import { MergeRefusedError } from '../identity/merge';
import { UndoError } from '../journal/undo';
import { errorFields, type Logger } from '../ops/logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);

const body = (code: string, message: string, details?: unknown): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

interface SqliteError extends Error {
  code: string;
}
const isSqliteError = (e: unknown): e is SqliteError =>
  e instanceof Error && typeof (e as SqliteError).code === 'string' && (e as SqliteError).code.startsWith('SQLITE_');

const UNDO_STATUS: Record<UndoError['code'], number> = {
  NOT_FOUND: 404,
  ALREADY_UNDONE: 409,
  NOT_UNDOABLE: 409,
  CASCADE_REQUIRED: 409,
  CONFLICT: 409,
};

/** Maps known errors to `{error:{code,message}}`; anything unexpected is logged (redacted) and becomes a bare 500. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(body(err.code, err.message, err.details));
      return;
    }
    if (err instanceof UndoError) {
      res.status(UNDO_STATUS[err.code]).json(body(err.code, err.message, err.details));
      return;
    }
    if (err instanceof MergeRefusedError) {
      res.status(409).json(body(`MERGE_${err.reason.toUpperCase()}`, err.message));
      return;
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      res.status(400).json(body('VALIDATION', 'The request is invalid.', issues));
      return;
    }
    if (isSqliteError(err) && err.code.startsWith('SQLITE_CONSTRAINT')) {
      res.status(409).json(body('CONSTRAINT', 'That change conflicts with existing data.'));
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json(body('BAD_JSON', 'Request body is not valid JSON.'));
      return;
    }
    const e = err as { status?: unknown; statusCode?: unknown };
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
    if (status != null && status >= 400 && status < 500) {
      const code = status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST';
      res.status(status).json(body(code, status === 413 ? 'Request is too large.' : 'Bad request.'));
      return;
    }
    log.error('http.unhandled', { method: req.method, route: routePattern(req), ...errorFields(err) });
    res.status(500).json(body('INTERNAL', 'Unexpected server error.'));
  };
}

/** The matched route pattern (never the raw URL, which may carry ids or query text). */
export function routePattern(req: { baseUrl?: string; originalUrl?: string; route?: { path?: unknown } }): string {
  const p = req.route?.path;
  if (typeof p !== 'string') return 'unmatched';
  const base = req.baseUrl || (req.originalUrl?.startsWith('/api/v1/') ? '/api/v1' : '');
  return `${base}${p}`;
}
