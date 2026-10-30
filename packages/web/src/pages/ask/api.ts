import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AskConversation, AskConversationList, SettingsResponse } from '@yb/shared';
import { api, qs, reloginOnce } from '../../api/client';
import { retryOnce } from '../person/api';
import { AskStore } from './store';

export const askKeys = {
  all: ['ask'] as const,
  list: ['ask', 'conversations'] as const,
  conversation: (id: string) => ['ask', 'conversation', id] as const,
};

/** Recent questions per page on the empty Ask screen ("Show older" loads the next). */
export const RECENT_PAGE = 5;

export const useConversations = () =>
  useInfiniteQuery({
    queryKey: askKeys.list,
    queryFn: ({ pageParam }) => api.get<AskConversationList>(`/ask/conversations${qs({ cursor: pageParam, limit: RECENT_PAGE })}`),
    initialPageParam: null as string | null,
    // An older server sends no nextCursor: one page.
    getNextPageParam: (last) => last.nextCursor ?? null,
    retry: retryOnce,
    staleTime: 30_000,
  });

export const useConversation = (id: string | null) =>
  useQuery({
    queryKey: askKeys.conversation(id ?? ''),
    queryFn: () => api.get<AskConversation>(`/ask/conversations/${encodeURIComponent(id!)}`),
    enabled: !!id,
    retry: retryOnce,
  });

/** Whether the server has an Anthropic key (Settings → environment). Null when unknown. */
export function useLlmConfigured(): boolean | null {
  const q = useQuery({ queryKey: ['settings', 'for-ask'], queryFn: () => api.get<SettingsResponse>('/settings'), retry: retryOnce, staleTime: 5 * 60_000 });
  if (!q.data) return null;
  return q.data.environment.llmConfigured && q.data.values['llm.enabled'] !== false;
}

const sessionStore = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

let store: AskStore | null = null;

/** The app-wide live Ask store (one per tab). */
export function askStore(): AskStore {
  store ??= new AskStore({
    env: {
      fetch: (input, init) => globalThis.fetch(input, init),
      relogin: () => void reloginOnce(window.location, sessionStore()),
    },
  });
  return store;
}
