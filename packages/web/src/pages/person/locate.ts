/**
 * `/p/:id?m=<messageId>[&at=<ms>]`: find the timeline session holding a cited message so the page can open it and
 * scroll to it. The timeline API pages sessions newest first and has no "around message" lookup, so:
 *
 *   - with `at` (the message time, which Ask and evidence links add): page until a session spans that time;
 *   - without it (or when the hint misses): open loaded sessions one by one (their message lists are cached for the cards anyway), newest
 *     first, up to a budget.
 *
 * `nextStep` is the pure decision; the hook in PersonTimeline does the fetching.
 */
import type { SessionItem, TimelineItem } from '../../api/types';

/** Message lists fetched while scanning without a time hint. */
export const SCAN_BUDGET = 40;
/** Timeline pages fetched while looking. */
export const PAGE_BUDGET = 25;
/** A message can sit a little outside its session's bounds (clock skew, edits). */
const SLACK_MS = 60_000;

export interface LocateTarget {
  messageId: number;
  at: number | null;
}

/** Reads `m` (a positive integer message id) and `at` (ms) from the query string. */
export function parseLocateTarget(params: URLSearchParams): LocateTarget | null {
  const m = params.get('m');
  if (!m || !/^\d{1,15}$/.test(m)) return null;
  const messageId = Number(m);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  const atRaw = params.get('at');
  const at = atRaw && /^\d{1,15}$/.test(atRaw) ? Number(atRaw) : null;
  return { messageId, at };
}

export type LocateStep =
  | { kind: 'check'; sessionId: string }
  | { kind: 'more' }
  | { kind: 'give_up' };

export interface LocateState {
  items: readonly TimelineItem[];
  hasNextPage: boolean;
  pagesLoaded: number;
  /** Sessions whose messages were already checked (and didn't hold the message). */
  checked: ReadonlySet<string>;
}

const isSession = (i: TimelineItem): i is SessionItem => i.type === 'session';

export function nextStep(target: LocateTarget, s: LocateState): LocateStep {
  const sessions = s.items.filter(isSession);
  const canPage = s.hasNextPage && s.pagesLoaded < PAGE_BUDGET;

  if (target.at != null) {
    const at = target.at;
    // Candidates spanning the time, then the nearest session that started before it.
    const spanning = sessions.filter((x) => x.startedAt - SLACK_MS <= at && at <= x.endedAt + SLACK_MS);
    const unchecked = spanning.find((x) => !s.checked.has(x.id));
    if (unchecked) return { kind: 'check', sessionId: unchecked.id };
    const oldest = s.items.length ? s.items[s.items.length - 1]!.startedAt : null;
    // Haven't reached that time yet: keep paging.
    if ((oldest === null || oldest > at - SLACK_MS) && canPage) return { kind: 'more' };
    // Past it with no spanning session left: try the closest sessions just before (the message may be late in one).
    const before = sessions
      .filter((x) => x.startedAt <= at + SLACK_MS && !s.checked.has(x.id))
      .sort((a, b) => Math.abs(at - a.endedAt) - Math.abs(at - b.endedAt))
      .slice(0, 3);
    if (before[0] && s.checked.size < SCAN_BUDGET) return { kind: 'check', sessionId: before[0].id };
    // The hint didn't pan out (clock skew, a merged conversation): fall back to the plain scan below.
  }

  if (s.checked.size >= SCAN_BUDGET) return { kind: 'give_up' };
  const next = sessions.find((x) => !s.checked.has(x.id));
  if (next) return { kind: 'check', sessionId: next.id };
  if (canPage) return { kind: 'more' };
  return { kind: 'give_up' };
}

/** DOM id of a rendered message bubble. */
export const messageDomId = (id: number) => `msg-${id}`;
