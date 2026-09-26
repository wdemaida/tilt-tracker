import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Link, useSearch } from 'wouter';
import { formatScoreTime } from '../lib/scoreTime';
import { Clock, User, Home } from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { TILE_BASE_URL, TILE_LABELS_URL, TILE_ATTRIBUTION } from '../lib/mapTiles';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

function makePinIcon(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24C24 5.373 18.627 0 12 0z" fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>
    <circle cx="12" cy="12" r="5" fill="white" opacity="0.9"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [24, 36],
    iconAnchor: [12, 36],
    popupAnchor: [0, -36],
  });
}

const PIN_MINE = makePinIcon('#facc15');
const PIN_OTHERS = makePinIcon('#d946ef');

// MapContainer's center/zoom props only set the initial view on mount (react-leaflet
// doesn't re-apply them on prop changes) — this keeps the view in sync once async
// score data (and therefore the real center) arrives after first paint.
function MapViewSync({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    // animate:false matters. The first render has no scores yet, so the map mounts at zoom 4 and
    // this effect then jumps it to 8 once the query resolves. Leaflet's *animated* zoom keeps the
    // old zoom-4 tiles around and scales them up, and on a jump that large they never get pruned —
    // leaving a full-viewport blurry ghost of the previous zoom sitting over the real tiles. It was
    // always there, just easy to miss when the basemap was near-black and unlabelled; a label layer
    // turns it into a giant smeared city name. A non-animated setView hard-resets the tile grid.
    map.setView(center, zoom, { animate: false });
  }, [center[0], center[1], zoom]);
  return null;
}

/**
 * The venues map. Rendered only as the Map view of the Venues page (`/venues?view=map`) — the old
 * `/map` route redirects there. `embedded` drops this page's own title row, since the Venues page
 * supplies the heading and the All/Mine toggle.
 */
