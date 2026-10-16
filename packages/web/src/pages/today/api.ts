/**
 * Today's queries and mutations (GET /today, suggestion feedback + "Why this?", open loops, alerts). Paths and
 * shapes: AGENT_ROUTES / @yb/shared. A route that hasn't landed answers 501 (isNotImplemented): never retried.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AlertList,
  BatchRef,
  LoopAction,
  OkResult,
  OpenLoopList,
  OpenLoopType,
  SuggestionFeedback,
  SuggestionFeedbackResult,
  TodayResponse,
  WhyThis,
} from '@yb/shared';
import { api, isApiError, qs } from '../../api/client';

export const todayKeys = {
  today: ['today'] as const,
  why: (id: string) => ['why', id] as const,
  loops: ['loops'] as const,
  alerts: ['alerts', 'open'] as const,
};

/** One retry for flaky networks; never for 4xx or 501 (not built yet). */
export const retryOnce = (count: number, e: unknown) => count < 1 && !(isApiError(e) && (e.status === 501 || (e.status >= 400 && e.status < 500)));

export const useToday = () =>
  useQuery({
    queryKey: todayKeys.today,
    queryFn: () => api.get<TodayResponse>('/today'),
    retry: retryOnce,
    // The brief lands during the morning: keep the page fresh while it's open.
    refetchInterval: 5 * 60_000,
  });

/** Only used when /today itself isn't available (the Today payload carries the open alerts). */
export const useAlerts = (enabled: boolean) =>
  useQuery({ queryKey: todayKeys.alerts, queryFn: () => api.get<AlertList>('/alerts?status=open'), enabled, retry: retryOnce });

export const useWhy = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: todayKeys.why(id),
    queryFn: () => api.get<WhyThis>(`/suggestions/${encodeURIComponent(id)}/why`),
    enabled,
    retry: retryOnce,
    staleTime: 5 * 60_000,
  });

const refreshAfterFeedback = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: todayKeys.today });
  void qc.invalidateQueries({ queryKey: todayKeys.loops });
  void qc.invalidateQueries({ queryKey: ['activity'] });
  void qc.invalidateQueries({ queryKey: ['learner'] });
};

export interface FeedbackVars {
  id: string;
  body: SuggestionFeedback;
}

/** Done / snooze / skip / wrong / mute / draft. Errors are shown by the caller (meta.silent). */
export function useFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: FeedbackVars) => api.post<SuggestionFeedbackResult>(`/suggestions/${encodeURIComponent(id)}/feedback`, body),
    meta: { silent: true },
    onSuccess: (_r, v) => {
      // A draft request only adds openers; everything else changes the card (and maybe the feed).
      if (v.body.action !== 'draft') refreshAfterFeedback(qc);
    },
  });
}

/** Partial credit for opening a card's link (fire and forget, never an error toast). */
export function useOpenFeedback() {
  return useMutation({
    mutationFn: (id: string) => api.post<SuggestionFeedbackResult>(`/suggestions/${encodeURIComponent(id)}/feedback`, { action: 'open' }),
    meta: { silent: true },
  });
}

export function useLoops(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: todayKeys.loops,
    queryFn: ({ pageParam }) => api.get<OpenLoopList>(`/loops${qs({ cursor: pageParam, limit: 30 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry: retryOnce,
  });
}

export function useLoopAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, body }: { type: OpenLoopType; id: string; body: LoopAction }) =>
      api.post<BatchRef>(`/loops/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: todayKeys.today });
      void qc.invalidateQueries({ queryKey: todayKeys.loops });
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

export function useDismissAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<OkResult>(`/alerts/${encodeURIComponent(id)}/dismiss`, {}),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: todayKeys.today });
      void qc.invalidateQueries({ queryKey: todayKeys.alerts });
    },
  });
}
