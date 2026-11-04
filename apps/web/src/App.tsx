import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';

// The marketing pages are a few KB each and share one layout, so splitting them
// only bought a round trip the preload scanner could not see — i.e. a visible
// "Loading…" on the landing page. They ship in the entry chunk instead.
import { GroupSkeleton } from './components/GroupSkeleton';
import { PageLoading } from './components/PageLoading';
import { BrowsePage } from './pages/BrowsePage';
import { GetStartedPage } from './pages/GetStartedPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { LEGAL_PAGES } from './lib/legalIndex';

// These three are worth splitting: they pull in GroupMapShell (~385 KB) and
// GraphsPanel (~366 KB), neither of which a first-time visitor needs.
const DemoPage = lazy(() =>
  import('./pages/DemoPage').then((m) => ({ default: m.DemoPage })),
);
const GroupPage = lazy(() =>
  import('./pages/GroupPage').then((m) => ({ default: m.GroupPage })),
);
const PublicGroupPage = lazy(() =>
  import('./pages/PublicGroupPage').then((m) => ({
    default: m.PublicGroupPage,
  })),
);

// Split for the same reason: the three policies are ~30 KB of prose that a
// first-time visitor has no use for. Only their titles ship eagerly, in
// lib/legalIndex, so the footer and routes cost nothing.
const LegalPage = lazy(() =>
  import('./pages/LegalPage').then((m) => ({ default: m.LegalPage })),
);

// Operator-only, reached by typing the path, so it must never ride in the entry
// chunk that every visitor downloads.
const AdminPage = lazy(() =>
  import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })),
);

const MembersPage = lazy(() =>
  import('./pages/MembersPage').then((m) => ({ default: m.MembersPage })),
);

const FALLBACK = <GroupSkeleton />;

const PUBLIC_GROUP_FALLBACK = <PageLoading />;

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={FALLBACK}>
        <Routes>
          <Route index element={<HomePage />} />
          <Route path="get-started" element={<GetStartedPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="discover" element={<BrowsePage />} />
          {LEGAL_PAGES.map((page) => (
            <Route
              key={page.slug}
              path={page.slug}
              element={<LegalPage slug={page.slug} />}
            />
          ))}
          <Route path="admin" element={<AdminPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="verify" element={<Navigate to="/members" replace />} />
          <Route path="demo" element={<DemoPage />} />
          <Route path="group" element={<GroupPage />} />
          {/* Somebody else's public group: the name is in the path because the
              shell owns the query string. */}
          <Route
            path="g/:groupName"
            element={
              <Suspense fallback={PUBLIC_GROUP_FALLBACK}>
                <PublicGroupPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Analytics />
    </BrowserRouter>
  );
}
