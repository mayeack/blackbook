/**
 * Event brief + trips queries (GET /events/:id/brief, GET /trips; DTOs in @yb/shared api/intel.ts). Read-only:
 * nothing on these screens writes or sends anything.
 */
import { useQuery } from '@tanstack/react-query';
import type { EventBrief, TripsQuery, TripsResponse } from '@yb/shared';
import { api, isApiError } from '../../api/client';

/** One retry for flaky networks; never for 4xx. */
const retryOnce = (count: number, e: unknown) => count < 1 && !(isApiError(e) && e.status >= 400 && e.status < 500);

export const useBrief = (id: string) =>
  useQuery({
    queryKey: ['brief', id],
    queryFn: () => api.get<EventBrief>(`/events/${encodeURIComponent(id)}/brief`),
    enabled: !!id,
    retry: retryOnce,
  });

export const useTrips = (when: TripsQuery['when']) =>
  useQuery({
    queryKey: ['trips', when],
    queryFn: () => api.get<TripsResponse>(`/trips?when=${when}`),
    retry: retryOnce,
  });
