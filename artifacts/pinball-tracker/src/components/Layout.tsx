import { useLocation } from 'wouter';
import Header from './Header';

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  if (location === '/welcome') {
    return <div className="min-h-screen w-full bg-background relative overflow-x-clip">{children}</div>;
  }

  return (
    <div className="min-h-screen flex flex-col w-full bg-background relative overflow-x-clip">
      <Header />
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
