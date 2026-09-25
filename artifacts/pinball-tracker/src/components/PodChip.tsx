import type { ReactNode } from 'react';
import { podColorVars, DARK_SURFACE } from '../lib/podColor';

/**
 * A pill in a pod's color: tinted background, pod-colored border and label.
 * `solid` fills it with the pod color instead (e.g. the selected pod).
 * `surface` only matters off the app's dark card (see podColor.ts).
 */
export default function PodChip({
  color,
  children,
  solid = false,
  surface = DARK_SURFACE,
  className = '',
}: {
  color: string;
  children: ReactNode;
  solid?: boolean;
  surface?: string;
  className?: string;
}) {
  return (
    <span
      style={podColorVars(color, surface)}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold ${
        solid ? 'bg-pod border-pod text-pod-on' : 'bg-pod/15 border-pod/40 text-pod-text'
      } ${className}`}
    >
      {children}
    </span>
  );
}
