import { useState, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Camera, Loader2, CheckCircle2, ExternalLink, AlertTriangle } from 'lucide-react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';

const VARIANT_RE = /\s*\((Pro|Premium(?:\s+Plus)?|LE|Limited Edition|SE|Vault Edition|Home Edition|Topper Edition)\)\s*$/i;
function stripVariant(name: string) { return name.replace(VARIANT_RE, '').trim(); }
function getVariant(name: string) { return (name.match(VARIANT_RE) ?? [])[1] ?? null; }

const schema = z.object({
  machineName: z.string().min(1, 'Required'),
  score: z.coerce.number().positive('Must be positive'),
  playedAt: z.string().min(1, 'Required'),
  type: z.enum(['casual', 'tournament']),
  venueName: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

type Step = 1 | 2 | 3;

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
  const [machineSearch, setMachineSearch] = useState('');
  const [scoreDisplay, setScoreDisplay] = useState('');
  const [savedScore, setSavedScore] = useState<SavedScore | null>(null);
  const [pmEmail, setPmEmail] = useState('');
  const [pmPassword, setPmPassword] = useState('');
  const [pmSubmitting, setPmSubmitting] = useState(false);
  const [pmResult, setPmResult] = useState<'success' | 'error' | null>(null);
  const [pmError, setPmError] = useState('');
  const [pmForceForm, setPmForceForm] = useState(false);
  const [mismatchDismissed, setMismatchDismissed] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);

  function generateThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 160;
        const ratio = Math.min(MAX / img.width, MAX / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.65));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  const { data: suggestions = [] } = useQuery({
    queryKey: ['machine-search', machineSearch],
    queryFn: () => api.machines.search(machineSearch),
    enabled: machineSearch.length > 1,
  });

  // Fetch PM machines at the selected venue to detect Pro/Premium mismatches
  const { data: venueData } = useQuery({
    queryKey: ['venue-machines', selectedVenue?.venueId],
    queryFn: () => api.venues.machines(selectedVenue!.venueId!),
    enabled: selectedVenue?.venueId != null && selectedVenue?.pinballMapId != null,
  });

  const canPostToPm = savedScore?.venueId != null && selectedVenue?.pinballMapId != null;

  // Check if the user has a stored PM token (only needed once we reach step 3)
  const { data: pmTokenData } = useQuery({
    queryKey: ['pm-token'],
    queryFn: () => api.pinballmap.getToken(),
    enabled: step === 3 && canPostToPm,
    staleTime: Infinity,
  });

  const pmMismatch = useMemo(() => {
    if (!machineSearch || machineSearch === mismatchDismissed) return null;
    const pmMachines: any[] = venueData?.pmMachines ?? [];
    if (!pmMachines.length) return null;
    const userBase = stripVariant(machineSearch).toLowerCase();
    const match = pmMachines.find((m: any) => {
      const pmBase = stripVariant(m.name).toLowerCase();
      return pmBase === userBase || pmBase.includes(userBase) || userBase.includes(pmBase);
    });
    if (!match) return null;
    if (match.name.toLowerCase() === machineSearch.toLowerCase()) return null;
    return match as { name: string; manufacturer?: string; year?: number };
  }, [machineSearch, venueData, mismatchDismissed]);

  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'casual', playedAt: new Date().toISOString().slice(0, 16) },
  });

  const createScore = useMutation({
    mutationFn: async (data: FormData) => {
      const machine = await api.machines.upsert({ name: data.machineName });
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
      setStep(3);
    },
  });

  const handlePhoto = async (file: File) => {
    setAiLoading(true);
    setAiError('');
    generateThumbnail(file).then(setThumbnail).catch(() => {});
    try {
      const result = await api.upload(file);
      if (result.machineName) { setValue('machineName', result.machineName); setMachineSearch(result.machineName); }
      if (result.score) {
        setValue('score', result.score);
        setScoreDisplay(Number(result.score).toLocaleString());
      }
      if (result.playedAt) setValue('playedAt', new Date(result.playedAt).toISOString().slice(0, 16));
      if (result.latitude != null && result.longitude != null) {
        setGps({ latitude: result.latitude, longitude: result.longitude });
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

  const pmUseStored = !pmForceForm && !!pmTokenData?.hasToken;

  const handlePmSubmit = async () => {
    if (!savedScore) return;
    if (!pmUseStored && (!pmEmail || !pmPassword)) return;
    setPmSubmitting(true);
    setPmResult(null);
    setPmError('');
    try {
      if (!pmUseStored) {
        await api.pinballmap.auth(pmEmail, pmPassword);
      }
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

  return (
    <div className="max-w-lg mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-4 mb-8">
        {([1, 2, 3] as Step[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${
              s === step ? 'border-primary text-primary' : s < step ? 'border-primary/40 bg-primary/10 text-primary/60' : 'border-white/20 text-muted-foreground'
            }`}>{s}</div>
            {s < 3 && <div className="w-12 h-0.5 bg-white/10" />}
          </div>
        ))}
      </div>

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
            {aiLoading ? (
              <Loader2 className="w-12 h-12 text-primary animate-spin" />
            ) : (
              <Camera className="w-12 h-12 text-primary" />
            )}
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

      {step === 2 && (
        <form onSubmit={handleSubmit(d => createScore.mutate(d))} className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-4">
          <h2 className="text-xl font-black uppercase tracking-widest text-white mb-2">Confirm Details</h2>
          {aiError && <p className="text-xs text-yellow-400 -mt-1">{aiError}</p>}

          <div>
            <label className="label">Machine Name</label>
            <input
              {...register('machineName')}
              value={machineSearch}
              onChange={e => { setMachineSearch(e.target.value); setValue('machineName', e.target.value); }}
              placeholder="e.g. The Munsters"
              className="input"
            />
            {suggestions.length > 0 && machineSearch && (
              <div className="mt-1 rounded-lg border border-white/10 bg-background overflow-hidden">
                {suggestions.slice(0, 5).map((s: any) => (
                  <button key={s.id} type="button" onClick={() => { setValue('machineName', s.name); setMachineSearch(s.name); }}
                    className="w-full text-left px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors">
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            {errors.machineName && <p className="err">{errors.machineName.message}</p>}

            {pmMismatch && (
              <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <p className="text-xs font-bold text-amber-300 uppercase tracking-wider">Heads up</p>
                </div>
                <p className="text-xs text-white">
                  Pinball Map lists this machine as <strong>{pmMismatch.name}</strong> at this venue
                  {pmMismatch.manufacturer && ` (${pmMismatch.manufacturer}${pmMismatch.year ? `, ${pmMismatch.year}` : ''})`}.
                  Is that the cabinet you played?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setValue('machineName', pmMismatch.name); setMachineSearch(pmMismatch.name); setMismatchDismissed(pmMismatch.name); }}
                    className="flex-1 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-xs font-bold text-amber-300 hover:bg-amber-500/30 transition-colors"
                  >
                    Yes — switch to {getVariant(pmMismatch.name) ?? pmMismatch.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMismatchDismissed(machineSearch)}
                    className="px-3 py-1.5 rounded-lg border border-white/10 text-xs text-muted-foreground hover:text-white transition-colors"
                  >
                    No, keep {getVariant(machineSearch) ?? 'mine'}
                  </button>
                </div>
              </div>
            )}
          </div>

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

          <div>
            <label className="label">Date & Time</label>
            <input {...register('playedAt')} type="datetime-local" className="input" />
          </div>

          <div>
            <label className="label">Type</label>
            <select {...register('type')} className="input">
              <option value="casual">Casual</option>
              <option value="tournament">Tournament</option>
            </select>
          </div>

          <div>
            <label className="label">Venue (optional)</label>
            <input {...register('venueName')} placeholder="e.g. Pastime Pinball" className="input"
              onChange={e => { register('venueName').onChange(e); setSelectedVenue(null); }} />
            {nearbyVenues.length > 1 && (
              <div className="mt-2">
                <p className="text-xs text-muted-foreground mb-1.5">Nearby venues — tap to select:</p>
                <div className="flex flex-col gap-1">
                  {nearbyVenues.map(v => (
                    <button
                      key={v.venueId ?? v.hereId ?? v.name}
                      type="button"
                      onClick={() => {
                        setValue('venueName', v.name);
                        setSelectedVenue({
                          venueId: v.venueId,
                          hereId: v.hereId ?? undefined,
                          address: v.address,
                          venueLat: v.venueLat,
                          venueLng: v.venueLng,
                          pinballMapId: v.pinballMapId,
                        });
                      }}
                      className="text-left px-3 py-2 rounded-lg border border-white/10 hover:border-primary/50 hover:bg-primary/10 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white font-medium">{v.name}</span>
                        {v.source === 'history' && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">visited</span>
                        )}
                        {v.pinballMapId && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 font-medium">PM</span>
                        )}
                        <span className="text-xs text-muted-foreground ml-auto">{v.distance}m</span>
                      </div>
                      {v.address && <p className="text-xs text-muted-foreground truncate">{v.address}</p>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {createScore.isError && <p className="err">{(createScore.error as any)?.message}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setStep(1)} className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
              Back
            </button>
            <button type="submit" disabled={isSubmitting || createScore.isPending}
              className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
              {createScore.isPending ? 'Saving...' : 'Save Score'}
            </button>
          </div>
        </form>
      )}

      {step === 3 && savedScore && (
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
              <p className="text-xs text-muted-foreground">Share your score with the Pinball Map community leaderboard.</p>

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
                    <button
                      onClick={handlePmSubmit}
                      disabled={pmSubmitting}
                      className="flex-1 py-2.5 rounded-lg bg-violet-600 text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {pmSubmitting ? 'Posting...' : 'Post Score'}
                    </button>
                    <button
                      onClick={() => setPmForceForm(true)}
                      className="text-xs text-muted-foreground hover:text-white transition-colors"
                    >
                      Use different account
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <input
                      type="email"
                      placeholder="Pinball Map email"
                      value={pmEmail}
                      onChange={e => setPmEmail(e.target.value)}
                      className="input"
                    />
                    <input
                      type="password"
                      placeholder="Pinball Map password"
                      value={pmPassword}
                      onChange={e => setPmPassword(e.target.value)}
                      className="input"
                    />
                  </div>
                  {pmResult === 'error' && <p className="text-xs text-red-400">{pmError}</p>}
                  {pmError && pmResult !== 'error' && <p className="text-xs text-red-400">{pmError}</p>}
                  <button
                    onClick={handlePmSubmit}
                    disabled={pmSubmitting || !pmEmail || !pmPassword}
                    className="py-2.5 rounded-lg bg-violet-600 text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {pmSubmitting ? 'Posting...' : 'Post Score'}
                  </button>
                </>
              )}
            </div>
          )}

          <button
            onClick={() => navigate('/')}
            className="py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors"
          >
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
