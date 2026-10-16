/**
 * Settings queries and mutations: GET/PATCH /settings, digest preview / test send / history, push (VAPID, devices,
 * subscribe, test), the learner and the eval labels. Shapes: @yb/shared.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchRef,
  DigestHistory,
  DoNotMergeList,
  DigestPreview,
  DigestSendTest,
  DigestSendTestResult,
  EvalItemPage,
  EvalLabelInput,
  EvalLabelResult,
  EvalReport,
  EvalSet,
  LearnerReset,
  LearnerResetResult,
  LearnerState,
  LearnerUnmute,
  MyIdentities,
  OkResult,
  PushDevices,
  PushSubscribe,
  PushSubscribeResult,
  PushTest,
  PushTestResult,
  PushVapid,
  SettingsPatch,
  SettingsPatchResult,
  SettingsResponse,
} from '@yb/shared';
import { api, qs } from '../../api/client';
import type { PeoplePage } from '../../api/types';
import { retryOnce } from '../today/api';

export const settingsKeys = {
  settings: ['settings', 'values'] as const,
  preview: ['digest', 'preview'] as const,
  history: ['digest', 'history'] as const,
  vapid: ['push', 'vapid'] as const,
  devices: ['push', 'devices'] as const,
  learner: ['learner'] as const,
  evalItems: (set: EvalSet | null, status: string) => ['eval', 'items', set ?? 'all', status] as const,
  evalReport: ['eval', 'report'] as const,
  doNotMerge: ['settings', 'do-not-merge'] as const,
  myIdentities: ['settings', 'my-identities'] as const,
};

/** Settings → Privacy: pairs the agent will never merge, and "allow merging again" (journaled, undoable). */
export const useDoNotMerge = () => useQuery({ queryKey: settingsKeys.doNotMerge, queryFn: () => api.get<DoNotMergeList>('/settings/do-not-merge'), retry: retryOnce });

export function useAllowMerge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ a, b }: { a: string; b: string }) => api.del<BatchRef>(`/settings/do-not-merge/${encodeURIComponent(a)}/${encodeURIComponent(b)}`),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKeys.doNotMerge });
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

/** The owner's own accounts (masked). */
export const useMyIdentities = () => useQuery({ queryKey: settingsKeys.myIdentities, queryFn: () => api.get<MyIdentities>('/settings/my-identities'), retry: retryOnce });

/** Settings → Data: the JSON export (a plain download; the browser saves it, nothing is sent anywhere). */
export const EXPORT_URL = '/api/v1/settings/export';

export const useSettings = () =>
  useQuery({ queryKey: settingsKeys.settings, queryFn: () => api.get<SettingsResponse>('/settings'), retry: retryOnce });

/** One journaled batch per save. The new values come back in the answer; meta etc. are refetched. */
export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patch<SettingsPatchResult>('/settings', patch),
    meta: { silent: true },
    onSuccess: (r) => {
      qc.setQueryData<SettingsResponse>(settingsKeys.settings, (old) => (old ? { ...old, values: r.values } : old));
      void qc.invalidateQueries({ queryKey: settingsKeys.settings });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
      void qc.invalidateQueries({ queryKey: settingsKeys.vapid });
      void qc.invalidateQueries({ queryKey: settingsKeys.learner });
    },
  });
}

// ---------------------------------------------------------------------------------------------- digest

/** Fetched on demand (the Preview button): it may compose, so it isn't run on every visit. */
export const useDigestPreview = (enabled: boolean) =>
  useQuery({
    queryKey: settingsKeys.preview,
    queryFn: () => api.get<DigestPreview>('/digest/preview'),
    enabled,
    retry: retryOnce,
    staleTime: 60_000,
  });

export const useDigestHistory = () =>
  useQuery({ queryKey: settingsKeys.history, queryFn: () => api.get<DigestHistory>('/digest/history?limit=14'), retry: retryOnce });

/** Texts the owner's own handle only (the server has no other recipient). The UI always asks first. */
export function useDigestSendTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DigestSendTest) => api.post<DigestSendTestResult>('/digest/send-test', body),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.history }),
  });
}

// ---------------------------------------------------------------------------------------------- push

export const usePushVapid = () => useQuery({ queryKey: settingsKeys.vapid, queryFn: () => api.get<PushVapid>('/push/vapid'), retry: retryOnce });
export const usePushDevices = () => useQuery({ queryKey: settingsKeys.devices, queryFn: () => api.get<PushDevices>('/push/devices'), retry: retryOnce });

export function usePushSubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PushSubscribe) => api.post<PushSubscribeResult>('/push/subscribe', body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKeys.devices });
      void qc.invalidateQueries({ queryKey: settingsKeys.vapid });
      void qc.invalidateQueries({ queryKey: settingsKeys.settings });
    },
  });
}

export function usePushUnsubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (endpoint: string) => api.post<OkResult>('/push/unsubscribe', { endpoint }),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.devices }),
  });
}

export function usePushTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PushTest) => api.post<PushTestResult>('/push/test', body),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.devices }),
  });
}

// ---------------------------------------------------------------------------------------------- learner

export const useLearner = () => useQuery({ queryKey: settingsKeys.learner, queryFn: () => api.get<LearnerState>('/learner'), retry: retryOnce });

export function useLearnerReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LearnerReset) => api.post<LearnerResetResult>('/learner/reset', body),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.learner }),
  });
}

export function useLearnerUnmute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LearnerUnmute) => api.post<OkResult>('/learner/unmute', body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKeys.learner });
      void qc.invalidateQueries({ queryKey: settingsKeys.settings });
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

// ---------------------------------------------------------------------------------------------- eval

export function useEvalItems(set: EvalSet | null, status: 'unlabeled' | 'labeled' | 'all') {
  return useInfiniteQuery({
    queryKey: settingsKeys.evalItems(set, status),
    queryFn: ({ pageParam }) => api.get<EvalItemPage>(`/eval/items${qs({ set, status, cursor: pageParam, limit: 10 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: retryOnce,
  });
}

export function useEvalLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvalLabelInput) => api.post<EvalLabelResult>('/eval/labels', body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['eval'] });
    },
  });
}

export const useEvalReport = (enabled: boolean) =>
  useQuery({ queryKey: settingsKeys.evalReport, queryFn: () => api.get<EvalReport>('/eval/report'), enabled, retry: retryOnce });

// ---------------------------------------------------------------------------------------------- people picker

/** Name search for pickers (exclusions, eval expected people). Visible people only (the server's person_visible). */
export const usePeopleSearch = (q: string) =>
  useQuery({
    queryKey: ['people', 'search', q.trim()],
    queryFn: () => api.get<PeoplePage>(`/people${qs({ q: q.trim(), sort: 'last', limit: 8 })}`),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    retry: retryOnce,
  });
