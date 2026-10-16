import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeEventsPage, normalizeGoogleStatus, normalizeOccasionDetail } from '../lib/events';
import { api, ApiError, isApiError, qs } from './client';
import type {
  ActivityPage,
  EventsWhen,
  HiddenPage,
  Me,
  PeoplePage,
  PeopleSort,
  PersonDetail,
  RevealedIdentity,
  SessionMessages,
  SourcesView,
  TimelinePage,
  UndoResult,
} from './types';

export const keys = {
  me: ['me'] as const,
  people: (q: string, sort: PeopleSort) => ['people', { q, sort }] as const,
  person: (id: string) => ['person', id] as const,
  timeline: (id: string) => ['timeline', id] as const,
  session: (personId: string, sessionId: string) => ['session', personId, sessionId] as const,
  sources: ['sources'] as const,
  activity: ['activity'] as const,
  hidden: ['settings', 'hidden'] as const,
  events: (when: EventsWhen) => ['events', when] as const,
  event: (id: string) => ['event', id] as const,
  google: ['google', 'status'] as const,
};

/** 501 = that API hasn't landed on this server yet: show "not available", don't retry. */
export const isNotImplemented = (e: unknown) => isApiError(e) && e.status === 501;
const retryOnce = (count: number, e: unknown) => count < 1 && !(isApiError(e) && (e.status === 501 || (e.status >= 400 && e.status < 500)));

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>('/me'), staleTime: 5 * 60_000 });

export function usePeople(q: string, sort: PeopleSort) {
  return useInfiniteQuery({
    queryKey: keys.people(q, sort),
    queryFn: ({ pageParam }) => api.get<PeoplePage>(`/people${qs({ q, sort, cursor: pageParam, limit: 200 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export const usePerson = (id: string) =>
  useQuery({ queryKey: keys.person(id), queryFn: () => api.get<PersonDetail>(`/people/${encodeURIComponent(id)}`) });

/** source: a channel ('whatsapp', 'instagram', …) or null for everything. */
export function useTimeline(id: string, source: string | null = null, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...keys.timeline(id), source ?? 'all'],
    queryFn: ({ pageParam }) =>
      api.get<TimelinePage>(`/people/${encodeURIComponent(id)}/timeline${qs({ cursor: pageParam, limit: 30, source })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Keep the old list while a filter change loads, but never show another person's timeline.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
    enabled,
  });
}

export const useSessionMessages = (personId: string, sessionId: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.session(personId, sessionId),
    queryFn: () =>
      api.get<SessionMessages>(`/people/${encodeURIComponent(personId)}/sessions/${encodeURIComponent(sessionId)}/messages`),
    enabled,
    staleTime: 5 * 60_000,
  });

/** On demand only (a mutation, so the full value is never cached or refetched in the background). */
export const useReveal = (personId: string) =>
  useMutation({
    mutationFn: (identityId: string) =>
      api.get<RevealedIdentity>(`/people/${encodeURIComponent(personId)}/identities/${encodeURIComponent(identityId)}/reveal`),
  });

export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => api.get<SourcesView>('/sources'), refetchInterval: 60_000 });

export function useActivity() {
  return useInfiniteQuery({
    queryKey: keys.activity,
    queryFn: ({ pageParam }) => api.get<ActivityPage>(`/activity${qs({ cursor: pageParam, limit: 50 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export const useHidden = () => useQuery({ queryKey: keys.hidden, queryFn: () => api.get<HiddenPage>('/settings/hidden') });

/** Unhide is journaled: the person reappears everywhere and the change shows (undoable) in the activity feed. */
export function useUnhide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ batchId: string }>(`/settings/hidden/${encodeURIComponent(id)}/unhide`),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries(),
  });
}

export interface UndoVars {
  id: string;
  cascade?: boolean;
  dryRun?: boolean;
}

/** Undo one change batch or a whole run. A real undo can change anything, so everything is refetched. */
export function useUndo(target: 'batch' | 'run') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cascade, dryRun }: UndoVars) =>
      api.post<UndoResult>(
        `/${target === 'batch' ? 'activity' : 'runs'}/${encodeURIComponent(id)}/undo${dryRun ? '?dryRun=1' : ''}`,
        cascade ? { cascade: true } : {},
      ),
    meta: { silent: true },
    onSuccess: (res) => {
      if (!res.dryRun) void qc.invalidateQueries();
    },
  });
}

// ---------------------------------------------------------------------------------------------- events

export function useEvents(when: EventsWhen) {
  return useInfiniteQuery({
    queryKey: keys.events(when),
    queryFn: async ({ pageParam }) => normalizeEventsPage(await api.get<unknown>(`/events${qs({ when, cursor: pageParam })}`)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: retryOnce,
  });
}

export const useEvent = (id: string) =>
  useQuery({
    queryKey: keys.event(id),
    queryFn: async () => {
      const ev = normalizeOccasionDetail(await api.get<unknown>(`/events/${encodeURIComponent(id)}`));
      if (!ev) throw new ApiError(502, 'BAD_RESPONSE', 'The server sent an unexpected response.');
      return ev;
    },
    retry: retryOnce,
  });

// ---------------------------------------------------------------------------------------------- Google Calendar

/** Until the OAuth client exists every /google path answers 503 GOOGLE_NOT_CONFIGURED: that is a status, not an error. */
export const useGoogleStatus = () =>
  useQuery({
    queryKey: keys.google,
    queryFn: async () => {
      try {
        return normalizeGoogleStatus(await api.get<unknown>('/google/status'));
      } catch (e) {
        if (isApiError(e) && e.code === 'GOOGLE_NOT_CONFIGURED') return normalizeGoogleStatus({ configured: false });
        throw e;
      }
    },
    retry: retryOnce,
    staleTime: 60_000,
  });

const invalidateCalendar = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: keys.google });
  void qc.invalidateQueries({ queryKey: keys.sources });
  void qc.invalidateQueries({ queryKey: ['events'] });
};

/** Sets how each calendar counts (attending / candidate / classify / excluded). Read-only toward Google. */
export function useSetCalendarTreatments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (calendars: { id: string; treatment: string }[]) => api.post<unknown>('/google/calendars', { calendars }),
    meta: { silent: true },
    onSuccess: () => invalidateCalendar(qc),
  });
}

/** Disconnects Google; `deleteData` also deletes every synced calendar and event on the server. */
export function useGoogleDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: { deleteData?: boolean } = {}) => api.post<unknown>('/google/disconnect', o.deleteData ? { deleteData: true } : {}),
    meta: { silent: true },
    onSuccess: () => invalidateCalendar(qc),
  });
}
