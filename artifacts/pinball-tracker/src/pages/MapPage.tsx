import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';
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

export default function MapPage() {
  const authApi = useApi();
  const appUser = useAppUser();
  const { mine } = useScopeContext();
  const { data: scores = [] } = useQuery({
    queryKey: ['scores', mine],
    queryFn: () => authApi.scores.list(mine),
  });

  const withGps = scores.filter((s: any) => s.latitude && s.longitude);
  const venueGroups = withGps.reduce((acc: Record<string, any[]>, s: any) => {
    const key = `${s.latitude},${s.longitude}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const locations = Object.entries(venueGroups).map(([key, items]) => {
    const [lat, lng] = key.split(',').map(Number);
    const list = items as any[];
    const hasMyScore = !!appUser && list.some((s: any) => s.username === appUser.username);
    // Most recent score: in MINE mode items are already own-only; in ALL mode show globally newest
    const recent = mine && appUser
      ? list.find((s: any) => s.username === appUser.username) ?? list[0]
      : list[0];
    return { lat, lng, total: list.length, venueName: list[0].venueName, venueId: list[0].venueId, recent, hasMyScore };
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Map</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {locations.length} {locations.length === 1 ? 'location' : 'locations'} · {withGps.length} {mine ? 'your ' : ''}scores with GPS
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
          {locations.map(({ lat, lng, total, venueName, venueId, recent, hasMyScore }) => (
            <Marker key={`${lat},${lng}`} position={[lat, lng]} icon={hasMyScore ? PIN_MINE : PIN_OTHERS}>
              <Popup>
                <div style={{ minWidth: 180 }}>
                  {venueId ? (
                    <Link href={`/venues/${venueId}`} style={{ fontWeight: 700, fontSize: 13, color: '#d946ef', textDecoration: 'none' }}>
                      {venueName ?? 'Unknown venue'}
                    </Link>
                  ) : (
                    <p style={{ fontWeight: 700, fontSize: 13 }}>{venueName ?? 'Unknown venue'}</p>
                  )}
                  <p style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{total} {total === 1 ? 'score' : 'scores'}</p>
                  {recent && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #333' }}>
                      <p style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>Most recent</p>
                      <p style={{ fontWeight: 700, fontSize: 13 }}>{recent.machineName}</p>
                      <p style={{ fontSize: 12, color: '#d946ef', fontWeight: 700 }}>{Number(recent.score).toLocaleString()}</p>
                      <p style={{ fontSize: 11, color: '#888' }}>
                        {recent.displayName ?? recent.username} · {format(new Date(recent.playedAt), 'M/d/yy')}
                      </p>
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
