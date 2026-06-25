import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { api } from '../lib/api';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix Leaflet default marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

export default function MapPage() {
  const { data: scores = [] } = useQuery({ queryKey: ['scores'], queryFn: api.scores.list });

  const withGps = scores.filter((s: any) => s.latitude && s.longitude);
  const venues = withGps.reduce((acc: Record<string, any[]>, s: any) => {
    const key = `${s.latitude},${s.longitude}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const locations = Object.entries(venues).map(([key, items]) => {
    const [lat, lng] = key.split(',').map(Number);
    return { lat, lng, scores: items as any[], venueName: (items[0] as any).venueName };
  });

  return (
    <div>
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-1">Map</h1>
      <p className="text-sm text-muted-foreground mb-6">
        {locations.length} locations · {withGps.length} scores with GPS
      </p>

      <div className="rounded-xl overflow-hidden border border-white/10" style={{ height: 480 }}>
        <MapContainer
          center={locations[0] ? [locations[0].lat, locations[0].lng] : [42.36, -71.06]}
          zoom={locations.length ? 8 : 4}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          />
          {locations.map(({ lat, lng, scores, venueName }) => (
            <Marker key={`${lat},${lng}`} position={[lat, lng]}>
              <Popup>
                <div className="text-sm">
                  <p className="font-bold">{venueName ?? 'Unknown venue'}</p>
                  <p className="text-muted-foreground">{scores.length} scores</p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
