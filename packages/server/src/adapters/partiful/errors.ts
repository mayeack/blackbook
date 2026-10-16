/**
 * Partiful adapter errors. Messages are fixed sentences plus function names, HTTP statuses and Firebase status
 * codes: never tokens, URLs with the API key, response bodies, names or event titles (they reach job_runs and
 * the Sources screen).
 */

/** The sandbox browser's viewer, where the owner signs in to Partiful. */
export const SANDBOX_VIEWER_URL = 'https://127.0.0.1:4330';
export const SIGN_IN_MESSAGE = `Sign in to Partiful in the sandbox browser (${SANDBOX_VIEWER_URL})`;

const FN_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A function name or Firebase status code safe to put in a message (anything else becomes "?"). */
export const safeToken = (s: string, re: RegExp = FN_RE): string => (re.test(s) ? s : '?');

export type AuthRequiredReason =
  | 'browser_unreachable' // CDP endpoint down (OrbStack / yb-browser not running)
  | 'not_signed_in' // no Firebase user in partiful.com's IndexedDB
  | 'refresh_rejected' // securetoken refused the refresh token, and the browser had no newer one
  | 'api_unauthorized' // api.partiful.com kept answering 401 with a fresh ID token
  | 'no_session'; // nothing stored and no browser configured

export class PartifulAuthRequiredError extends Error {
  constructor(readonly reason: AuthRequiredReason) {
    super(`${SIGN_IN_MESSAGE} [${reason}]`);
    this.name = 'PartifulAuthRequiredError';
  }
}

/** A response (or the token endpoint) no longer matches what the adapter understands. */
export class PartifulContractError extends Error {
  constructor(
    readonly fn: string,
    readonly what: string,
    readonly paths: readonly string[] = [],
  ) {
    const where = paths.length ? ` at ${paths.slice(0, 5).join(', ')}` : '';
    super(`Partiful ${safeToken(fn)} broke the expected contract (${what}${where})`);
    this.name = 'PartifulContractError';
  }
}

/** A Firebase callable error for one call (NOT_FOUND, PERMISSION_DENIED, INVALID_ARGUMENT, …). */
export class PartifulCallError extends Error {
  constructor(
    readonly fn: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(`Partiful ${safeToken(fn)} returned ${safeToken(code, CODE_RE)} (HTTP ${httpStatus})`);
    this.name = 'PartifulCallError';
  }
}

/** Transport failures and 5xx: retry later. */
export class PartifulHttpError extends Error {
  constructor(
    readonly fn: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(`Partiful ${safeToken(fn)} failed (${status === null ? safeToken(code, /^[A-Z_]{1,40}$/) : `HTTP ${status}`})`);
    this.name = 'PartifulHttpError';
  }
}

/** HTTP 429: stop this run, keep what was read. */
export class PartifulRateLimitedError extends Error {
  constructor(readonly fn: string) {
    super(`Partiful rate-limited ${safeToken(fn)} (HTTP 429)`);
    this.name = 'PartifulRateLimitedError';
  }
}

/** The per-run call budget is spent; the next run continues (trickled backfill). */
export class PartifulBudgetError extends Error {
  constructor(readonly maxCalls: number) {
    super(`Partiful call budget of ${maxCalls} per run is spent`);
    this.name = 'PartifulBudgetError';
  }
}

/** A function outside the hard-coded read-only allowlist: a programming error, never sent. */
export class PartifulForbiddenFunctionError extends Error {
  constructor(fn: string) {
    super(`Partiful function ${safeToken(fn)} is not on the read-only allowlist`);
    this.name = 'PartifulForbiddenFunctionError';
  }
}
