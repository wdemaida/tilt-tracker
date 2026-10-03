import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, CircleMarker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { Link, useSearch } from 'wouter';
import { formatScoreTime } from '../lib/scoreTime';
import { Clock, Home, MapPin } from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
import { TILE_BASE_URL, TILE_LABELS_URL, TILE_ATTRIBUTION } from '../lib/mapTiles';
import type { MapPoint } from '../lib/api';
import { APPROX_RADIUS_M } from '../components/VenueMapThumbnail';
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

const COLOR_MINE = '#facc15';
const COLOR_OTHERS = '#d946ef';
const PIN_MINE = makePinIcon(COLOR_MINE);
const PIN_OTHERS = makePinIcon(COLOR_OTHERS);

/** Zoom when focusing one venue (`?venueId=`): street level for an exact pin, city level for an area. */
const FOCUS_ZOOM_EXACT = 15;
const FOCUS_ZOOM_APPROX = 11;
const DEFAULT_CENTER: [number, number] = [42.36, -71.06];

/** Smallest an approximate area is drawn, in px, so it stays visible (and tappable) zoomed out. */
const APPROX_MIN_RADIUS_PX = 16;
/** Width of the invisible ring, above the pins, that keeps an area clickable where pins crowd it. */
const APPROX_HIT_RING_PX = 12;
/** Pane for those rings: above markerPane (600), below tooltips (650) and popups (700). */
const APPROX_HIT_PANE = 'approx-area-hit';

/** Web-Mercator metres per screen pixel at a latitude and zoom. */
function metresPerPixel(lat: number, zoom: number) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8);
}

/** A GET /api/venues row, as far as the map reads it. */
interface VenueRow {
  id: number;
  name: string;
  address: string | null;
  isResidence: boolean;
  scoreCount: number;
  machineCount: number | null;
  pmMachineCount?: number | null;
  lastPlayedAt?: string | null;
  timezone?: string | null;
  mapPoint: MapPoint | null;
}

type MapView =
  | { kind: 'center'; center: [number, number]; zoom: number }
  | { kind: 'bounds'; bounds: L.LatLngBoundsExpression };

// MapContainer's center/zoom props only set the initial view on mount (react-leaflet doesn't re-apply
// them on prop changes) — this keeps the view in sync once the venue list (and therefore the real
// view) arrives after first paint.
function MapViewSync({ view, viewKey }: { view: MapView; viewKey: string }) {
  const map = useMap();
  useEffect(() => {
    // animate:false matters. The first render has no venues yet, so the map mounts at zoom 4 and this
    // effect then jumps it once the query resolves. Leaflet's *animated* zoom keeps the old tiles
    // around and scales them up, and on a jump that large they never get pruned — leaving a
    // full-viewport blurry ghost of the previous zoom over the real tiles (a label layer turns it into
    // a giant smeared city name). A non-animated view change hard-resets the tile grid.
    if (view.kind === 'center') map.setView(view.center, view.zoom, { animate: false });
    else map.fitBounds(view.bounds, { animate: false, padding: [32, 32], maxZoom: 12 });
  }, [viewKey]);
  return null;
}

/**
 * The venues map. Rendered only as the Map view of the Venues page (`/venues?view=map`) — the old
 * `/map` route redirects there. `embedded` drops this page's own title row, since the Venues page
 * supplies the heading and the All/Mine toggle.
 *
 * Built on GET /api/venues, never on score GPS: a pin is a venue with scores (scoreCount > 0, already
 * counted per viewer by visibleScoreSql) and a server-computed public `mapPoint`. Hidden-tier home
 * venues have no map point and are never drawn; city_state ones get a circle on the city centroid,
 * not a pin. Owners and admins get the same public point as everyone else.
 */
