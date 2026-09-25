import { Loader2, LocateFixed, MapPinOff } from 'lucide-react';
import { currentLocationOffer, type PhotoLocationInfo, type Platform } from '../lib/photoLocation';

export type CurrentLocationState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'done'; count: number; accuracy: number }
  | { status: 'error'; message: string };

interface Props {
  /** Null when there's no photo at all ("Skip AI & Enter Manually"). */
  info: PhotoLocationInfo | null;
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
 * Step 2's notice when none of the picked photos/videos carried GPS — or when there's no photo at all
 * (manual entry). Non-blocking: manual venue search below keeps working exactly as before whatever
 * happens here.
 */
export function MissingLocationNotice({ info, photoCount, platform, state, onUseCurrentLocation }: Props) {
  const noPhoto = !info || photoCount === 0;
  const offer = info ? currentLocationOffer(info) : 'primary';
  const many = photoCount > 1;

  const button = state.status !== 'done' && (
    offer === 'primary' ? (
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
    ) : (
      <button
        type="button"
        onClick={onUseCurrentLocation}
        disabled={state.status === 'locating'}
        className="self-start flex items-center gap-1.5 text-xs font-bold text-venue hover:opacity-80 transition-opacity disabled:opacity-60"
      >
        {state.status === 'locating'
          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Finding venues near you…</>
          : <><LocateFixed className="w-3.5 h-3.5" /> Still there? Use my current location</>}
      </button>
    )
  );

  return (
    <div className={`rounded-lg border p-3 flex flex-col gap-2.5 ${noPhoto ? 'border-venue/40 bg-venue/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <div className="flex items-start gap-2">
        {noPhoto
          ? <LocateFixed className="w-4 h-4 text-venue flex-shrink-0 mt-0.5" />
          : <MapPinOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />}
        <p className={`text-sm ${noPhoto ? 'text-white/90' : 'text-amber-400'}`}>
          {noPhoto
            ? 'At the venue now? Use your current location to find it.'
            : offer === 'primary'
              ? `No location in ${many ? 'these photos' : 'this photo'} — use your current location to find the venue.`
              : `No location in ${many ? 'these photos' : 'this photo'}, and ${many ? 'they were' : 'it was'} taken a while ago — pick the venue below.`}
        </p>
      </div>

      {button}
      {state.status === 'idle' && (
        <p className="text-xs text-muted-foreground -mt-1">
          Where you are now is used only to find nearby venues — it’s never saved with your score.
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
      {!noPhoto && offer === 'primary' && platform === 'ios' && info?.fromCamera && (
        <p className="text-xs text-muted-foreground">
          On iPhone, photos taken with this page’s camera button usually don’t include location — so this
          button is the quickest fix.
        </p>
      )}

      {!noPhoto && <HowToTurnOn platform={platform} />}
    </div>
  );
}
