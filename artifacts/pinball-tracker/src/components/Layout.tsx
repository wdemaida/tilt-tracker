import { useLocation } from 'wouter';
import Header from './Header';
import MobileTabBar, { hidesTabBar } from './MobileTabBar';
import DisabledAccountNotice from './DisabledAccountNotice';
import { useAppUser } from '../lib/useAppUser';

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  // An admin-disabled account sees one clear message instead of pages that would all 403.
  const appUser = useAppUser();

  if (location === '/welcome') {
    return <div className="min-h-screen w-full bg-background relative overflow-x-clip">{children}</div>;
  }

  // Below md the fixed tab bar (h-16 + the iPhone home-indicator inset) sits over the bottom of the
  // page; reserve that much extra padding so the last button or pagination row stays reachable.
  const tabBarPadding = hidesTabBar(location) ? '' : 'pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8';

  return (
    <div className="min-h-screen flex flex-col w-full bg-background relative overflow-x-clip">
      <Header />
      <main className={`flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 ${tabBarPadding}`}>
        {appUser?.disabledAt ? <DisabledAccountNotice reason={appUser.disabledReason} /> : children}
      </main>
      <MobileTabBar />
    </div>
  );
}
