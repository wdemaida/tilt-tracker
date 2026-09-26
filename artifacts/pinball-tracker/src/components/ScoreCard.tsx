import { useState } from 'react';
import { Link } from 'wouter';
import { MapPin, Clock, Pencil, Trash2, Trophy, Home, Maximize2 } from 'lucide-react';
import PhotoViewer from './PhotoViewer';
import { formatScoreTime, zoneAbbreviation } from '../lib/scoreTime';
import PodMemberIcons from './PodMemberIcons';
import UsernameLink from './UsernameLink';
import type { PodRef } from '../lib/myPods';

interface ScoreCardProps {
  id: number;
  machineName: string;
  score: number;
  playedAt: string;
  createdAt?: string | null;
  type: 'casual' | 'tournament';
  venueId?: number | null;
  venueName?: string | null;
  /** IANA zone of the venue. Null falls back to the viewer's clock — see lib/scoreTime.ts. */
  venueTimezone?: string | null;
  venueIsResidence?: boolean;
  photoUrl?: string | null;
  photoThumbnail?: string | null;
  /** A full-size photo exists on R2: the thumbnail opens it in PhotoViewer. */
  hasFullPhoto?: boolean;
  username: string;
  displayName: string;
  isHighScore?: boolean;
  isCurrentUser?: boolean;
  /** The viewer's pods this player is in — `usePodMembership().get(username)` from the page, so the
   *  map is built once per list rather than per tile. Omit to show no icons. */
  pods?: PodRef[];
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function ScoreCard({ id, machineName, score, playedAt, createdAt, type, venueId, venueName, venueTimezone, venueIsResidence, photoThumbnail, hasFullPhoto, username, isHighScore, isCurrentUser, pods, onEdit, onDelete }: ScoreCardProps) {
  // Only shown when the venue's clock differs from the reader's, so the usual case stays quiet.
  const zone = zoneAbbreviation(playedAt, venueTimezone);
  const [viewing, setViewing] = useState(false);
  return (
    <div className={`rounded-xl border bg-card p-4 flex flex-col gap-3 hover:border-primary/40 transition-colors ${isCurrentUser ? 'border-username/60' : 'border-white/10'}`}>
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
          <Link href={`/machines/${encodeURIComponent(machineName)}`} className="text-sm font-bold uppercase tracking-wider text-machine hover:text-machine/80 transition-colors">
            {machineName}
          </Link>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-3xl font-bold text-primary">{score.toLocaleString()}</p>
            {isHighScore && <Trophy className="w-4 h-4 text-username flex-shrink-0" />}
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground mt-2">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 flex-shrink-0" />
              <span>{formatScoreTime(playedAt, venueTimezone, 'MMM d, yyyy · h:mm a')}</span>
              {zone && <span className="text-muted-foreground/60">{zone}</span>}
            </div>
            {venueName && (
              <div className="flex items-center gap-1 text-venue">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                {venueId != null ? (
                  <Link href={`/venues/${venueId}`} className="truncate hover:text-venue/80 transition-colors">
                    {venueName}
                  </Link>
                ) : (
                  <span className="truncate">{venueName}</span>
                )}
                {venueIsResidence && <Home className="w-3 h-3 flex-shrink-0" />}
              </div>
            )}
          </div>
        </div>
        {photoThumbnail && !hasFullPhoto && (
          <img
            src={photoThumbnail}
            alt="Score proof"
            className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
          />
        )}
        {photoThumbnail && hasFullPhoto && (
          <button
            type="button"
            onClick={() => setViewing(true)}
            aria-label="View full-size photo"
            className="relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <img src={photoThumbnail} alt="Score proof" className="w-full h-full object-cover transition-transform group-hover:scale-105" />
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 p-0.5" aria-hidden>
              <Maximize2 className="w-2.5 h-2.5 text-white" />
            </span>
          </button>
        )}
        {viewing && (
          <PhotoViewer
            scoreId={id}
            thumbnail={photoThumbnail}
            caption={{ machineName, score, playedAt, venueTimezone, username }}
            onClose={() => setViewing(false)}
          />
        )}
      </div>

      <div className="pt-1 border-t border-white/10 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <UsernameLink username={username} className="text-xs text-username hover:text-username/80 truncate" />
          <PodMemberIcons pods={pods} />
        </span>
        {createdAt && (
          <span className="text-xs text-muted-foreground/60 flex-shrink-0 whitespace-nowrap">
            added: {formatScoreTime(createdAt, null, 'MMM d · h:mm a')}
          </span>
        )}
      </div>
    </div>
  );
}
