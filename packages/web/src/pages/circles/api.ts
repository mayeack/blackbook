/**
 * Circles / Tags / Locations (routes/circles.ts). Writes are the owner's, journaled and undoable from Today; the
 * agent maintains auto circles but never deletes one or touches the owner's own collections.
 * Keys start with ['collections'] so any membership change refreshes lists and details together.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchRef,
  CollectionCreate,
  CollectionDetail,
  CollectionList,
  CollectionType,
  CollectionUpdate,
  CollectionWriteResult,
} from '@yb/shared';
import { api, qs } from '../../api/client';
import { retryOnce } from '../person/api';
import { collectionApiPath } from './logic';

export const collectionKeys = {
  all: ['collections'] as const,
  list: (type: CollectionType) => ['collections', type, 'list'] as const,
  detail: (type: CollectionType, id: string) => ['collections', type, 'detail', id] as const,
};

export const useCollections = (type: CollectionType, enabled = true) =>
  useQuery({
    queryKey: collectionKeys.list(type),
    queryFn: () => api.get<CollectionList>(`${collectionApiPath(type)}${qs({ kind: type === 'circle' ? 'all' : undefined })}`),
    retry: retryOnce,
    enabled,
  });

export const useCollection = (type: CollectionType, id: string, enabled = true) =>
  useQuery({
    queryKey: collectionKeys.detail(type, id),
    queryFn: () => api.get<CollectionDetail>(`${collectionApiPath(type)}/${encodeURIComponent(id)}`),
    retry: retryOnce,
    enabled: enabled && !!id,
  });

const refresh = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: collectionKeys.all });
  void qc.invalidateQueries({ queryKey: ['person'] });
  void qc.invalidateQueries({ queryKey: ['network'] });
  void qc.invalidateQueries({ queryKey: ['activity'] });
};

export function useCreateCollection(type: CollectionType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CollectionCreate> & { name: string }) => api.post<CollectionWriteResult>(collectionApiPath(type), { memberIds: [], ...body }),
    meta: { silent: true },
    onSuccess: () => refresh(qc),
  });
}

export function useUpdateCollection(type: CollectionType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: CollectionUpdate) => api.patch<BatchRef>(`${collectionApiPath(type)}/${encodeURIComponent(id)}`, patch),
    meta: { silent: true },
    onSuccess: () => refresh(qc),
  });
}

export function useEditMembers(type: CollectionType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edit: { add?: string[]; remove?: string[] }) =>
      api.post<BatchRef>(`${collectionApiPath(type)}/${encodeURIComponent(id)}/members`, { add: edit.add ?? [], remove: edit.remove ?? [] }),
    meta: { silent: true },
    onSuccess: () => refresh(qc),
  });
}

export function useDeleteCollection(type: CollectionType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<BatchRef>(`${collectionApiPath(type)}/${encodeURIComponent(id)}`),
    meta: { silent: true },
    onSuccess: () => refresh(qc),
  });
}
