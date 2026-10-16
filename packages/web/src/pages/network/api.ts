import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { NetworkGraph } from '@yb/shared';
import { api } from '../../api/client';
import { retryOnce } from '../person/api';
import { networkQuery, type NetworkFilters } from './logic';

/** GET /network for the current filters; the previous graph stays on screen while a filter change loads. */
export function useNetwork(f: NetworkFilters) {
  const query = networkQuery(f);
  return useQuery({
    queryKey: ['network', query],
    queryFn: () => api.get<NetworkGraph>(`/network${query}`),
    placeholderData: keepPreviousData,
    retry: retryOnce,
    staleTime: 5 * 60_000,
  });
}
