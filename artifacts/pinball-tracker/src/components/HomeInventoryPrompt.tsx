import { Link } from 'wouter';
import { ChevronRight } from 'lucide-react';
import { PinballIcon } from './PinballIcon';

/** The venue page URL that opens a home venue's inventory panel in its first-time setup mode. */
export const inventorySetupHref = (venueId: number) => `/venues/${venueId}?setup-inventory=1`;

// Shown after someone creates a home venue in the middle of a score flow (Add Score's step 4, the
// edit-score dialog's venue picker). Listing machines is optional and has its own step on the venue
// page — a score only says "played here once", so it never fills the inventory by itself, but doing
// it inline would derail logging the score. `onNavigate` lets a dialog close itself on the way out.
export default function HomeInventoryPrompt({ venueId, venueName, onNavigate }: {
  venueId: number;
  venueName: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={inventorySetupHref(venueId)}
      onClick={onNavigate}
      className="w-full flex items-center gap-3 rounded-xl border border-machine/30 bg-machine/5 px-4 py-3 text-left hover:bg-machine/10 transition-colors"
    >
      <PinballIcon className="w-5 h-5 flex-shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-machine [overflow-wrap:anywhere]">List the machines at {venueName}</span>
        <span className="block text-xs text-muted-foreground">Optional — challenge recommendations use them.</span>
      </span>
      <ChevronRight className="w-4 h-4 text-machine flex-shrink-0" />
    </Link>
  );
}
