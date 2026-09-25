import { User } from 'lucide-react';
import { podColorTokens } from '../lib/podColor';
import type { PodRef } from '../lib/myPods';

const MAX_ICONS = 5;

/**
 * One small person icon per pod (of the viewer's) that a player is in, each in that pod's color.
 * Feed it `usePodMembership().get(username)`; renders nothing for no pods, so signed-out viewers and
 * the viewer's own rows get nothing. Only the viewer's own pods ever reach it — /api/pods is
 * owner-scoped.
 *
 * Past MAX_ICONS it shows the first few and a "+N" (full list in the title) so a row can't blow out.
 */
export default function PodMemberIcons({ pods, className = '' }: { pods: PodRef[] | undefined; className?: string }) {
  if (!pods?.length) return null;
  const shown = pods.length > MAX_ICONS ? pods.slice(0, MAX_ICONS - 1) : pods;
  const hidden = pods.slice(shown.length);
  return (
    <span className={`inline-flex items-center gap-0.5 flex-shrink-0 align-middle ${className}`}>
      {shown.map(p => (
        <span key={p.id} role="img" aria-label={`In your pod ${p.name}`} title={p.name} className="inline-flex">
          <User aria-hidden className="w-3 h-3" strokeWidth={2.5} style={{ color: podColorTokens(p.color).graphic }} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          role="img"
          aria-label={`Also in ${hidden.map(p => p.name).join(', ')}`}
          title={hidden.map(p => p.name).join(', ')}
          className="text-[10px] font-bold text-muted-foreground leading-none"
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
