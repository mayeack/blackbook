import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { isApiError } from './api/client';
import { AppShell } from './components/AppShell';
import { ToastProvider, useToast } from './components/Toast';
import { AskPage } from './pages/AskPage';
import { CirclesPage } from './pages/circles/CirclesPage';
import { CollectionPage } from './pages/circles/CollectionPage';
import { EvalPage } from './pages/EvalPage';
import { BriefPage } from './pages/events/BriefPage';
import { EventPage } from './pages/events/EventPage';
import { EventsPage } from './pages/events/EventsPage';
import { TicketsPage } from './pages/events/TicketsPage';
import { MorePage, NotFoundPage } from './pages/MorePages';
import { NetworkPage } from './pages/NetworkPage';
import { PairPage } from './pages/PairPage';
import { PeoplePage } from './pages/PeoplePage';
import { PersonPage } from './pages/person/PersonPage';
import { AgentSettingsPage } from './pages/settings/AgentSettingsPage';
import { DigestSettingsPage } from './pages/settings/DigestSettingsPage';
import { LearnedPage } from './pages/settings/LearnedPage';
import { PrivacySettingsPage } from './pages/settings/PrivacySettingsPage';
import { PushSettingsPage } from './pages/settings/PushSettingsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SourcesPage } from './pages/SourcesPage';
import { TodayPage } from './pages/TodayPage';
import { TripsPage } from './pages/TripsPage';

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
              <Route path="/p/:a/with/:b" element={<PairPage />} />
              <Route path="/ask" element={<AskPage />} />
              <Route path="/ask/:conversationId" element={<AskPage />} />
              <Route path="/network" element={<NetworkPage />} />
              <Route path="/circles" element={<CirclesPage />} />
              <Route path="/c/:id" element={<CollectionPage type="circle" />} />
              <Route path="/tags/:id" element={<CollectionPage type="tag" />} />
              <Route path="/locations/:id" element={<CollectionPage type="location" />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/e/:id" element={<EventPage />} />
              <Route path="/e/:id/brief" element={<BriefPage />} />
              <Route path="/trips" element={<TripsPage />} />
              <Route path="/tickets" element={<TicketsPage />} />
              <Route path="/sources" element={<SourcesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/digest" element={<DigestSettingsPage />} />
              <Route path="/settings/push" element={<PushSettingsPage />} />
              <Route path="/settings/agent" element={<AgentSettingsPage />} />
              <Route path="/settings/privacy" element={<PrivacySettingsPage />} />
              <Route path="/settings/learned" element={<LearnedPage />} />
              <Route path="/settings/eval" element={<EvalPage />} />
              <Route path="/eval" element={<Navigate to="/settings/eval" replace />} />
              <Route path="/more" element={<MorePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </Providers>
    </ToastProvider>
  );
}
