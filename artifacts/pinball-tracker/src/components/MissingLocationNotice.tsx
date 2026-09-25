import { Loader2, LocateFixed, MapPinOff } from 'lucide-react';
import { canOfferCurrentLocation, type PhotoLocationInfo, type Platform } from '../lib/photoLocation';

export type CurrentLocationState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'done'; count: number; accuracy: number }
  | { status: 'error'; message: string };

interface Props {
  info: PhotoLocationInfo;
  photoCount: number;
  platform: Platform;
  state: CurrentLocationState;
  onUseCurrentLocation: () => void;
}

/** Past this, a fix is probably Wi-Fi/IP-based and the nearest venue may not be the right one. */
const APPROXIMATE_M = 300;

function HowToTurnOn({ platform }: { platform: Platform }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-white transition-colors">How to turn on photo location</summary>
      <div className="mt-1.5 flex flex-col gap-1 leading-relaxed">
        {platform === 'ios' && (
          <>
            <p>
              <span className="text-white/80">Settings → Privacy &amp; Security → Location Services → Camera → While Using the App</span>
            </p>
            <p>Then take the photo in the Camera app and add it with “Choose photos or videos”.</p>
          </>
        )}
        {platform === 'android' && (
          <p>
            Open your <span className="text-white/80">Camera app settings → Location tags</span> (on some phones
            it’s called <span className="text-white/80">Save location</span>) and turn it on.
          </p>
        )}
        {platform === 'other' && (
          <p>
            Turn on location for your phone’s Camera app — on iPhone it’s under Settings → Privacy &amp; Security →
            Location Services → Camera; on Android, look for “Location tags” or “Save location” in the Camera
            app’s settings.
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * Step 2's notice when none of the picked photos/videos carried GPS. Non-blocking: manual venue
 * search below keeps working exactly as before whatever happens here.
 */
export function MissingLocationNotice({ info, photoCount, platform, state, onUseCurrentLocation }: Props) {
  const offer = canOfferCurrentLocation(info);
  const many = photoCount > 1;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <MapPinOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-amber-400">
          {many ? 'These photos have' : 'This photo has'} no location, so we can’t find the venue automatically.
        </p>
      </div>

      {offer ? (
        <>
          {state.status !== 'done' && (
            <button
              type="button"
              onClick={onUseCurrentLocation}
              disabled={state.status === 'locating'}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-venue text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {state.status === 'locating'
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Finding venues near you…</>
                : <><LocateFixed className="w-4 h-4" /> Use my current location</>}
            </button>
          )}
          {state.status === 'idle' && (
            <p className="text-xs text-muted-foreground -mt-1">
              Still at the venue? We’ll use where you are now to suggest it — only for this lookup, never saved.
            </p>
          )}
          {state.status === 'done' && (
            <p className="text-xs text-white/80">
              {state.count > 0
                ? `Showing venues near where you are now${state.accuracy > APPROXIMATE_M ? ` — your location is approximate (±${Math.round(state.accuracy)}m), so check it’s the right one` : ''}.`
                : 'No venues found near you — search for it below.'}
            </p>
          )}
          {state.status === 'error' && <p className="text-xs text-amber-400">{state.message}</p>}
          {platform === 'ios' && info.fromCamera && (
            <p className="text-xs text-muted-foreground">
              On iPhone, photos taken with this page’s camera button usually don’t include location — so this
              button is the quickest fix.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-white/80">
          Photo taken earlier? Pick the venue below.
        </p>
      )}

      <HowToTurnOn platform={platform} />
    </div>
  );
}
