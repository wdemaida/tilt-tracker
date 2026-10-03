import { MapContainer, TileLayer, Marker, Circle } from 'react-leaflet';
import { Link } from 'wouter';
import { Home, MapPinOff } from 'lucide-react';
import { TILE_BASE_URL } from '../lib/mapTiles';
import { MAP_VIEW_ENABLED } from '../lib/mapView';
import type { MapPoint } from '../lib/api';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

const PIN_ICON = L.divIcon({
  html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="20" height="30">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24C24 5.373 18.627 0 12 0z" fill="#22c55e" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>
    <circle cx="12" cy="12" r="5" fill="white" opacity="0.9"/>
  </svg>`,
  className: '',
  iconSize: [20, 30],
  iconAnchor: [10, 30],
});

/** Zoom for an exact pin vs. an approximate (city centroid) area — shared with the full map. */
export const EXACT_ZOOM = 14;
export const APPROX_ZOOM = 11;
/** Radius of the soft circle drawn for an approximate location, in metres. */
export const APPROX_RADIUS_M = 2500;

interface VenueMapThumbnailProps {
  venueId: number;
  /** The server's public map point (venueView.ts) — the same for every viewer, owner included. */
  mapPoint: MapPoint | null;
  /** A private venue with no map point is "hidden by owner"; a public one just has no location. */
  isPrivate?: boolean;
}

// A small, non-interactive preview map used on the venue detail page — click-through takes you
// to the Venues page's Map view focused on this venue. It draws the server's public `mapPoint`, so
// the owner sees what everyone else does:
//  - exact → a pin at street zoom
//  - approximate (city_state home venue) → a soft circle at city zoom, never a pin, since a pin on
//    a city centroid reads as an exact address
//  - none (hidden tier, or no location on file) → a placeholder icon, non-clickable.
// While the Map view is switched off (`MAP_VIEW_ENABLED`) the preview is just a picture: no click-through.
export default function VenueMapThumbnail({ venueId, mapPoint, isPrivate = false }: VenueMapThumbnailProps) {
  if (!mapPoint) {
    return (
      <div
        className="w-20 h-14 sm:w-32 sm:h-20 flex-shrink-0 rounded-lg border border-venue/20 bg-venue/5 flex items-center justify-center"
        title={isPrivate ? 'Venue address hidden by owner' : 'No location on file'}
      >
        {isPrivate ? <Home className="w-8 h-8 text-venue/70" /> : <MapPinOff className="w-7 h-7 text-venue/50" />}
      </div>
    );
  }

  const { lat, lng, approximate, label } = mapPoint;
  const frame = 'w-20 h-14 sm:w-32 sm:h-20 flex-shrink-0 rounded-lg overflow-hidden border border-white/10 block relative isolate';
  const title = approximate ? `Approximate location${label ? ` (${label})` : ''}` : undefined;
  const map = (
    <>
      <MapContainer
        // Remount when the point changes kind — MapContainer only reads center/zoom on mount.
        key={`${lat},${lng},${approximate}`}
        center={[lat, lng]}
        zoom={approximate ? APPROX_ZOOM : EXACT_ZOOM}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        attributionControl={false}
      >
        {/* Base layer only — the label overlay is illegible at 128x80 and just adds noise. */}
        <TileLayer url={TILE_BASE_URL} />
        {approximate ? (
          <Circle
            center={[lat, lng]}
            radius={APPROX_RADIUS_M}
            pathOptions={{ color: '#22c55e', weight: 1, opacity: 0.6, fillColor: '#22c55e', fillOpacity: 0.2, dashArray: '3 3' }}
          />
        ) : (
          <Marker position={[lat, lng]} icon={PIN_ICON} />
        )}
      </MapContainer>
      {/* Leaflet's own CSS marks markers/panes pointer-events:auto internally, so disabling
          interaction via props above isn't enough to guarantee clicks reach the Link — this
          transparent overlay sits above the map and captures every click itself. */}
      <div className="absolute inset-0 z-[1000]" />
    </>
  );

  if (!MAP_VIEW_ENABLED) return <div className={frame} title={title}>{map}</div>;

  return (
    <Link href={`/venues?view=map&venueId=${venueId}`} className={`${frame} hover:border-venue/40 transition-colors`} title={title ?? 'Open on the map'}>
      {map}
    </Link>
  );
}
