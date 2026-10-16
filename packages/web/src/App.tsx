import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { isApiError } from './api/client';
import { AppShell } from './components/AppShell';
import { ToastProvider, useToast } from './components/Toast';
import { EventPage } from './pages/events/EventPage';
import { EventsPage } from './pages/events/EventsPage';
import { MorePage, NotFoundPage, Placeholder, SettingsPage } from './pages/MorePages';
import { PeoplePage } from './pages/PeoplePage';
import { PersonPage } from './pages/person/PersonPage';
import { SourcesPage } from './pages/SourcesPage';
import { TodayPage } from './pages/TodayPage';

function Providers({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Never retry auth/validation failures; one retry for flaky networks.
            retry: (count, e) => count < 1 && !(isApiError(e) && e.status >= 400 && e.status < 500),
            refetchOnWindowFocus: true,
          },
          mutations: { retry: 0 },
        },
        mutationCache: new MutationCache({
          onError: (error, _vars, _ctx, mutation) => {
            if (mutation.meta?.silent) return;
            toast((error as Error).message || 'Could not save.', 'error');
          },
        }),
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** New screen, top of page (the window scrolls, not an inner box). */
function ScrollToTop() {
  const { pathname } = useLocation();
  // A block body: newer browsers return a Promise from scrollTo, which React would call as the effect's cleanup.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <ToastProvider>
      <Providers>
        <BrowserRouter>
          <ScrollToTop />
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/people" element={<PeoplePage />} />
              <Route path="/p/:id" element={<PersonPage />} />
              <Route path="/ask" element={<Placeholder title="Ask">Ask questions about your network — “who do I know in Austin?” — with cited answers.</Placeholder>} />
              <Route path="/network" element={<Placeholder title="Network">An interactive map of who knows whom, colored by circle.</Placeholder>} />
              <Route path="/circles" element={<Placeholder title="Circles">Auto circles from group chats and events, plus your tags and places.</Placeholder>} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/e/:id" element={<EventPage />} />
              <Route path="/sources" element={<SourcesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/more" element={<MorePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </Providers>
    </ToastProvider>
  );
}
