import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { Building2, Clock, User } from 'lucide-react';
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
              <Popup minWidth={230}>
                <div className="p-3">
                  {/* Venue header */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {venueId ? (
                          <Link href={`/venues/${venueId}`} className="block font-black uppercase tracking-wider text-white text-xs leading-tight hover:text-primary transition-colors truncate">
                            {venueName ?? 'Unknown venue'}
                          </Link>
                        ) : (
                          <p className="font-black uppercase tracking-wider text-white text-xs leading-tight truncate">{venueName ?? 'Unknown venue'}</p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">{total} {total === 1 ? 'score' : 'scores'}</p>
                    </div>
                  </div>

                  {/* Most recent score */}
                  {recent && (
                    <div className="pt-2 border-t border-white/10">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Most recent</p>
                      <div className="flex items-center gap-2 mb-1">
                        {recent.machineImageUrl && (
                          <img src={recent.machineImageUrl} alt={recent.machineName} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-white/10" />
                        )}
                        <div className="min-w-0">
                          <Link href={`/machines/${encodeURIComponent(recent.machineName)}`} className="block text-sm font-black uppercase tracking-wider text-primary hover:opacity-80 transition-opacity truncate leading-tight">
                            {recent.machineName}
                          </Link>
                          <p className="text-xl font-bold text-primary mt-0.5">{Number(recent.score).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5 mt-1">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <User className="w-3 h-3 flex-shrink-0" />
                          <span>@{recent.username}</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3 flex-shrink-0" />
                          <span>{format(new Date(recent.playedAt), 'M/d/yy · h:mm a')}</span>
                        </div>
                      </div>
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
