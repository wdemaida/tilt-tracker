import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { Link } from 'wouter';
import { Home } from 'lucide-react';
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

interface VenueMapThumbnailProps {
  venueId: number;
  latitude: number | null;
  longitude: number | null;
}

// A small, non-interactive preview map used on the venue detail page — click-through takes you
// to the full Map page filtered to this venue. When lat/lng are redacted (hidden-tier venue,
// viewed by anyone but the owner/admin), there's nothing to show a map of, so a house icon
// stands in instead — non-clickable, since there's no location to navigate to.
export default function VenueMapThumbnail({ venueId, latitude, longitude }: VenueMapThumbnailProps) {
  if (latitude == null || longitude == null) {
    return (
      <div
        className="w-32 h-20 flex-shrink-0 rounded-lg border border-venue/20 bg-venue/5 flex items-center justify-center"
        title="Venue address hidden by owner"
      >
        <Home className="w-8 h-8 text-venue/70" />
      </div>
    );
  }

  return (
    <Link
      href={`/map?venueId=${venueId}`}
      className="w-32 h-20 flex-shrink-0 rounded-lg overflow-hidden border border-white/10 block relative hover:border-venue/40 transition-colors"
    >
      <MapContainer
        center={[latitude, longitude]}
        zoom={14}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        attributionControl={false}
      >
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <Marker position={[latitude, longitude]} icon={PIN_ICON} />
      </MapContainer>
      {/* Leaflet's own CSS marks markers/panes pointer-events:auto internally, so disabling
          interaction via props above isn't enough to guarantee clicks reach the Link — this
          transparent overlay sits above the map and captures every click itself. */}
      <div className="absolute inset-0 z-[1000]" />
    </Link>
  );
}
