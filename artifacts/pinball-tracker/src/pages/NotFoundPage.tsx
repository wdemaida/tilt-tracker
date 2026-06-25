import { Link } from 'wouter';

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <h1 className="text-6xl font-black text-primary">404</h1>
      <p className="text-xl font-bold uppercase tracking-widest text-white">Page Not Found</p>
      <Link href="/" className="text-sm text-muted-foreground hover:text-white transition-colors">
        ← Back to scores
      </Link>
    </div>
  );
}
