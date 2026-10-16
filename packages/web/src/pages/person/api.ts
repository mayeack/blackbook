/**
 * Person page extensions (routes/personExtras.ts): tie stats, facts (+ Wrong), open loops (+ Done), starters,
 * connections (+ Wrong), notes CRUD, merge history (+ Split), collection membership, and the pair page. Paths and
 * shapes: AGENT_ROUTES / @yb/shared. A route that hasn't landed answers 501 (`isNotImplemented`): never retried,
 * and each section shows "not available yet" on its own instead of failing the page.
 *
 * Every key starts with ['person', id] so invalidating the person refreshes all of it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchRef,
  CollectionMembershipEdit,
  Connections,
  ConnectionWrong,
  LoopAction,
  MergeHistory,
  NoteList,
  NoteWriteResult,
  OpenLoopList,
  OpenLoopType,
  PairView,
  PersonCollections,
  PersonFacts,
  Starters,
  TieStats,
} from '@yb/shared';
import { api, isApiError } from '../../api/client';

const enc = encodeURIComponent;

export const personKeys = {
  all: (id: string) => ['person', id] as const,
  ties: (id: string) => ['person', id, 'ties'] as const,
  facts: (id: string) => ['person', id, 'facts'] as const,
  loops: (id: string) => ['person', id, 'loops'] as const,
  starters: (id: string) => ['person', id, 'starters'] as const,
  connections: (id: string) => ['person', id, 'connections'] as const,
  notes: (id: string) => ['person', id, 'notes'] as const,
  merges: (id: string) => ['person', id, 'merges'] as const,
  collections: (id: string) => ['person', id, 'collections'] as const,
  pair: (a: string, b: string) => ['pair', a, b] as const,
};

/** One retry for flaky networks; never for 4xx or 501 (not built yet). */
export const retryOnce = (count: number, e: unknown) => count < 1 && !(isApiError(e) && (e.status === 501 || (e.status >= 400 && e.status < 500)));

const get = <T,>(path: string) => () => api.get<T>(path);

export const useTies = (id: string) =>
  useQuery({ queryKey: personKeys.ties(id), queryFn: get<TieStats>(`/people/${enc(id)}/ties`), retry: retryOnce, enabled: !!id });

export const useFacts = (id: string) =>
  useQuery({ queryKey: personKeys.facts(id), queryFn: get<PersonFacts>(`/people/${enc(id)}/facts`), retry: retryOnce, enabled: !!id });

export const usePersonLoops = (id: string) =>
  useQuery({ queryKey: personKeys.loops(id), queryFn: get<OpenLoopList>(`/people/${enc(id)}/loops`), retry: retryOnce, enabled: !!id });

export const useStarters = (id: string) =>
  useQuery({
    queryKey: personKeys.starters(id),
    queryFn: get<Starters>(`/people/${enc(id)}/starters`),
    retry: retryOnce,
    enabled: !!id,
    staleTime: 10 * 60_000,
  });

export const useConnections = (id: string, enabled = true) =>
  useQuery({
    queryKey: personKeys.connections(id),
    queryFn: get<Connections>(`/people/${enc(id)}/connections`),
    retry: retryOnce,
    enabled: !!id && enabled,
  });

export const useNotes = (id: string) =>
  useQuery({ queryKey: personKeys.notes(id), queryFn: get<NoteList>(`/people/${enc(id)}/notes`), retry: retryOnce, enabled: !!id });

export const useMerges = (id: string) =>
  useQuery({ queryKey: personKeys.merges(id), queryFn: get<MergeHistory>(`/people/${enc(id)}/merges`), retry: retryOnce, enabled: !!id });

export const usePersonCollections = (id: string) =>
  useQuery({
    queryKey: personKeys.collections(id),
    queryFn: get<PersonCollections>(`/people/${enc(id)}/collections`),
    retry: retryOnce,
    enabled: !!id,
  });

export const usePair = (a: string, b: string) =>
  useQuery({ queryKey: personKeys.pair(a, b), queryFn: get<PairView>(`/people/${enc(a)}/with/${enc(b)}`), retry: retryOnce, enabled: !!a && !!b });

/** Anything journaled shows up in Today's "What the agent did" (and its Undo). */
const touchActivity = (qc: ReturnType<typeof useQueryClient>) => void qc.invalidateQueries({ queryKey: ['activity'] });

/** Done / snooze / dismiss / wrong on a reply debt or promise. Also refreshes Today's strip. */
export function useLoopAction(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, body }: { type: OpenLoopType; id: string; body: LoopAction }) =>
      api.post<BatchRef>(`/loops/${enc(type)}/${enc(id)}`, body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.loops(personId) });
      void qc.invalidateQueries({ queryKey: ['loops'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
      touchActivity(qc);
    },
  });
}

/** Retracts a fact and blocks it from coming back. */
export function useFactWrong(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ factId, note }: { factId: string; note?: string }) =>
      api.post<BatchRef>(`/people/${enc(personId)}/facts/${enc(factId)}/wrong`, note ? { note } : {}),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.facts(personId) });
      void qc.invalidateQueries({ queryKey: personKeys.starters(personId) });
      touchActivity(qc);
    },
  });
}

/** Retracts one evidence type (or the relation label) between two people. */
export function useConnectionWrong(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ otherId, body }: { otherId: string; body: ConnectionWrong }) =>
      api.post<BatchRef>(`/people/${enc(personId)}/connections/${enc(otherId)}/wrong`, body),
    meta: { silent: true },
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: personKeys.connections(personId) });
      void qc.invalidateQueries({ queryKey: personKeys.connections(v.otherId) });
      void qc.invalidateQueries({ queryKey: ['pair'] });
      void qc.invalidateQueries({ queryKey: ['network'] });
      touchActivity(qc);
    },
  });
}

export function useNoteCreate(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.post<NoteWriteResult>(`/people/${enc(personId)}/notes`, { content }),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.notes(personId) });
      touchActivity(qc);
    },
  });
}

export function useNoteUpdate(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, content }: { noteId: string; content: string }) => api.patch<NoteWriteResult>(`/notes/${enc(noteId)}`, { content }),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.notes(personId) });
      touchActivity(qc);
    },
  });
}

export function useNoteDelete(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => api.del<BatchRef>(`/notes/${enc(noteId)}`),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.notes(personId) });
      touchActivity(qc);
    },
  });
}

/** Split undoes a merge and records do-not-merge; identities and history can move, so everything is refetched. */
export function useSplit(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeId: string) => api.post<BatchRef>(`/people/${enc(personId)}/merges/${enc(mergeId)}/split`),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries(),
  });
}

/** Add (by id, or create-and-add by name) / remove circles, tags and places for this person. */
export function useEditPersonCollections(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edit: Partial<CollectionMembershipEdit>) =>
      api.post<BatchRef>(`/people/${enc(personId)}/collections`, { add: edit.add ?? [], remove: edit.remove ?? [] }),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: personKeys.all(personId) });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      void qc.invalidateQueries({ queryKey: ['network'] });
      touchActivity(qc);
    },
  });
}