export default function MapPage({ embedded = false }: { embedded?: boolean }) {
  const authApi = useApi();
  const appUser = useAppUser();
  const { mine } = useScopeContext();
  const search = useSearch();
  const focusVenueId = new URLSearchParams(search).get('venueId');

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues', mine],
    queryFn: () => authApi.venues.list(mine) as Promise<VenueRow[]>,
  });
  // Which venues have your scores, to colour those pins — the same list the Venues page's Mine view
  // reads, so it's usually cached already. Not needed when the map is already scoped to you.
  const { data: myVenues = [] } = useQuery({
    queryKey: ['venues', true],
    queryFn: () => authApi.venues.list(true) as Promise<VenueRow[]>,
    enabled: !!appUser && !mine,
  });
  const myVenueIds = useMemo(
    () => new Set((mine ? venues : myVenues).filter(v => Number(v.scoreCount) > 0).map(v => v.id)),
    [mine, venues, myVenues],
  );

  const pins = useMemo(
    () => venues.filter((v): v is VenueRow & { mapPoint: MapPoint } => Number(v.scoreCount) > 0 && v.mapPoint != null),
    [venues],
  );
  const focusRow = focusVenueId ? venues.find(v => String(v.id) === focusVenueId) : undefined;
  const focusPin = focusVenueId ? pins.find(p => String(p.id) === focusVenueId) : undefined;

  const { view, viewKey } = useMemo((): { view: MapView; viewKey: string } => {
    if (focusPin) {
      const { lat, lng, approximate } = focusPin.mapPoint;
      const zoom = approximate ? FOCUS_ZOOM_APPROX : FOCUS_ZOOM_EXACT;
      return { view: { kind: 'center', center: [lat, lng], zoom }, viewKey: `focus:${focusPin.id}:${lat},${lng},${zoom}` };
    }
    if (pins.length === 1) {
      const { lat, lng } = pins[0].mapPoint;
      return { view: { kind: 'center', center: [lat, lng], zoom: 10 }, viewKey: `one:${lat},${lng}` };
    }
    if (pins.length > 1) {
      const bounds = L.latLngBounds(pins.map(p => [p.mapPoint.lat, p.mapPoint.lng] as [number, number]));
      return { view: { kind: 'bounds', bounds }, viewKey: `bounds:${bounds.toBBoxString()}` };
    }
    return { view: { kind: 'center', center: DEFAULT_CENTER, zoom: 4 }, viewKey: 'default' };
  }, [focusPin, pins]);

  // react-leaflet's Popup binds itself to the layer inside a useEffect, which runs after ref callbacks
  // fire — calling openPopup() straight from the ref fires before that bind exists, so it silently
  // no-ops. Routing the instance through state defers the openPopup() call to our own effect, which
  // runs after the Popup's bind effect has already committed.
  const [autoPopupLayer, setAutoPopupLayer] = useState<L.Marker | L.CircleMarker | null>(null);
  useEffect(() => {
    autoPopupLayer?.openPopup();
  }, [autoPopupLayer]);

  const subtitle = mine ? 'Venues where you’ve logged scores' : 'Venues where TiltTrack players have logged scores';

  return (
    <div>
      {!embedded && (
        <div className="flex items-start justify-between gap-4 mb-1">
          <h1 className="text-4xl font-black uppercase tracking-widest text-white">Map</h1>
          <ScopeToggle />
        </div>
      )}
      <p className="text-sm text-muted-foreground mb-1">
        {subtitle}
        {!isLoading && <> · {pins.length} {pins.length === 1 ? 'venue' : 'venues'}</>}
      </p>
      {focusVenueId && !isLoading && (
        <p className="text-sm text-muted-foreground mb-1">
          {focusPin ? (
            <>Showing <span className="text-venue font-bold">{focusPin.name}</span>{focusPin.mapPoint.approximate ? ' (approximate location)' : ''}</>
          ) : (
            <><span className="text-venue font-bold">{focusRow?.name ?? 'This venue'}</span> isn’t on the map</>
          )}
          {' · '}
          <Link href="/venues?view=map" className="text-primary hover:text-primary/80 transition-colors">show all</Link>
        </p>
      )}
      <p className="text-xs text-muted-foreground/60 mb-6">
        Home venues appear only as an approximate area, or not at all, at the owner’s choice.
      </p>

      <div className="rounded-xl overflow-hidden border border-white/10" style={{ height: 480 }}>
        <MapContainer center={DEFAULT_CENTER} zoom={4} style={{ height: '100%', width: '100%' }}>
          <MapViewSync view={view} viewKey={viewKey} />
          <TileLayer url={TILE_BASE_URL} attribution={TILE_ATTRIBUTION} />
          <TileLayer url={TILE_LABELS_URL} />
          {pins.map(v => {
            const isMine = myVenueIds.has(v.id);
            const isFocus = focusPin?.id === v.id;
            const popup = <VenuePopup venue={v} />;
            if (v.mapPoint.approximate) {
              return (
                <ApproxArea
                  key={v.id}
                  center={[v.mapPoint.lat, v.mapPoint.lng]}
                  color={isMine ? COLOR_MINE : COLOR_OTHERS}
                  popup={popup}
                  layerRef={isFocus ? setAutoPopupLayer : undefined}
                />
              );
            }
            return (
              <Marker
                key={v.id}
                position={[v.mapPoint.lat, v.mapPoint.lng]}
                icon={isMine ? PIN_MINE : PIN_OTHERS}
                ref={isFocus ? setAutoPopupLayer : undefined}
              >
                {popup}
              </Marker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}

/**
 * An approximate (city_state home) venue: a dashed area on the city centroid, never a pin.
 *
 * Its size is geographic — APPROX_RADIUS_M, the same 2.5 km the venue thumbnail draws — so it reads as
 * "somewhere around here" at city zoom and grows as you zoom in, but never shrinks below
 * APPROX_MIN_RADIUS_PX zoomed out, where 2.5 km would be a dot. A pixel-radius CircleMarker recomputed
 * on zoom (rather than a Leaflet `Circle`) is what gives that floor.
 *
 * Hit-testing: the filled area sits in the overlay pane, *under* the pins, so exact venues inside the
 * city stay clickable. Pins crowding the area used to swallow its clicks (a 14 px circle was easily
 * covered by one 24×36 pin), so a second, invisible ring along its edge sits in a pane *above* the
 * pins and opens the same popup. Only the ring's stroke is hit (`fill: false`), so it never blocks a
 * pin inside the area.
 */
function ApproxArea({ center, color, popup, layerRef }: {
  center: [number, number];
  color: string;
  popup: ReactNode;
  layerRef?: (layer: L.CircleMarker | null) => void;
}) {
  const map = useMap();
  // Created here, synchronously, so it exists before the ring layer below is added to it.
  useState(() => {
    if (!map.getPane(APPROX_HIT_PANE)) map.createPane(APPROX_HIT_PANE).style.zIndex = '610';
    return null;
  });
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const radius = Math.max(APPROX_MIN_RADIUS_PX, APPROX_RADIUS_M / metresPerPixel(center[0], zoom));
  return (
    <>
      <CircleMarker
        center={center}
        radius={radius}
        pathOptions={{ color, weight: 2, opacity: 0.9, dashArray: '6 5', fillColor: color, fillOpacity: 0.18 }}
        ref={layerRef}
      >
        {popup}
      </CircleMarker>
      <CircleMarker
        center={center}
        radius={radius}
        pane={APPROX_HIT_PANE}
        pathOptions={{ stroke: true, color, opacity: 0, weight: APPROX_HIT_RING_PX, fill: false }}
      >
        {popup}
      </CircleMarker>
    </>
  );
}

function VenuePopup({ venue: v }: { venue: VenueRow & { mapPoint: MapPoint } }) {
  const scores = Number(v.scoreCount);
  const machines = v.machineCount;
  const where = v.mapPoint.approximate
    ? `${v.mapPoint.label ?? v.address ?? 'Location'} (approximate)`
    : v.address;
  return (
    <Popup minWidth={220}>
      <div className="px-4 pt-3 pb-3">
        <div className="flex items-center justify-center gap-1.5 mb-1">
          <Link href={`/venues/${v.id}`} className="font-black uppercase tracking-wider text-venue text-sm hover:text-venue/80 transition-colors leading-tight text-center">
            {v.name}
          </Link>
          {v.isResidence && <Home className="w-3 h-3 text-venue/70 flex-shrink-0" />}
        </div>
        {where && (
          <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground mb-3 text-center">
            <MapPin className="w-3 h-3 flex-shrink-0" />
            <span>{where}</span>
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            <span className="font-bold text-white">{scores}</span> {scores === 1 ? 'score' : 'scores'}
          </div>
          {machines != null && (
            <div className="flex items-center gap-1">
              <PinballIcon className="w-3 h-3 text-machine" />
              <span className="text-xs text-machine font-bold">
                {machines} {machines === 1 ? 'machine' : 'machines'}
              </span>
            </div>
          )}
        </div>
        {v.lastPlayedAt && (
          <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground mt-2">
            <Clock className="w-3 h-3 flex-shrink-0" />
            <span>Last played {formatScoreTime(v.lastPlayedAt, v.timezone, 'M/d/yy')}</span>
          </div>
        )}
      </div>
    </Popup>
  );
}
