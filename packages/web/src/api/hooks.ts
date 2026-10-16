import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './client';
import type {
  ActivityPage,
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
};

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

export function useTimeline(id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.timeline(id),
    queryFn: ({ pageParam }) => api.get<TimelinePage>(`/people/${encodeURIComponent(id)}/timeline${qs({ cursor: pageParam, limit: 30 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
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
