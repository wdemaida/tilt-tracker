import { useEffect } from 'react';
import { Switch, Route, useLocation } from 'wouter';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './lib/useApi';
import { ScopeProvider } from './lib/ScopeContext';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import MachinesPage from './pages/MachinesPage';
import MachinePage from './pages/MachinePage';
import MapPage from './pages/MapPage';
import VenuesPage from './pages/VenuesPage';
import StatsPage from './pages/StatsPage';
import AddScorePage from './pages/AddScorePage';
import SetupPage from './pages/SetupPage';
import UserPage from './pages/UserPage';
import SignInPage from './pages/SignInPage';
import SignUpPage from './pages/SignUpPage';
import NotFoundPage from './pages/NotFoundPage';
import AdminPage from './pages/AdminPage';
import AdminHealthPage from './pages/AdminHealthPage';

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

  if (!isLoaded || isLoading) return null;
  return <>{children}</>;
}

export default function App() {
  return (
    <ScopeProvider>
    <Layout>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/machines" component={MachinesPage} />
        <Route path="/machines/:name" component={MachinePage} />
        <Route path="/venues" component={VenuesPage} />
        <Route path="/map" component={MapPage} />
        <Route path="/stats">
          <AuthGate><StatsPage /></AuthGate>
        </Route>
        <Route path="/add">
          <AuthGate><AddScorePage /></AuthGate>
        </Route>
        <Route path="/setup" component={SetupPage} />
        <Route path="/users/:username" component={UserPage} />
        <Route path="/sign-in" component={SignInPage} />
        <Route path="/sign-in/*" component={SignInPage} />
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/sign-up/*" component={SignUpPage} />
        <Route path="/admin">
          <AdminGate><AdminPage /></AdminGate>
        </Route>
        <Route path="/admin/health">
          <AdminGate><AdminHealthPage /></AdminGate>
        </Route>
        <Route component={NotFoundPage} />
      </Switch>
    </Layout>
    </ScopeProvider>
  );
}
