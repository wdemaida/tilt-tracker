import { useUser } from '@clerk/clerk-react';
import { useScopeContext } from '../lib/ScopeContext';

export function ScopeToggle() {
  const { isSignedIn } = useUser();
  const { mine, setMine } = useScopeContext();

  if (!isSignedIn) return null;

  return (
    <div className="flex gap-0.5 p-1 rounded-lg bg-white/5 border border-white/10">
      {([false, true] as const).map(v => (
        <button
          key={String(v)}
          onClick={() => setMine(v)}
          className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-colors ${
            mine === v ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'
          }`}
        >
          {v ? 'Mine' : 'All'}
        </button>
      ))}
    </div>
  );
}