export default function MapPage({ embedded = false }: { embedded?: boolean }) {
  const authApi = useApi();
  const appUser = useAppUser();
  const { mine } = useScopeContext();
  const search = useSearch();
  const filterVenueId = new URLSearchParams(search).get('venueId');
  const { data: scores = [] } = useQuery({
    queryKey: ['scores', mine],
    queryFn: () => authApi.scores.list(mine),
  });

  const withGps = scores.filter((s: any) => s.latitude && s.longitude);
  // Group by venue, NOT by raw coordinates. Every score carries the GPS off its own photo, so two
  // plays on the same machine sit a few metres apart and used to become two separate pins — one
  // venue with 25 scores rendered as 23 stacked markers, and the "N locations" count counted each
  // one. Only a venue-less score has nothing to group on and still falls back to its coordinate.
  const venueGroups = withGps.reduce((acc: Record<string, any[]>, s: any) => {
    const key = s.venueId != null ? `v${s.venueId}` : `c${s.latitude},${s.longitude}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const allLocations = Object.entries(venueGroups).map(([key, items]) => {
    const list = items as any[];
    // Sit the pin at the centroid of the group's photo fixes rather than on whichever score
    // happened to be first, so it lands on the building instead of at one corner of it.
    const lat = list.reduce((sum, s: any) => sum + Number(s.latitude), 0) / list.length;
    const lng = list.reduce((sum, s: any) => sum + Number(s.longitude), 0) / list.length;
    const hasMyScore = !!appUser && list.some((s: any) => s.username === appUser.username);
    const recent = mine && appUser
      ? list.find((s: any) => s.username === appUser.username) ?? list[0]
      : list[0];
    const machineCount = new Set(list.map((s: any) => s.machineId)).size;
    const visits = new Set(list.map((s: any) => new Date(s.playedAt).toDateString())).size;
    return { key, lat, lng, venueName: list[0].venueName, venueId: list[0].venueId, isResidence: !!list[0].venueIsResidence, recent, hasMyScore, machineCount, visits };
  });

  const locations = filterVenueId
    ? allLocations.filter(loc => String(loc.venueId) === filterVenueId)
    : allLocations;

  const mapCenter: [number, number] = locations[0] ? [locations[0].lat, locations[0].lng] : [42.36, -71.06];
  const mapZoom = filterVenueId ? 15 : (locations.length ? 8 : 4);

  // react-leaflet's Popup binds itself to the marker inside a useEffect, which runs
  // after ref callbacks fire — calling openPopup() straight from the Marker ref (as
  // this used to) fires before that bind exists, so it silently no-ops. Routing the
  // instance through state defers the openPopup() call to our own effect, which runs
  // after the Popup's bind effect has already committed.
  const [autoPopupMarker, setAutoPopupMarker] = useState<L.Marker | null>(null);
  useEffect(() => {
    autoPopupMarker?.openPopup();
  }, [autoPopupMarker]);

  return (
    <div>
      {!embedded && (
        <div className="flex items-start justify-between gap-4 mb-1">
          <h1 className="text-4xl font-black uppercase tracking-widest text-white">Map</h1>
          <ScopeToggle />
        </div>
      )}
      <p className="text-sm text-muted-foreground mb-1">
        {filterVenueId ? (
          <>Showing <span className="text-venue font-bold">{locations[0]?.venueName ?? 'this venue'}</span> only · <Link href="/venues?view=map" className="text-primary hover:text-primary/80 transition-colors">clear filter</Link></>
        ) : (
          <>{locations.length} {locations.length === 1 ? 'location' : 'locations'} · {withGps.length} {mine ? 'your ' : ''}scores with GPS</>
        )}
      </p>
      <p className="text-xs text-muted-foreground/60 mb-6">
        Some venues (e.g. personal residences) are hidden or shown only by city/state at the owner's choice.
      </p>

      <div className="rounded-xl overflow-hidden border border-white/10" style={{ height: 480 }}>
        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{ height: '100%', width: '100%' }}
        >
          <MapViewSync center={mapCenter} zoom={mapZoom} />
          <TileLayer url={TILE_BASE_URL} attribution={TILE_ATTRIBUTION} />
          <TileLayer url={TILE_LABELS_URL} />
          {locations.map(({ key, lat, lng, venueName, venueId, isResidence, recent, hasMyScore, machineCount, visits }) => (
            <Marker
              key={key}
              position={[lat, lng]}
              icon={hasMyScore ? PIN_MINE : PIN_OTHERS}
              ref={filterVenueId ? setAutoPopupMarker : undefined}
            >
              <Popup minWidth={220}>
                {/* Location section */}
                <div className="px-4 pt-3 pb-3">
                  <div className="flex items-center justify-center gap-1.5 mb-3">
                    {venueId ? (
                      <Link href={`/venues/${venueId}`} className="font-black uppercase tracking-wider text-venue text-sm hover:text-venue/80 transition-colors leading-tight">
                        {venueName ?? 'Unknown venue'}
                      </Link>
                    ) : (
                      <p className="font-black uppercase tracking-wider text-white text-sm leading-tight">{venueName ?? 'Unknown venue'}</p>
                    )}
                    {isResidence && <Home className="w-3 h-3 text-venue/70 flex-shrink-0" />}
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <PinballIcon className="w-3 h-3 text-machine" />
                      <span className="text-xs text-machine font-bold">
                        {machineCount} {machineCount === 1 ? 'machine' : 'machines'}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-bold text-white">{visits}</span> {visits === 1 ? 'visit' : 'visits'}
                    </div>
                  </div>
                </div>

                {/* Play info section */}
                {recent && (
                  <div className="border-t border-white/10 px-4 pt-3 pb-3 text-center">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Most Recent Play</p>
                    <Link
                      href={`/machines/${encodeURIComponent(recent.machineName)}`}
                      className="block text-sm font-black uppercase tracking-wider text-machine hover:text-machine/80 transition-colors leading-tight mb-2"
                    >
                      {recent.machineName}
                    </Link>
                    <p className="text-2xl font-bold text-primary mb-3">{Number(recent.score).toLocaleString()}</p>
                    <div className="flex flex-col items-center gap-0.5">
                      <Link href={`/users/${recent.username}`} className="flex items-center gap-1 text-xs text-username hover:text-username/80 transition-colors">
                        <User className="w-3 h-3 flex-shrink-0" />
                        <span>@{recent.username}</span>
                      </Link>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3 flex-shrink-0" />
                        <span>{formatScoreTime(recent.playedAt, recent.venueTimezone, 'M/d/yy · h:mm a')}</span>
                      </div>
                    </div>
                  </div>
                )}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
