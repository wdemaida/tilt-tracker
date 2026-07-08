import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'wouter';
import { User, MapPin, Clock, Home } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';

export default function UserPage() {
  const { username } = useParams<{ username: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['user', username],
    queryFn: () => api.users.get(username),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">User not found.</p>;

  const { user, scores } = data;

  return (
    <div>
      <div className="flex items-center gap-4 mb-8">
        <div className="w-14 h-14 rounded-full bg-card border border-white/10 flex items-center justify-center">
          <User className="w-7 h-7 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-3xl font-black uppercase tracking-widest text-white">{user.displayName}</h1>
          <p className="text-sm text-muted-foreground">@{user.username} · {scores.length} scores</p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {scores.map((s: any) => (
          <div key={s.id} className="flex items-center gap-4 rounded-xl border border-white/10 bg-card p-4">
            <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 border border-white/10 bg-white/5">
              {s.machineImageUrl ? (
                <img src={s.machineImageUrl} alt={s.machineName} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-bold text-center leading-tight p-1">
                  {s.machineName.split(' ').slice(0, 2).join('\n')}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground border border-white/10 rounded px-1.5 py-0.5">
                  {s.type}
                </span>
                <Link href={`/machines/${encodeURIComponent(s.machineName)}`} className="text-sm font-bold uppercase tracking-wider text-machine hover:text-machine/80 transition-colors truncate">
                  {s.machineName}
                </Link>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{format(new Date(s.playedAt), 'MMM d, yyyy · h:mm a')}</span>
                {s.venueName && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.venueName}{s.venueIsResidence && <Home className="w-3 h-3" />}</span>}
              </div>
            </div>
            <p className="text-xl font-black text-primary flex-shrink-0">{Number(s.score).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
