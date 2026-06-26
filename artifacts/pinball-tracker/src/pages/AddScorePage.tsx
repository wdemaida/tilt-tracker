import { useState, useRef, useMemo, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Camera, Loader2, CheckCircle2, ExternalLink, MapPin, Search, X, ChevronDown } from 'lucide-react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { PinballIcon } from '../components/PinballIcon';

const schema = z.object({
  machineName: z.string().min(1, 'Required'),
  score: z.coerce.number().positive('Must be positive'),
  playedAt: z.string().min(1, 'Required'),
  type: z.enum(['casual', 'tournament']),
  venueName: z.string().optional(),
});

type FormData = z.infer<typeof schema>;
type Step = 1 | 2 | 3 | 4;

interface SelectedVenue {
  venueId?: number;
  hereId?: string;
  address?: string;
  venueLat?: number;
  venueLng?: number;
  pinballMapId?: number;
}

interface SavedScore {
  id: number;
  venueId: number | null;
  machineName: string;
  score: number;
}

export default function AddScorePage() {
  const [step, setStep] = useState<Step>(1);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [nearbyVenues, setNearbyVenues] = useState<Array<{
    name: string; address: string; distance: number;
    hereId: string | null; source: 'history' | 'here';
    venueId?: number; venueLat?: number; venueLng?: number; pinballMapId?: number;
  }>>([]);
  const [selectedVenue, setSelectedVenue] = useState<SelectedVenue | null>(null);
  const [gps, setGps] = useState<{ latitude: number; longitude: number } | null>(null);
  const [venueSearch, setVenueSearch] = useState('');
  const [machineSearch, setMachineSearch] = useState('');
  const [selectedMachine, setSelectedMachine] = useState('');
  const [aiDetectedMachine, setAiDetectedMachine] = useState('');
  const [selectedMachineExtra, setSelectedMachineExtra] = useState<{ manufacturer?: string; year?: number } | null>(null);
  const [scoreDisplay, setScoreDisplay] = useState('');
  const [savedScore, setSavedScore] = useState<SavedScore | null>(null);
  const [pmEmail, setPmEmail] = useState('');
  const [pmPassword, setPmPassword] = useState('');
  const [pmSubmitting, setPmSubmitting] = useState(false);
  const [pmResult, setPmResult] = useState<'success' | 'error' | null>(null);
  const [pmError, setPmError] = useState('');
  const [pmForceForm, setPmForceForm] = useState(false);
  const [pmLoginExpanded, setPmLoginExpanded] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [showMachineConfirm, setShowMachineConfirm] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<FormData | null>(null);
  const thumbnailSucceeded = useRef(false);
  const machineAutoSelected = useRef(false);
  const [, navigate] = useLocation();
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);

  function resizeImage(src: string, maxPx = 160): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxPx / img.width, maxPx / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.65));
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  function generateThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      resizeImage(url).then(data => { URL.revokeObjectURL(url); resolve(data); })
        .catch(() => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); });
    });
  }

  // Current user's venues (for V tag)
  const { data: venueHistory = [] } = useQuery({
    queryKey: ['venues', 'mine'],
    queryFn: () => api.venues.list(true),
  });

  const myVenueIds = useMemo(
    () => new Set((venueHistory as any[]).map((v: any) => v.id)),
    [venueHistory]
  );

  // PM machines at selected venue (starts fetching as soon as venue is selected)
  const { data: venueData, isLoading: venueDataLoading } = useQuery({
    queryKey: ['venue-machines', selectedVenue?.venueId],
    queryFn: () => api.venues.machines(selectedVenue!.venueId!),
    enabled: selectedVenue?.venueId != null && selectedVenue?.pinballMapId != null,
  });

  // Fallback: load PM machines by pinballMapId when the venue isn't in our DB yet
  const { data: pmOnlyData, isLoading: pmOnlyLoading } = useQuery({
    queryKey: ['pm-only-machines', selectedVenue?.pinballMapId],
    queryFn: () => api.venues.pmMachines(selectedVenue!.pinballMapId!),
    enabled: selectedVenue?.venueId == null && selectedVenue?.pinballMapId != null,
  });

  // Deduplicated machine list: user's played machines first, then unplayed PM machines
  const allVenueMachines = useMemo(() => {
    if (venueData) {
      const ownNames = new Set((venueData.ownMachines as any[]).map((m: any) => m.name.toLowerCase()));
      const ttNames = new Set(((venueData.ttMachineNames as string[]) ?? []).map((n: string) => n.toLowerCase()));
      return [
        ...(venueData.ownMachines as any[]).map((m: any) => ({
          name: m.name as string, played: true, playCount: m.playCount as number, inTiltTrack: true,
          manufacturer: undefined as string | undefined, year: undefined as number | undefined,
        })),
        ...(venueData.pmMachines as any[])
          .filter((m: any) => !ownNames.has(m.name.toLowerCase()))
          .map((m: any) => ({
            name: m.name as string, played: false, playCount: 0,
            inTiltTrack: ttNames.has(m.name.toLowerCase()),
            manufacturer: m.manufacturer as string | undefined, year: m.year as number | undefined,
          })),
      ];
    }
    if (pmOnlyData) {
      return (pmOnlyData.pmMachines as any[]).map((m: any) => ({
        name: m.name as string, played: false, playCount: 0, inTiltTrack: false,
        manufacturer: m.manufacturer as string | undefined, year: m.year as number | undefined,
      }));
    }
    return [];
  }, [venueData, pmOnlyData]);

  // Auto-select once PM data loads if the AI-detected name is an exact match
  useEffect(() => {
    if (machineAutoSelected.current || !aiDetectedMachine || allVenueMachines.length === 0) return;
    const match = allVenueMachines.find(m => m.name.toLowerCase() === aiDetectedMachine.toLowerCase());
    if (match) {
      setSelectedMachine(match.name);
      setMachineSearch(match.name);
      setValue('machineName', match.name);
      if (match.manufacturer || match.year) setSelectedMachineExtra({ manufacturer: match.manufacturer, year: match.year });
      machineAutoSelected.current = true;
    }
  }, [allVenueMachines, aiDetectedMachine]);

  const filteredVenueMachines = useMemo(() => {
    if (!machineSearch) return allVenueMachines;
    return allVenueMachines.filter(m => m.name.toLowerCase().includes(machineSearch.toLowerCase()));
  }, [allVenueMachines, machineSearch]);

  // Fallback machine search (used when no PM machine data available)
  const { data: machineSuggestions = [] } = useQuery({
    queryKey: ['machine-search', machineSearch],
    queryFn: () => api.machines.search(machineSearch),
    enabled: allVenueMachines.length === 0 && !venueDataLoading && !pmOnlyLoading && machineSearch.length > 1,
  });

  // Filtered venue history for step 2 (user's venues only)
  const filteredVenueHistory = useMemo(() => {
    const q = venueSearch.toLowerCase();
    return (venueHistory as any[]).filter(
      (v: any) => !q || v.name.toLowerCase().includes(q) || (v.address ?? '').toLowerCase().includes(q)
    );
  }, [venueHistory, venueSearch]);

  const canPostToPm = savedScore?.venueId != null && selectedVenue?.pinballMapId != null;

  const { data: pmTokenData } = useQuery({
    queryKey: ['pm-token'],
    queryFn: () => api.pinballmap.getToken(),
    enabled: step === 4 && canPostToPm,
    staleTime: Infinity,
  });

  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'casual', playedAt: new Date().toISOString().slice(0, 16) },
  });

  const venueName = watch('venueName');

  // True when the effective machine name (selected or AI-detected) isn't in the PM list for this venue
  const effectiveMachineName = selectedMachine || aiDetectedMachine;
  const machineNotInPm = effectiveMachineName.length > 0
    && allVenueMachines.length > 0
    && !allVenueMachines.some(m => m.name.toLowerCase() === effectiveMachineName.toLowerCase());

  const createScore = useMutation({
    mutationFn: async (data: FormData) => {
      const machine = await api.machines.upsert({ name: data.machineName, ...selectedMachineExtra });
      return api.scores.create({
        ...data,
        machineId: machine.id,
        ...gps,
        venueId: selectedVenue?.venueId,
        venueHereId: selectedVenue?.hereId,
        venueAddress: selectedVenue?.address,
        venueLat: selectedVenue?.venueLat,
        venueLng: selectedVenue?.venueLng,
        venuePinballMapId: selectedVenue?.pinballMapId,
        photoThumbnail: thumbnail ?? undefined,
      });
    },
    onSuccess: (row, data) => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      setSavedScore({ id: row.id, venueId: row.venueId, machineName: data.machineName, score: data.score });
      setStep(4);
    },
    onError: (err: any) => {
      console.error('Save score failed:', err);
    },
  });

  const handlePhoto = async (file: File) => {
    setAiLoading(true);
    setAiError('');
    thumbnailSucceeded.current = false;
    generateThumbnail(file).then(t => { setThumbnail(t); thumbnailSucceeded.current = true; }).catch(() => {});
    try {
      const result = await api.upload(file);
      if (result.machineName) {
        setValue('machineName', result.machineName);
        setMachineSearch(result.machineName);
        setAiDetectedMachine(result.machineName);
        // Don't pre-select — auto-select handles exact PM matches; banner guides the rest
      }
      if (result.score) {
        setValue('score', result.score);
        setScoreDisplay(Number(result.score).toLocaleString());
      }
      if (result.playedAt) setValue('playedAt', new Date(result.playedAt).toISOString().slice(0, 16));
      if (result.latitude != null && result.longitude != null) {
        setGps({ latitude: result.latitude, longitude: result.longitude });
      }
      if (result.thumbnailBase64 && !thumbnailSucceeded.current) {
        resizeImage(result.thumbnailBase64).then(setThumbnail).catch(() => setThumbnail(result.thumbnailBase64));
      }
      if (result.venues?.length) {
        const first = result.venues[0];
        setValue('venueName', first.name);
        setSelectedVenue({
          venueId: first.venueId,
          hereId: first.hereId ?? undefined,
          address: first.address,
          venueLat: first.venueLat,
          venueLng: first.venueLng,
          pinballMapId: first.pinballMapId,
        });
        setNearbyVenues(result.venues);
      }
      setStep(2);
    } catch (err: any) {
      setAiError(err?.message ?? 'AI extraction failed — enter details manually');
      setStep(2);
    } finally {
      setAiLoading(false);
    }
  };

  function selectVenueCard(v: { id?: number; name: string; address?: string | null; hereId?: string | null; venueLat?: number; venueLng?: number; pinballMapId?: number | null }) {
    setValue('venueName', v.name);
    setVenueSearch(v.name);
    setSelectedVenue({
      venueId: v.id,
      hereId: v.hereId ?? undefined,
      address: v.address ?? undefined,
      venueLat: v.venueLat,
      venueLng: v.venueLng,
      pinballMapId: v.pinballMapId ?? undefined,
    });
  }

  function selectMachine(name: string, manufacturer?: string, year?: number) {
    setSelectedMachine(name);
    setMachineSearch(name);
    setValue('machineName', name);
    setSelectedMachineExtra(manufacturer || year ? { manufacturer, year } : null);
  }

  const pmUseStored = !pmForceForm && !!pmTokenData?.hasToken;

  const handlePmSubmit = async () => {
    if (!savedScore) return;
    if (!pmUseStored && (!pmEmail || !pmPassword)) return;
    setPmSubmitting(true);
    setPmResult(null);
    setPmError('');
    try {
      if (!pmUseStored) await api.pinballmap.auth(pmEmail, pmPassword);
      await api.pinballmap.submitScore({
        venueId: savedScore.venueId!,
        machineName: savedScore.machineName,
        score: savedScore.score,
      });
      setPmResult('success');
    } catch (err: any) {
      if (err?.code === 'PM_TOKEN_EXPIRED') {
        setPmForceForm(true);
        setPmError('Session expired — please re-enter your Pinball Map credentials');
      } else {
        setPmResult('error');
        setPmError(err?.message ?? 'Submission failed');
      }
    } finally {
      setPmSubmitting(false);
    }
  };

  // Badge components for venue tags
  const TagTT = () => <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">TT</span>;
  const TagV = () => <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 font-medium">V</span>;
  const TagPM = () => <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 font-medium">PM</span>;

  return (
    <div className="max-w-lg mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-3 mb-8">
        {([1, 2, 3, 4] as Step[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${
              s === step ? 'border-primary text-primary' : s < step ? 'border-primary/40 bg-primary/10 text-primary/60' : 'border-white/20 text-muted-foreground'
            }`}>{s}</div>
            {s < 4 && <div className="w-8 h-0.5 bg-white/10" />}
          </div>
        ))}
      </div>

      {/* Step 1: Photo upload */}
      {step === 1 && (
        <div className="rounded-xl border border-white/10 bg-card p-8 flex flex-col items-center gap-6">
          <h2 className="text-2xl font-black uppercase tracking-widest text-white">Upload Evidence</h2>
          <p className="text-sm text-muted-foreground text-center">
            Snap a pic of the DMD or score screen. Our AI will extract the machine name, score, time, and location.
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={aiLoading}
            className="w-full rounded-xl border-2 border-dashed border-primary/50 p-12 flex flex-col items-center gap-3 hover:border-primary transition-colors disabled:opacity-50"
          >
            {aiLoading ? <Loader2 className="w-12 h-12 text-primary animate-spin" /> : <Camera className="w-12 h-12 text-primary" />}
            <span className="font-black uppercase tracking-wider text-white">
              {aiLoading ? 'Analyzing...' : 'Tap to Take Photo'}
            </span>
            {!aiLoading && <span className="text-xs text-muted-foreground">or choose from camera roll</span>}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handlePhoto(f); }} />
          <button onClick={() => setStep(2)} className="text-sm text-muted-foreground hover:text-white transition-colors uppercase tracking-wider">
            Skip AI & Enter Manually ›
          </button>
        </div>
      )}

      {/* Step 2: Venue */}
      {step === 2 && (
        <div className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-4">
          <h2 className="text-xl font-black uppercase tracking-widest text-white mb-2">Where Did You Play?</h2>
          {aiError && <p className="text-xs text-yellow-400 -mt-1">{aiError}</p>}

          <div className="relative">
            {!venueSearch && <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />}
            <input
              value={venueSearch}
              onChange={e => {
                setVenueSearch(e.target.value);
                setValue('venueName', e.target.value);
                setSelectedVenue(null);
              }}
              placeholder="Search or enter venue name..."
              className={`input ${venueSearch ? 'pr-8' : 'pl-9'}`}
            />
            {venueSearch && (
              <button
                type="button"
                onClick={() => { setVenueSearch(''); setValue('venueName', ''); setSelectedVenue(null); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Nearby venues from AI photo */}
          {nearbyVenues.filter(v => !venueSearch || v.name.toLowerCase().includes(venueSearch.toLowerCase())).length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Nearby</p>
              <div className="flex flex-col gap-1.5">
                {nearbyVenues
                  .filter(v => !venueSearch || v.name.toLowerCase().includes(venueSearch.toLowerCase()))
                  .map(v => {
                    const isSelected = selectedVenue?.venueId != null
                      ? selectedVenue.venueId === v.venueId
                      : selectedVenue?.hereId != null && selectedVenue.hereId === v.hereId;
                    const userVisited = v.venueId != null && myVenueIds.has(v.venueId);
                    const inSystem = v.source === 'history';
                    return (
                      <button
                        key={v.venueId ?? v.hereId ?? v.name}
                        type="button"
                        onClick={() => selectVenueCard({ id: v.venueId, name: v.name, address: v.address, hereId: v.hereId, venueLat: v.venueLat, venueLng: v.venueLng, pinballMapId: v.pinballMapId })}
                        className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-primary/60 bg-primary/10' : 'border-white/10 hover:border-primary/40 hover:bg-white/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                          <span className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-white/80'}`}>{v.name}</span>
                          {userVisited ? <TagV /> : inSystem ? <TagTT /> : null}
                          {v.pinballMapId && <TagPM />}
                          <span className="text-xs text-muted-foreground ml-auto">{v.distance}m</span>
                        </div>
                        {v.address && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-5">{v.address}</p>}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Venue history (user's visited venues only) */}
          {(() => {
            const nearbyIds = new Set(nearbyVenues.map(v => v.venueId).filter(Boolean));
            const historyToShow = filteredVenueHistory.filter((v: any) => !nearbyIds.has(v.id));
            if (historyToShow.length === 0) return null;
            return (
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
                  {nearbyVenues.length > 0 ? 'Your Other Venues' : 'Your Venues'}
                </p>
                <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
                  {historyToShow.map((v: any) => {
                    const isSelected = selectedVenue?.venueId === v.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => selectVenueCard(v)}
                        className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-primary/60 bg-primary/10' : 'border-white/10 hover:border-primary/40 hover:bg-white/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                          <span className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-white/80'}`}>{v.name}</span>
                          <TagV />
                          {v.pinballMapId && <TagPM />}
                          <span className="text-xs text-muted-foreground ml-auto">{v.scoreCount} {v.scoreCount === 1 ? 'score' : 'scores'}</span>
                        </div>
                        {v.address && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-5">{v.address}</p>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {filteredVenueHistory.length === 0 && nearbyVenues.length === 0 && !venueSearch && (
            <p className="text-sm text-muted-foreground text-center py-2">Type a venue name above to add a new one</p>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setStep(1)}
              className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
              Back
            </button>
            <button type="button" onClick={() => setStep(3)}
              className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity">
              Continue
            </button>
          </div>
          <button
            type="button"
            onClick={() => { setSelectedVenue(null); setValue('venueName', ''); setVenueSearch(''); setStep(3); }}
            className="text-xs text-muted-foreground hover:text-white transition-colors text-center"
          >
            Skip — no venue
          </button>
          {/* Tag legend */}
          <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground pt-1">
            <span className="flex items-center gap-1"><TagTT /> In TiltTrack</span>
            <span className="flex items-center gap-1"><TagPM /> In Pinball Map</span>
            <span className="flex items-center gap-1"><TagV /> You've visited</span>
          </div>
        </div>
      )}

      {/* Step 3: Score details */}
      {step === 3 && (
        <form onSubmit={handleSubmit(d => {
          if (machineNotInPm) {
            setPendingFormData(d);
            setShowMachineConfirm(true);
            return;
          }
          createScore.mutate(d);
        })} className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-4">
          {createScore.isError && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {(createScore.error as any)?.message ?? 'Failed to save score — please try again'}
            </div>
          )}
          <div>
            <h2 className="text-xl font-black uppercase tracking-widest text-white">Score Details</h2>
            {venueName && (
              <div className="flex items-center gap-1.5 mt-1">
                <MapPin className="w-3 h-3 text-primary flex-shrink-0" />
                <p className="text-sm text-primary font-medium truncate">{venueName}</p>
              </div>
            )}
          </div>

          {/* Machine */}
          <div>
            <label className="label">Machine</label>

            {allVenueMachines.length > 0 || venueDataLoading || pmOnlyLoading ? (
              <div className="flex flex-col gap-2">

                {/* AI detection context — shown when AI found a name but no exact PM match yet */}
                {aiDetectedMachine && !selectedMachine && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-sm">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-400 whitespace-nowrap">AI read</span>
                    <span className="text-white/80 font-medium truncate">"{aiDetectedMachine}"</span>
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">select version below</span>
                  </div>
                )}

                <div className="relative">
                  {!machineSearch && <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />}
                  <input
                    value={machineSearch}
                    onChange={e => {
                      const val = e.target.value;
                      setMachineSearch(val);
                      setValue('machineName', val);
                      if (selectedMachine && val.toLowerCase() !== selectedMachine.toLowerCase()) setSelectedMachine('');
                    }}
                    placeholder="Filter or type machine name..."
                    className={`input ${machineSearch ? 'pr-8' : 'pl-9'}`}
                  />
                  {machineSearch && (
                    <button
                      type="button"
                      onClick={() => { setMachineSearch(''); setValue('machineName', ''); setSelectedMachine(''); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {venueDataLoading || pmOnlyLoading ? (
                  <div className="flex items-center gap-2 py-3 px-1 text-muted-foreground text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading machines at this venue...
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto pr-1">
                    {filteredVenueMachines.map(m => {
                      const isSelected = selectedMachine === m.name;
                      return (
                        <button
                          key={m.name}
                          type="button"
                          onClick={() => selectMachine(m.name, m.manufacturer, m.year)}
                          className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-primary/60 bg-primary/10' : 'border-white/10 hover:border-primary/40 hover:bg-white/5'}`}
                        >
                          <div className="flex items-center gap-2">
                            <PinballIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                            <span className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-white/80'}`}>{m.name}</span>
                            {m.inTiltTrack && !m.played && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">TT</span>
                            )}
                            {m.played && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium ml-auto">
                                {m.playCount} {m.playCount === 1 ? 'play' : 'plays'}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                    {filteredVenueMachines.length === 0 && machineSearch && (
                      <button
                        type="button"
                        onClick={() => selectMachine(machineSearch)}
                        className="text-left px-3 py-2.5 rounded-lg border border-dashed border-white/20 hover:border-primary/40 text-sm text-muted-foreground hover:text-white transition-colors"
                      >
                        Add "{machineSearch}" as new machine
                      </button>
                    )}
                  </div>
                )}

                {/* Use AI name directly — only when banner is showing and list has loaded */}
                {aiDetectedMachine && !selectedMachine && !venueDataLoading && !pmOnlyLoading && allVenueMachines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => selectMachine(aiDetectedMachine)}
                    className="text-xs text-center text-muted-foreground hover:text-white/70 transition-colors py-0.5"
                  >
                    Use "{aiDetectedMachine}" directly →
                  </button>
                )}
              </div>
            ) : (
              /* Fallback: free-text search when no PM data */
              <div>
                <input
                  value={machineSearch}
                  onChange={e => { setMachineSearch(e.target.value); setValue('machineName', e.target.value); setSelectedMachine(''); }}
                  placeholder="e.g. The Munsters"
                  className="input"
                />
                {(machineSuggestions as any[]).length > 0 && machineSearch && !selectedMachine && (
                  <div className="mt-1 rounded-lg border border-white/10 bg-background overflow-hidden">
                    <p className="px-4 pt-2.5 pb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Did you mean?</p>
                    {(machineSuggestions as any[]).slice(0, 5).map((s: any) => (
                      <button key={s.id} type="button" onClick={() => selectMachine(s.name)}
                        className="w-full text-left px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors">
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {errors.machineName && <p className="err">{errors.machineName.message}</p>}
            {machineNotInPm && (
              <p className="text-xs text-yellow-400 mt-1">
                "{effectiveMachineName}" wasn't found in the Pinball Map machine list for this venue — you'll be asked to confirm before saving.
              </p>
            )}
          </div>

          {/* Score */}
          <div>
            <label className="label">Score</label>
            <input
              type="text"
              inputMode="numeric"
              value={scoreDisplay}
              onChange={e => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setScoreDisplay(raw ? Number(raw).toLocaleString() : '');
                setValue('score', raw ? Number(raw) : ('' as any));
              }}
              placeholder="e.g. 21,955,670"
              className="input"
            />
            {errors.score && <p className="err">{errors.score.message}</p>}
          </div>

          {/* Date & Time */}
          <div>
            <label className="label">Date & Time</label>
            <input {...register('playedAt')} type="datetime-local" className="input" />
          </div>

          {/* Type */}
          <div>
            <label className="label">Type</label>
            <select {...register('type')} className="input">
              <option value="casual">Casual</option>
              <option value="tournament">Tournament</option>
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setStep(2)}
              className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
              Back
            </button>
            <button type="submit" disabled={isSubmitting || createScore.isPending}
              className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
              {createScore.isPending ? 'Saving...' : 'Save Score'}
            </button>
          </div>
        </form>
      )}

      {/* Machine name confirmation dialog */}
      {showMachineConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowMachineConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
            <h3 className="text-lg font-black uppercase tracking-wider text-white mb-2">Machine Not Found</h3>
            <p className="text-sm text-muted-foreground mb-5">
              "{effectiveMachineName}" wasn't found in the Pinball Map machine list for this venue. Continue anyway?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { setShowMachineConfirm(false); if (pendingFormData) createScore.mutate(pendingFormData); }}
                className="py-2.5 rounded-lg bg-primary text-white font-bold text-sm uppercase tracking-wider hover:opacity-90 transition-opacity"
              >
                Yes, Save Score Anyway
              </button>
              <button
                onClick={() => { setShowMachineConfirm(false); setPendingFormData(null); }}
                className="py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors"
              >
                No, I'll Update It
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: Success + Pinball Map post */}
      {step === 4 && savedScore && (
        <div className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-5">
          <div className="flex flex-col items-center gap-3 py-2">
            <CheckCircle2 className="w-12 h-12 text-green-400" />
            <h2 className="text-2xl font-black uppercase tracking-widest text-white">Score Saved!</h2>
            <div className="text-center">
              <p className="text-sm text-muted-foreground">{savedScore.machineName}</p>
              <p className="text-3xl font-bold text-primary">{Number(savedScore.score).toLocaleString()}</p>
            </div>
          </div>

          {canPostToPm && (
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <ExternalLink className="w-4 h-4 text-violet-400" />
                <p className="text-sm font-bold text-violet-300 uppercase tracking-wider">Post to Pinball Map</p>
              </div>

              {pmResult === 'success' ? (
                <div className="flex items-center gap-2 text-green-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-sm font-medium">Score posted to Pinball Map!</span>
                </div>
              ) : pmUseStored ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Posting as <span className="text-violet-300 font-medium">@{pmTokenData!.pmUsername}</span>
                  </p>
                  {pmError && <p className="text-xs text-red-400">{pmError}</p>}
                  <div className="flex items-center gap-3">
                    <button onClick={handlePmSubmit} disabled={pmSubmitting}
                      className="flex-1 py-2.5 rounded-lg bg-violet-600 text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
                      {pmSubmitting ? 'Posting...' : 'Post Score'}
                    </button>
                    <button onClick={() => setPmForceForm(true)} className="text-xs text-muted-foreground hover:text-white transition-colors">
                      Use different account
                    </button>
                  </div>
                </>
              ) : !pmLoginExpanded ? (
                <button
                  onClick={() => setPmLoginExpanded(true)}
                  className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 transition-colors self-start"
                >
                  <ChevronDown className="w-4 h-4" />
                  Log in to post score
                </button>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <input type="email" placeholder="Pinball Map email" value={pmEmail} onChange={e => setPmEmail(e.target.value)} className="input" />
                    <input type="password" placeholder="Pinball Map password" value={pmPassword} onChange={e => setPmPassword(e.target.value)} className="input" />
                  </div>
                  {(pmResult === 'error' || pmError) && <p className="text-xs text-red-400">{pmError}</p>}
                  <button onClick={handlePmSubmit} disabled={pmSubmitting || !pmEmail || !pmPassword}
                    className="py-2.5 rounded-lg bg-violet-600 text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
                    {pmSubmitting ? 'Posting...' : 'Post Score'}
                  </button>
                </>
              )}
            </div>
          )}

          <button onClick={() => navigate('/')}
            className="py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
            Done
          </button>
        </div>
      )}

      <style>{`
        .label { display: block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: hsl(var(--muted-foreground)); margin-bottom: 0.375rem; }
        .input { width: 100%; border-radius: 0.5rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); padding: 0.625rem 1rem; font-size: 0.875rem; color: white; outline: none; }
        .input:focus { border-color: hsl(var(--primary) / 0.5); }
        .err { font-size: 0.75rem; color: #f87171; margin-top: 0.25rem; }
      `}</style>
    </div>
  );
}
