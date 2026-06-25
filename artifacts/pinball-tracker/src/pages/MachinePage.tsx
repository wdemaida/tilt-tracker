import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { Trophy, ArrowLeft, MapPin, PlusCircle } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';

export default function MachinePage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);
  const { data, isLoading } = useQuery({
    queryKey: ['machine', decodedName],
    queryFn: () => api.machines.get(decodedName),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Machine not found.</p>;

  const { machine, scores } = data;
  const best = scores.reduce((a: any, b: any) => (b.score > a.score ? b : a), scores[0]);

  return (
    <div>
      <Link href="/machines" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> All Machines
      </Link>

      {/* Header with optional backglass image */}
      <div className="flex items-start gap-5 mb-6">
        {machine.imageUrl && (
          <img
            src={machine.imageUrl}
            alt={machine.name}
            className="w-24 h-24 rounded-xl object-cover border border-white/10 flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-black uppercase tracking-widest text-white leading-tight">{machine.name}</h1>
              {(machine.manufacturer || machine.year) && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {[machine.manufacturer, machine.year].filter(Boolean).join(' · ')}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-1">{scores.length} scores recorded</p>
            </div>
            <Link
              href="/add"
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary text-primary text-sm font-bold uppercase tracking-wider hover:bg-primary hover:text-white transition-colors flex-shrink-0"
            >
              <PlusCircle className="w-4 h-4" /> Add Score
            </Link>
          </div>
        </div>
      </div>

      {best && (
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-5 flex items-center gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/50">
            <Trophy className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Personal Best</p>
            <p className="text-3xl font-black text-primary">{Number(best.score).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">
              {format(new Date(best.playedAt), 'MMM d, yyyy')}
              {best.venueName && ` · ${best.venueName}`}
            </p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <th className="text-left px-5 py-3">Date & Venue</th>
              <th className="text-left px-3 py-3">Type</th>
              <th className="text-right px-5 py-3">Score</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((s: any) => (
              <tr key={s.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div>
                      <p className="font-semibold text-white">
                        {format(new Date(s.playedAt), 'MMM d, yyyy')}
                        <span className="text-muted-foreground ml-2">{format(new Date(s.playedAt), 'h:mm a')}</span>
                        {s.id === best?.id && (
                          <span className="ml-2 text-xs font-bold bg-primary text-white px-1.5 py-0.5 rounded">BEST</span>
                        )}
                      </p>
                      {s.venueName && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3" />{s.venueName}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <span className="text-xs font-bold uppercase tracking-wider border border-white/20 rounded px-2 py-0.5 text-muted-foreground">
                    {s.type}
                  </span>
                </td>
                <td className="px-5 py-3 text-right font-bold text-lg text-primary">
                  {Number(s.score).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
