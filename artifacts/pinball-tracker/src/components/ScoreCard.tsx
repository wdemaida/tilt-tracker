import { Link } from 'wouter';
import { MapPin, Clock, Pencil, Trash2, Trophy } from 'lucide-react';
import { format } from 'date-fns';

interface ScoreCardProps {
  id: number;
  machineName: string;
  score: number;
  playedAt: string;
  type: 'casual' | 'tournament';
  venueName?: string | null;
  photoUrl?: string | null;
  photoThumbnail?: string | null;
  username: string;
  displayName: string;
  isHighScore?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function ScoreCard({ id: _id, machineName, score, playedAt, type, venueName, photoThumbnail, username, isHighScore, onEdit, onDelete }: ScoreCardProps) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-4 flex flex-col gap-3 hover:border-primary/40 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground border border-white/20 rounded px-2 py-0.5">
          {type}
        </span>
        <div className="flex items-center gap-2">
          {onEdit && (
            <button
              onClick={onEdit}
              className="p-1 rounded text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Edit score"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
              aria-label="Delete score"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          <Link href={`/machines/${encodeURIComponent(machineName)}`} className="text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors">
            {machineName}
          </Link>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-3xl font-bold text-primary">{score.toLocaleString()}</p>
            {isHighScore && <Trophy className="w-4 h-4 text-yellow-400 flex-shrink-0" />}
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground mt-2">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 flex-shrink-0" />
              <span>{format(new Date(playedAt), 'MMM d, yyyy · h:mm a')}</span>
            </div>
            {venueName && (
              <div className="flex items-center gap-1">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{venueName}</span>
              </div>
            )}
          </div>
        </div>
        {photoThumbnail && (
          <img
            src={photoThumbnail}
            alt="Score proof"
            className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
          />
        )}
      </div>

      <div className="pt-1 border-t border-white/10">
        <Link href={`/users/${username}`} className="text-xs text-muted-foreground hover:text-white transition-colors">
          {username}
        </Link>
      </div>
    </div>
  );
}
