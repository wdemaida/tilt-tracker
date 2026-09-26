import { Link } from 'wouter';
import { Swords } from 'lucide-react';
import { PinballIcon } from './PinballIcon';
import { outcomeMeta } from '../lib/challenges';
import type { ChallengeOutcome } from '../lib/api';

// Small pieces shared by the Crew → Challenges tab, the challenge page and the entry points.

/** W / L / T / Abandoned / No-show / Forfeit / Void. Abandoned and the rest are neutral on purpose. */
export function OutcomeChip({ outcome, long = false }: { outcome: ChallengeOutcome | 'void' | null | undefined; long?: boolean }) {
  if (!outcome) return null;
  const m = outcomeMeta(outcome);
  return (
    <span
      title={m.label}
      className={`inline-flex items-center justify-center min-w-[1.6rem] h-6 px-1.5 rounded-md border text-[11px] font-black uppercase tracking-wider ${m.tone}`}
    >
      {long ? m.label : m.chip}
    </span>
  );
}

export function MachineThumb({ name, imageUrl, size = 'md' }: { name: string; imageUrl: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-20 h-20 sm:w-24 sm:h-24' : size === 'sm' ? 'w-10 h-10' : 'w-12 h-12';
  return (
    <div className={`${box} rounded-lg overflow-hidden flex-shrink-0 border border-white/10 bg-white/5 flex items-center justify-center`}>
      {imageUrl
        ? <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
        : <PinballIcon className="w-1/2 h-1/2 opacity-60" aria-hidden />}
    </div>
  );
}

/** Link into the create flow, prefilled. Friend-aqua outline, so it reads as a friend action. */
export function ChallengeLink({ friend, machineId, size = 'md', label = 'Challenge', className = '' }: {
  friend?: string;
  machineId?: number;
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
}) {
  const q = new URLSearchParams();
  if (friend) q.set('friend', friend);
  if (machineId) q.set('machine', String(machineId));
  const qs = q.toString();
  const pad = size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  return (
    <Link
      href={`/challenges/new${qs ? `?${qs}` : ''}`}
      className={`inline-flex items-center gap-1.5 rounded-lg font-bold uppercase tracking-wider border border-friend/40 text-friend hover:bg-friend/10 transition-colors ${pad} ${className}`}
    >
      <Swords className="w-3.5 h-3.5" aria-hidden /> {label}
    </Link>
  );
}
