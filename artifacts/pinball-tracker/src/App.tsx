import { useEffect } from 'react';
import { Switch, Route, Redirect, useLocation, useSearch } from 'wouter';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './lib/useApi';
import { ScopeProvider } from './lib/ScopeContext';
import { isGuestMode } from './lib/guestMode';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import MachinesPage from './pages/MachinesPage';
import MachinePage from './pages/MachinePage';
import VenuesPage from './pages/VenuesPage';
import VenuePage from './pages/VenuePage';
import StatsPage from './pages/StatsPage';
import CrewPage from './pages/CrewPage';
import NotificationsPage from './pages/NotificationsPage';
import NewChallengePage from './pages/NewChallengePage';
import ChallengePage from './pages/ChallengePage';
import AddScorePage from './pages/AddScorePage';
import SetupPage from './pages/SetupPage';
import UserPage from './pages/UserPage';
import SignInPage from './pages/SignInPage';
import SignUpPage from './pages/SignUpPage';
import WelcomePage from './pages/WelcomePage';
import NotFoundPage from './pages/NotFoundPage';
import AdminPage from './pages/AdminPage';
import AdminHealthPage from './pages/AdminHealthPage';
import AdminConfigPage from './pages/AdminConfigPage';
import AdminStatsPage from './pages/AdminStatsPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminUserPage from './pages/AdminUserPage';
import AdminActivityPage from './pages/AdminActivityPage';
import AdminSocialPage from './pages/AdminSocialPage';
import AdminScoresPage from './pages/AdminScoresPage';

/**
 * The Map page is now the Venues page's Map view. Old links (bookmarks, shared URLs) keep working,
 * including the `?venueId=` filter the venue page's map thumbnail used to send.
 */
function MapRedirect() {
  const params = new URLSearchParams(useSearch());
  const venueId = params.get('venueId');
  return <Redirect replace to={`/venues?view=map${venueId ? `&venueId=${encodeURIComponent(venueId)}` : ''}`} />;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const [, navigate] = useLocation();

  const { data: appUser, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });

  useEffect(() => {
    if (!isLoaded || isLoading) return;
    if (!isSignedIn) { navigate('/sign-in'); return; }
    if (appUser === null) navigate('/setup');
  }, [isLoaded, isSignedIn, appUser, isLoading]);

  if (!isLoaded || isLoading) return null;
  return <>{children}</>;
}

function AccessGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const [location, navigate] = useLocation();
  const isPublicAuthRoute = location.startsWith('/sign-in') || location.startsWith('/sign-up') || location === '/welcome';
  const hasAccess = isSignedIn || isGuestMode();

  useEffect(() => {
    if (!isLoaded || isPublicAuthRoute || hasAccess) return;
    navigate('/welcome');
  }, [isLoaded, isPublicAuthRoute, hasAccess]);

  if (!isLoaded) return null;
  if (!isPublicAuthRoute && !hasAccess) return null;
  return <>{children}</>;
}

function AdminGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const [, navigate] = useLocation();

  const { data: appUser, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });

  useEffect(() => {
    if (!isLoaded || isLoading) return;
    if (!isSignedIn) { navigate('/sign-in'); return; }
    if (appUser === null) { navigate('/setup'); return; }
    if (appUser.role !== 'admin') navigate('/');
  }, [isLoaded, isSignedIn, appUser, isLoading]);

  // Render nothing until we know it's an admin, so admin pages never fire requests for anyone else
  // (the server refuses them anyway).
  if (!isLoaded || isLoading || !isSignedIn || appUser?.role !== 'admin') return null;
  return <>{children}</>;
}

export default function App() {
  return (
    <ScopeProvider>
    <Layout>
      <AccessGate>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/machines" component={MachinesPage} />
        <Route path="/machines/:name" component={MachinePage} />
        <Route path="/venues/:id" component={VenuePage} />
        <Route path="/venues" component={VenuesPage} />
        <Route path="/map" component={MapRedirect} />
        <Route path="/stats">
          <AuthGate><StatsPage /></AuthGate>
        </Route>
        <Route path="/crew">
          <AuthGate><CrewPage /></AuthGate>
        </Route>
        {/* Friends and Pods are tabs of Crew now; notifications and scope links still use these. */}
        <Route path="/friends"><Redirect replace to="/crew?tab=friends" /></Route>
        <Route path="/pods"><Redirect replace to="/crew?tab=pods" /></Route>
        {/* Challenges live under Crew; /challenges itself is the Crew tab. */}
        <Route path="/challenges"><Redirect replace to="/crew?tab=challenges" /></Route>
        <Route path="/challenges/new">
          <AuthGate><NewChallengePage /></AuthGate>
        </Route>
        <Route path="/challenges/:id">
          <AuthGate><ChallengePage /></AuthGate>
        </Route>
        <Route path="/notifications">
          <AuthGate><NotificationsPage /></AuthGate>
        </Route>
        <Route path="/add">
          <AuthGate><AddScorePage /></AuthGate>
        </Route>
        <Route path="/setup" component={SetupPage} />
        <Route path="/users/:username" component={UserPage} />
        <Route path="/welcome" component={WelcomePage} />
        <Route path="/sign-in" component={SignInPage} />
        <Route path="/sign-in/*" component={SignInPage} />
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/sign-up/*" component={SignUpPage} />
        <Route path="/admin">
          <AdminGate><AdminPage /></AdminGate>
        </Route>
        <Route path="/admin/users">
          <AdminGate><AdminUsersPage /></AdminGate>
        </Route>
        <Route path="/admin/users/:id">
          <AdminGate><AdminUserPage /></AdminGate>
        </Route>
        <Route path="/admin/activity">
          <AdminGate><AdminActivityPage /></AdminGate>
        </Route>
        <Route path="/admin/crew">
          <AdminGate><AdminSocialPage /></AdminGate>
        </Route>
        <Route path="/admin/scores">
          <AdminGate><AdminScoresPage /></AdminGate>
        </Route>
        <Route path="/admin/health">
          <AdminGate><AdminHealthPage /></AdminGate>
        </Route>
        <Route path="/admin/config">
          <AdminGate><AdminConfigPage /></AdminGate>
        </Route>
        <Route path="/admin/stats">
          <AdminGate><AdminStatsPage /></AdminGate>
        </Route>
        <Route component={NotFoundPage} />
      </Switch>
      </AccessGate>
    </Layout>
    </ScopeProvider>
  );
}
