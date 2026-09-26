import { useState, useRef, useMemo, useEffect, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Camera, Loader2, CheckCircle2, ExternalLink, MapPin, Search, X, ChevronDown, ChevronLeft, AlertTriangle, Home } from 'lucide-react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { useExactPrivateVenues } from '../lib/useExactPrivateVenues';
import { useVenueSearch, venueMatches, MIN_PLACE_SEARCH_CHARS } from '../lib/venueSearch';
import { queryClient } from '../lib/queryClient';
import { PinballIcon } from '../components/PinballIcon';
import { toLocalInput, localInputToIso, naiveToLocalInput } from '../lib/datetime';
import { prepareUploadImage, type PreparedImage } from '../lib/prepareUploadImage';
import { encodeFullSizePhoto, uploadFullSizePhoto, type EncodedFullPhoto } from '../lib/fullSizePhoto';
import { extractVideoFrames, isVideoFile, VideoFrameError, VIDEO_UNSUPPORTED_MESSAGE } from '../lib/videoFrames';
import { ScoreDigitInput } from '../components/ScoreDigitInput';
import { MissingLocationNotice, type CurrentLocationState } from '../components/MissingLocationNotice';
import {
  describePhotoLocation, detectPlatform, queryGeoPermission, getCurrentPosition, geoFailureMessage, CurrentPositionError,
  type PhotoLocationInfo, type PhotoSource, type GeoPermission,
} from '../lib/photoLocation';
import {
  type ScoreRead, type ScoreDisagreement, checkPlausibility, formatTemplate, hasUnknown, reconcileUserDigits, templateToScore,
  unknownCount, playerLabel, matchPlayerRead, LEADING_AMBIGUOUS_REASON, ALIGNMENT_WARNING,
} from '../lib/scoreTemplate';

const schema = z.object({
  machineName: z.string().min(1, 'Required'),
  score: z.coerce.number().int('Whole numbers only').positive('Must be positive'),
  // x's still unfilled in a partial read (see ScoreDigitInput). Not sent to the server — it's here
  // so saving is blocked by validation, not just by the disabled button.
  scoreUnfilled: z.number().int().superRefine((n, ctx) => {
    if (n > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Fill in every x before saving (${n} left)` });
  }),
  playedAt: z.string().min(1, 'Required'),
  type: z.enum(['casual', 'tournament']),
  venueName: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

/** Photos or videos per upload — each is a separate look at the same display, merged server-side. */
const MAX_ITEMS = 3;

/** One thing the user picked: a photo (one image) or a video (its best few frames). */
interface UploadItem {
  kind: 'photo' | 'video';
  images: PreparedImage[];
  /** Which input it came from — the in-browser camera, or the photo/video picker. */
  source: PhotoSource;
}
type Step = 1 | 2 | 3 | 4;
/** Index into `playerReads`, 'none' for "None of these — type it in", null for not yet chosen. */
type PlayerChoice = number | 'none' | null;

interface SelectedVenue {
  venueId?: number;
  /** For the Pinball Map lookup on pick (a HERE place is matched by its name and coordinates). */
  name?: string;
  hereId?: string;
  address?: string;
  venueLat?: number;
  venueLng?: number;
  pinballMapId?: number;
  /**
   * True when a Pinball Map match was already attempted for this pick — the nearby suggestions
   * (photo GPS / current location) come with it, by the same rule — so a HERE place from that list
   * isn't looked up a second time.
   */
  pmChecked?: boolean;
  /** A private venue: carries no Pinball Map link, so there's nothing to look up. */
  isPrivate?: boolean;
  /** IANA zone. The photo's EXIF wall clock is read in *this*, not the browser's — see below. */
  timezone?: string | null;
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
    timezone?: string | null;
  }>>([]);
  const [selectedVenue, setSelectedVenue] = useState<SelectedVenue | null>(null);
  // The *photo's* GPS. Spread into the saved score, so it must only ever hold what a photo carried —
  // never the device's current position (that lives in `deviceCoords`, used for suggestions only).
  const [gps, setGps] = useState<{ latitude: number; longitude: number } | null>(null);
  // No-GPS fallback: whether the picked photos had location, and the "Use my current location" flow.
  // `deviceCoords` biases venue lookups only; it is never saved on the score. See photoLocation.ts.
  const [photoLocation, setPhotoLocation] = useState<(PhotoLocationInfo & { count: number }) | null>(null);
  const [currentLocation, setCurrentLocation] = useState<CurrentLocationState>({ status: 'idle' });
  const [deviceCoords, setDeviceCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [nearbySource, setNearbySource] = useState<'photo' | 'device'>('photo');
  const [geoPermission, setGeoPermission] = useState<GeoPermission>('unknown');
  // Venue state as of the latest render — both lookups land after an await (see latestScoreRef).
  const latestVenueRef = useRef<{
    selected: SelectedVenue | null; search: string; nearby: unknown[]; source: 'photo' | 'device';
  }>({ selected: null, search: '', nearby: [], source: 'photo' });
  // The venue "Use my current location" pre-selected by itself — not a choice the user made.
  const deviceAutoPickRef = useRef<SelectedVenue | null>(null);
  const platform = useMemo(() => detectPlatform(), []);
  // What the search box shows — the typed text, or the name of the venue picked.
  const [venueSearch, setVenueSearch] = useState('');
  // What the user actually *typed*. The lists filter and the server search on this, so picking a
  // result doesn't narrow the lists to that one name or fire a fresh search for it.
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddVenueForm, setShowAddVenueForm] = useState(false);
  const [newVenueName, setNewVenueName] = useState('');
  const [newVenueAddress, setNewVenueAddress] = useState('');
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [newVenueIsResidence, setNewVenueIsResidence] = useState(false);
  const [newVenuePrivacyTier, setNewVenuePrivacyTier] = useState<'full' | 'city_state' | 'hidden'>('hidden');
  // Existing venues the server matched when it rejected a create as a likely duplicate.
  // Someone's private venue arrives as a name-only `isPrivate` candidate (exact name match, never a
  // location match): loggable like any other, but with no address or distance to show.
  const [venueDuplicates, setVenueDuplicates] = useState<
    Array<{ id: number; name: string; address: string | null; distance: number | null; isPrivate?: true }> | null
  >(null);
  const [machineSearch, setMachineSearch] = useState('');
  const [selectedMachine, setSelectedMachine] = useState('');
  // "Not listed?" under a venue's machine list: type any machine (catalog search) instead.
  const [machineFreeText, setMachineFreeText] = useState(false);
  const [aiDetectedMachine, setAiDetectedMachine] = useState('');
  const [selectedMachineExtra, setSelectedMachineExtra] = useState<{ manufacturer?: string; year?: number } | null>(null);
  const [scoreDisplay, setScoreDisplay] = useState('');
  // The AI's read of the score, including unread positions. `scoreTemplate` is the working copy the
  // user fills in; null means plain-number entry (a complete read, no photo, or the escape hatch).
  const [scoreRead, setScoreRead] = useState<ScoreRead | null>(null);
  const [scoreTemplate, setScoreTemplate] = useState<string | null>(null);
  // Cells where the user's digit was kept over a later photo's different reading.
  const [scoreDisagreements, setScoreDisagreements] = useState<ScoreDisagreement[]>([]);
  // When the only capture time is an *instant* (a video's container time), the form's wall clock is
  // derived from it on the venue's clock — and re-derived if the venue changes — until the user
  // edits the field themselves. See prepareUploadImage.ts `capturedAt`.
  const [playedAtInstant, setPlayedAtInstant] = useState<string | null>(null);
  // The score state as of the latest render — an upload's result lands after an await, and the user
  // may have kept typing while it ran, so reconciliation must not read a stale closure.
  const latestScoreRef = useRef<{
    read: ScoreRead | null; template: string | null; display: string; players: ScoreRead[]; selected: PlayerChoice;
  }>({ read: null, template: null, display: '', players: [], selected: null });
  // Every player display the photos showed (a 4-player backglass has four). With more than one, the
  // user picks theirs ("Which player were you?") and that read becomes `scoreRead`. 'none' = "None
  // of these", typing the score by hand. `choosingPlayer` reopens the picker after a pick.
  const [playerReads, setPlayerReads] = useState<ScoreRead[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerChoice>(null);
  const [choosingPlayer, setChoosingPlayer] = useState(false);
  // Digits typed before an added photo lost track of which player they belonged to (the re-read's
  // displays didn't line up with the old ones). Carried onto whichever player the user picks next,
  // so adding a photo still never throws away what they typed.
  const pendingCarryRef = useRef<{ prevRead: string; prevValue: string } | null>(null);
  const needsPlayerChoice = playerReads.length > 1 && selectedPlayer == null;
  const showPlayerPicker = playerReads.length > 1 && (selectedPlayer == null || choosingPlayer);
  // Object URLs for the larger photo preview shown while filling in x's. Revoked on replace/unmount.
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const photoPreviewsRef = useRef<string[]>([]);
  // Every photo/video read so far (already prepared), so "Add another" can re-read the whole set.
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [videoProgress, setVideoProgress] = useState<string | null>(null);
  const [photoNotice, setPhotoNotice] = useState('');
  const [differentGamesWarning, setDifferentGamesWarning] = useState<string | null>(null);
  const addPhotoRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const addCameraRef = useRef<HTMLInputElement>(null);
  // A set that went up as a server-decoded HEIC can't grow: the multi-image path refuses HEIC.
  const addBlockedByHeic = uploadItems.some(i => i.images.some(im => im.heicFailed));
  const canAddMore = uploadItems.length > 0 && uploadItems.length < MAX_ITEMS && !addBlockedByHeic;
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
  // The image the thumbnail was made from — also the one that becomes the full-size photo once the
  // score saves (fullSizePhoto.ts). Set wherever generateThumbnail is called, so the two never differ.
  const bestImageRef = useRef<PreparedImage | null>(null);
  const fullPhotoEncoded = useRef<EncodedFullPhoto | null>(null);
  const [fullPhoto, setFullPhoto] = useState<{ status: 'idle' | 'working' | 'saved' | 'failed'; message?: string }>({ status: 'idle' });
  const machineAutoSelected = useRef(false);
  const [, navigate] = useLocation();
  const api = useApi();

  // Wizard steps in browser history, so the phone's back gesture steps back through the wizard
  // instead of leaving /add and throwing away the photos, the read and the picked venue. Each
  // forward move to step 2 or 3 pushes an entry (same URL) tagged with its step and how many
  // wizard entries deep it is; popping one just shows that step again, with all state intact.
  // Saving (step 4) unwinds those entries, so back from the success screen leaves /add exactly as
  // it did before — it can never land on the form again and save a duplicate.
  const stepRef = useRef(step);
  const prevStepRef = useRef(step);
  const fromPopRef = useRef(false); // this step change came from a popstate, not from the app
  useEffect(() => {
    // Remounted on an entry an earlier visit tagged (back/forward from another page): the form is
    // fresh, so the tag no longer describes it.
    const st = window.history.state;
    if (st && typeof st === 'object' && 'addScoreStep' in st) {
      const { addScoreStep: _s, addScoreDepth: _d, ...rest } = st;
      window.history.replaceState(rest, '');
    }
    const onPop = (e: PopStateEvent) => {
      // Includes the pop fired by the post-save unwind below.
      if (stepRef.current === 4) return;
      const target = (e.state?.addScoreStep ?? 1) as Step;
      if (target < stepRef.current) {
        fromPopRef.current = true;
        setStep(target);
      } else {
        // Forward, or an entry left over from an earlier pass: keep showing the current step, and
        // re-tag the entry so the history keeps matching what's on screen.
        window.history.replaceState({ ...(e.state ?? {}), addScoreStep: stepRef.current }, '');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    stepRef.current = step;
    if (step === prev) return;
    // A tap near the bottom of a long step shouldn't leave the next one scrolled halfway down.
    window.scrollTo(0, 0);
    if (fromPopRef.current) { fromPopRef.current = false; return; }
    const st = window.history.state ?? {};
    const depth: number = typeof st.addScoreDepth === 'number' ? st.addScoreDepth : 0;
    if (step === 4) {
      if (depth > 0) window.history.go(-depth);
      return;
    }
    if (step > prev) window.history.pushState({ ...st, addScoreStep: step, addScoreDepth: depth + 1 }, '');
  }, [step]);
  /** The visible Back: pops the wizard's own history entry when there is one, so the two stay in step. */
  function goBack() {
    if (step <= 1 || step === 4) return;
    if (window.history.state?.addScoreStep === step) window.history.back();
    else setStep((step - 1) as Step);
  }
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

  /** Picks the image behind the thumbnail (and so the full-size photo). */
  function setBestImage(image: PreparedImage | null) {
    if (bestImageRef.current !== image) fullPhotoEncoded.current = null;
    bestImageRef.current = image;
  }

  /**
   * After the score saves: encode the full-size photo and upload it to R2, in the background. The
   * wizard doesn't wait — step 4 shows a status line, and the upload carries on if the user taps
   * Done. Silent when there's nothing to upload or the server has full-size photos switched off.
   */
  async function runFullPhotoUpload(scoreId: number) {
    if (!bestImageRef.current) return;
    setFullPhoto({ status: 'working' });
    if (!fullPhotoEncoded.current) fullPhotoEncoded.current = await encodeFullSizePhoto(bestImageRef.current);
    const encoded = fullPhotoEncoded.current;
    if (!encoded) return setFullPhoto({ status: 'idle' });
    const result = await uploadFullSizePhoto(api, scoreId, encoded);
    if (result.ok) {
      setFullPhoto({ status: 'saved' });
      queryClient.invalidateQueries({ queryKey: ['scores'] });
    } else {
      setFullPhoto(result.disabled ? { status: 'idle' } : { status: 'failed', message: result.message });
    }
  }

  function generateThumbnail(file: File | Blob): Promise<string> {
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

  // Machines at the selected venue (starts fetching as soon as a venue is selected): its Pinball Map
  // roster, or — for a home venue — the owner-managed inventory. Fetched for any existing venue,
  // since the picker doesn't know which a venue has (a friend's home venue arrives name-only), but
  // only *used* when there's a roster or inventory to show; otherwise the catalog search stays.
  const { data: venueMachinesData, isLoading: venueMachinesLoading } = useQuery({
    queryKey: ['venue-machines', selectedVenue?.venueId],
    queryFn: () => api.venues.machines(selectedVenue!.venueId!),
    enabled: selectedVenue?.venueId != null,
  });

  // A pick with no Pinball Map link yet — a HERE "Places" result, or a TiltTrack venue nobody has
  // linked — is matched to its Pinball Map listing now, once per pick (never per search result), so
  // the machine step can offer what's there. The score POST then stores the link on the venue.
  // No match (or Pinball Map down) leaves everything as it was: catalog search.
  const pmLookup = useMemo(() => {
    const v = selectedVenue;
    if (!v || v.pinballMapId != null || v.isPrivate) return null;
    // By id even for a nearby suggestion: history venues are matched by name only there, and the
    // server answers from the venue's stored link without calling Pinball Map when it has one.
    if (v.venueId != null) return { venueId: v.venueId };
    if (v.pmChecked) return null;
    if (v.venueLat != null && v.venueLng != null && v.name) return { lat: v.venueLat, lng: v.venueLng, name: v.name };
    return null;
  }, [selectedVenue]);
  const { data: pmMatch, isLoading: pmMatchLoading } = useQuery({
    queryKey: ['pm-match', pmLookup],
    queryFn: () => api.venues.pmMatch(pmLookup!),
    enabled: pmLookup != null,
    staleTime: 10 * 60_000,
    retry: false,
  });
  // The venue's own link, else the one just resolved for this pick.
  const effectivePmId = selectedVenue?.pinballMapId ?? (pmLookup ? pmMatch?.pinballMapId ?? undefined : undefined);
  // Resolved here rather than stored on the venue — /venues/:id/machines has no roster for it yet.
  const pmResolvedOnPick = selectedVenue?.pinballMapId == null && effectivePmId != null;

  const hasVenueRoster = effectivePmId != null || (venueMachinesData?.inventory?.machines?.length ?? 0) > 0;
  const venuePayload = hasVenueRoster ? venueMachinesData : undefined;
  const venueDataLoading = (venueMachinesLoading && effectivePmId != null) || pmMatchLoading;

  // PM machines by Pinball Map id when the venue's own payload can't carry them: not in our DB yet,
  // or its link was only just resolved. Read through the server's roster cache (/pm-machines/:pmId).
  const { data: pmOnlyData, isLoading: pmOnlyLoading } = useQuery({
    queryKey: ['pm-only-machines', effectivePmId],
    queryFn: () => api.venues.pmMachines(effectivePmId!),
    enabled: effectivePmId != null && (selectedVenue?.venueId == null || pmResolvedOnPick),
  });
  // A different venue gets its own machine list first, not the previous one's "type it" mode.
  useEffect(() => { setMachineFreeText(false); }, [selectedVenue]);

  // A TiltTrack venue whose link was resolved on pick: its own payload (plays, TiltTrack names)
  // plus the roster fetched by Pinball Map id.
  const venueData = useMemo(
    () => (venuePayload && pmResolvedOnPick && pmOnlyData?.pmMachines
      ? { ...venuePayload, pmMachines: pmOnlyData.pmMachines }
      : venuePayload),
    [venuePayload, pmResolvedOnPick, pmOnlyData],
  );

  // Recently-removed machines still count as valid suggestions — e.g. a photo taken Friday
  // night might not get uploaded until Monday, after an operator swap already hit Pinball Map.
  const RECENTLY_LEFT_DAYS = 90;

  // Deduplicated machine list: user's played machines first, then unplayed PM machines,
  // then recently-removed machines (so a late upload of a since-rotated machine still matches)
  const allVenueMachines = useMemo(() => {
    if (venueData) {
      const ownNames = new Set((venueData.ownMachines as any[]).map((m: any) => m.name.toLowerCase()));
      const ttNames = new Set(((venueData.ttMachineNames as string[]) ?? []).map((n: string) => n.toLowerCase()));
      const inventory = ((venueData.inventory?.machines as any[]) ?? []);
      const inventoryNames = new Set(inventory.map((m: any) => m.name.toLowerCase()));
      const pmNames = new Set((venueData.pmMachines as any[]).map((m: any) => m.name.toLowerCase()));
      const cutoff = Date.now() - RECENTLY_LEFT_DAYS * 24 * 60 * 60 * 1000;
      return [
        ...(venueData.ownMachines as any[]).map((m: any) => ({
          name: m.name as string, played: true, playCount: m.playCount as number, inTiltTrack: true, recentlyLeft: false,
          manufacturer: undefined as string | undefined, year: undefined as number | undefined,
        })),
        // A home venue's owner-managed machines — its roster, since it has no Pinball Map listing.
        ...inventory
          .filter((m: any) => !ownNames.has(m.name.toLowerCase()))
          .map((m: any) => ({
            name: m.name as string, played: false, playCount: 0,
            inTiltTrack: ttNames.has(m.name.toLowerCase()), recentlyLeft: false,
            manufacturer: (m.manufacturer ?? undefined) as string | undefined, year: (m.year ?? undefined) as number | undefined,
          })),
        ...(venueData.pmMachines as any[])
          .filter((m: any) => !ownNames.has(m.name.toLowerCase()) && !inventoryNames.has(m.name.toLowerCase()))
          .map((m: any) => ({
            name: m.name as string, played: false, playCount: 0,
            inTiltTrack: ttNames.has(m.name.toLowerCase()), recentlyLeft: false,
            manufacturer: m.manufacturer as string | undefined, year: m.year as number | undefined,
          })),
        ...[...((venueData.formerMachines as any[]) ?? []), ...((venueData.inventory?.former as any[]) ?? [])]
          .filter((m: any) => !ownNames.has(m.name.toLowerCase()) && !pmNames.has(m.name.toLowerCase()) && !inventoryNames.has(m.name.toLowerCase()))
          .filter((m: any) => new Date(m.removedAt).getTime() >= cutoff)
          .map((m: any) => ({
            name: m.name as string, played: false, playCount: 0,
            inTiltTrack: ttNames.has(m.name.toLowerCase()), recentlyLeft: true,
            manufacturer: m.manufacturer as string | undefined, year: m.year as number | undefined,
          })),
      ];
    }
    if (pmOnlyData) {
      return (pmOnlyData.pmMachines as any[]).map((m: any) => ({
        name: m.name as string, played: false, playCount: 0, inTiltTrack: false, recentlyLeft: false,
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

  // For PM list mode: all machines, AI-matching ones floated to top
  const sortedVenueMachines = useMemo(() => {
    if (!aiDetectedMachine) return allVenueMachines;
    const ai = aiDetectedMachine.toLowerCase();
    return [...allVenueMachines].sort((a, b) => {
      const aMatch = a.name.toLowerCase().includes(ai) ? 0 : 1;
      const bMatch = b.name.toLowerCase().includes(ai) ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [allVenueMachines, aiDetectedMachine]);

  // Fallback machine search (used when no PM machine data available)
  const { data: machineSuggestions = [] } = useQuery({
    queryKey: ['machine-search', machineSearch],
    queryFn: () => api.machines.search(machineSearch),
    enabled: (allVenueMachines.length === 0 || machineFreeText) && !venueDataLoading && !pmOnlyLoading && machineSearch.length > 1,
  });

  // Address-as-you-type suggestions for the "Add custom venue" form (HERE Autosuggest)
  const { data: addressSuggestions = [] } = useQuery({
    queryKey: ['address-autocomplete', newVenueAddress],
    queryFn: () => {
      const at = gps ?? deviceCoords;
      return api.venues.addressAutocomplete(newVenueAddress, at ? { lat: at.latitude, lng: at.longitude } : undefined);
    },
    enabled: showAddVenueForm && newVenueAddress.trim().length > 3,
  });

  // A friend's home venue: never suggested by location, found only by typing its exact name.
  const exactPrivateVenues = useExactPrivateVenues(searchTerm);

  // Filtered venue history for step 2 (user's venues only) — any word, punctuation-insensitive.
  const filteredVenueHistory = useMemo(
    () => (venueHistory as any[]).filter((v: any) => venueMatches(searchTerm, v.name, v.address)),
    [venueHistory, searchTerm]
  );

  // Everything else: TiltTrack venues by any word, and HERE places by name, biased to the photo's
  // GPS or else the device's position (bias only — never saved). See lib/venueSearch.ts.
  const searchAt = useMemo(() => {
    const p = gps ?? deviceCoords;
    return p ? { lat: p.latitude, lng: p.longitude } : null;
  }, [gps, deviceCoords]);
  const venueSearchState = useVenueSearch(searchTerm, searchAt);

  // The save stores a link resolved on pick (unless the venue already had one, or is private), so
  // the saved venue is linked by the time step 4 posts to Pinball Map; the server re-checks it.
  const canPostToPm = savedScore?.venueId != null && effectivePmId != null;

  const { data: pmTokenData } = useQuery({
    queryKey: ['pm-token'],
    queryFn: () => api.pinballmap.getToken(),
    enabled: step === 4 && canPostToPm,
    staleTime: Infinity,
  });

  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    // Local wall clock, not UTC — see datetime.ts for why toISOString() is wrong here.
    defaultValues: { type: 'casual', playedAt: toLocalInput(new Date()), scoreUnfilled: 0 },
  });

  const venueName = watch('venueName');
  latestScoreRef.current = { read: scoreRead, template: scoreTemplate, display: scoreDisplay, players: playerReads, selected: selectedPlayer };
  latestVenueRef.current = { selected: selectedVenue, search: venueSearch, nearby: nearbyVenues, source: nearbySource };

  function replacePhotoPreviews(urls: string[]) {
    photoPreviewsRef.current.forEach(u => URL.revokeObjectURL(u));
    photoPreviewsRef.current = urls;
    setPhotoPreviews(urls);
  }
  useEffect(() => () => { photoPreviewsRef.current.forEach(u => URL.revokeObjectURL(u)); }, []);

  // Step 1's "location is off for this site" tip. Reads the permission state only — never prompts.
  useEffect(() => {
    let cancelled = false;
    queryGeoPermission().then(p => { if (!cancelled) setGeoPermission(p); });
    return () => { cancelled = true; };
  }, []);

  /** Sets the working template and keeps the form's score / unfilled-count in step with it. */
  function applyScoreTemplate(t: string) {
    setScoreTemplate(t);
    const n = templateToScore(t);
    setValue('score', n ?? ('' as any), { shouldValidate: false });
    setValue('scoreUnfilled', unknownCount(t));
    setScoreDisplay(n ? n.toLocaleString() : '');
  }

  /** Plain-number mode holding a known-complete template (used after reconciliation). */
  function enterPlainScoreModeWith(t: string) {
    const n = templateToScore(t);
    setScoreTemplate(null);
    setValue('scoreUnfilled', 0);
    setValue('score', n ?? ('' as any));
    setScoreDisplay(n ? n.toLocaleString() : '');
  }

  function enterPlainScoreMode() {
    const n = scoreTemplate ? templateToScore(scoreTemplate) : null;
    setScoreTemplate(null);
    setValue('scoreUnfilled', 0);
    // A half-filled template has no honest plain-number equivalent — start the field empty rather
    // than silently dropping the x's (which would shrink the score by orders of magnitude).
    setValue('score', n ?? ('' as any));
    setScoreDisplay(n ? n.toLocaleString() : '');
  }

  /** Empties the score field (plain mode) — nothing is known until a player is picked. */
  function clearScoreEntry() {
    setScoreRead(null);
    setScoreDisagreements([]);
    setScoreTemplate(null);
    setValue('scoreUnfilled', 0);
    setValue('score', '' as any);
    setScoreDisplay('');
  }

  /**
   * Makes one display's read the one the user fills in: digit cells if it has x's, else the plain
   * number. `carry` is what the user had typed before an added photo re-read the set — reconciled
   * onto the new read so none of it is lost (see reconcileUserDigits).
   */
  function applyChosenRead(read: ScoreRead | null, carry: { prevRead: string; prevValue: string } | null) {
    setScoreRead(read);
    setScoreDisagreements([]);
    if (carry && read?.template) {
      const { template, disagreements } = reconcileUserDigits(carry.prevRead, carry.prevValue, read.template);
      if (hasUnknown(template) || disagreements.length > 0 || template !== read.template || read.alignmentWarning) {
        applyScoreTemplate(template);
        setScoreDisagreements(disagreements);
      } else {
        // A complete new read that confirms what the user had — nothing left to fill or check.
        enterPlainScoreModeWith(template);
      }
      return;
    }
    // Partial read — the display was caught mid-refresh — or one the server's close-up re-read
    // disputed: digit cells, so x's and the amber unsure digits are visible. A disputed read is
    // never prefilled into the plain number field, even when every digit is there.
    if (read && (hasUnknown(read.template) || read.alignmentWarning)) {
      applyScoreTemplate(read.template);
      return;
    }
    const n = read ? templateToScore(read.template) : null;
    if (n) enterPlainScoreModeWith(read!.template);
  }

  /** "Which player were you?" — a tap on one display's card. */
  function selectPlayer(i: number) {
    const read = playerReads[i];
    if (!read) return;
    const carry = pendingCarryRef.current;
    pendingCarryRef.current = null;
    setChoosingPlayer(false);
    // Re-tapping the current pick just closes the picker; it mustn't wipe what they've typed.
    if (selectedPlayer === i) return;
    setSelectedPlayer(i);
    applyChosenRead(read, carry);
  }

  /** "None of these — type it in": plain-number entry, no photo read to fill. */
  function selectNoPlayer() {
    const carry = pendingCarryRef.current;
    pendingCarryRef.current = null;
    setChoosingPlayer(false);
    if (selectedPlayer === 'none') return;
    setSelectedPlayer('none');
    clearScoreEntry();
    // Plain-mode digits they'd already typed are still theirs.
    if (carry && !carry.prevRead.replace(/\?/g, '')) enterPlainScoreModeWith(carry.prevValue);
  }

  // A capture instant is re-expressed whenever the venue (and so the score's clock) changes.
  useEffect(() => {
    if (playedAtInstant) setValue('playedAt', toLocalInput(playedAtInstant, selectedVenue?.timezone));
  }, [playedAtInstant, selectedVenue?.timezone]);

  // Digits the user currently has, x's included — what the plausibility check runs against.
  const currentScoreTemplate = scoreTemplate ?? scoreDisplay.replace(/[^0-9]/g, '');

  // "This score may be missing digits" — never blocks saving. Two independent signals: the model saw
  // signs of truncation on the display itself, or the number is implausibly small for this machine.
  const plausibilityMachine = selectedMachine || aiDetectedMachine;
  const { data: machineScoreStats } = useQuery({
    queryKey: ['machine-score-stats', plausibilityMachine],
    queryFn: () => api.machines.scoreStats(plausibilityMachine),
    enabled: step === 3 && plausibilityMachine.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const missingDigitReasons = useMemo(() => {
    const reasons: string[] = [];
    if (!currentScoreTemplate) return reasons;
    // The model's flag describes its own read; once the user has typed a longer number it's answered.
    if (scoreRead?.possiblyTruncated && currentScoreTemplate.length <= scoreRead.template.length) {
      reasons.push(scoreRead.truncationReason ?? 'The display may show more digits than were read');
    }
    // A dark first window on a strobing display: a blank, or a digit caught unlit. Same answer as
    // above — once the user has entered a longer number, they've checked.
    if (scoreRead?.leadingPositionAmbiguous && currentScoreTemplate.length <= scoreRead.template.length) {
      reasons.push(LEADING_AMBIGUOUS_REASON);
    }
    const p = machineScoreStats
      ? checkPlausibility(currentScoreTemplate, machineScoreStats.median, machineScoreStats.count)
      : scoreRead?.plausibility && scoreRead.template === currentScoreTemplate ? scoreRead.plausibility : null;
    if (p?.flagged) reasons.push(`${p.reason} (typical: ${Math.round(p.median).toLocaleString()})`);
    return reasons;
  }, [currentScoreTemplate, scoreRead, machineScoreStats]);

  // True when the effective machine name (selected or AI-detected) isn't in the PM list for this venue
  const effectiveMachineName = selectedMachine || aiDetectedMachine;
  const machineNotInPm = effectiveMachineName.length > 0
    && allVenueMachines.length > 0
    && !allVenueMachines.some(m => m.name.toLowerCase() === effectiveMachineName.toLowerCase());

  const createScore = useMutation({
    mutationFn: async ({ scoreUnfilled: _unfilled, ...data }: FormData) => {
      const machine = await api.machines.upsert({ name: data.machineName, ...selectedMachineExtra });
      return api.scores.create({
        ...data,
        // The form holds a *wall clock*. Which zone it belongs to is the venue's, not the
        // browser's — that's what makes uploading a Chicago photo after you've flown home store the
        // right instant instead of one shifted by the difference between the two zones.
        playedAt: localInputToIso(data.playedAt, selectedVenue?.timezone),
        machineId: machine.id,
        ...gps,
        venueId: selectedVenue?.venueId,
        venueHereId: selectedVenue?.hereId,
        venueAddress: selectedVenue?.address,
        venueLat: selectedVenue?.venueLat,
        venueLng: selectedVenue?.venueLng,
        venueTimezone: selectedVenue?.timezone,
        venuePinballMapId: effectivePmId,
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
      void runFullPhotoUpload(row.id);
    },
    onError: (err: any) => {
      console.error('Save score failed:', err);
    },
  });

  const createVenueMutation = useMutation({
    mutationFn: (body: { name: string; address: string; isResidence: boolean; privacyTier: 'full' | 'city_state' | 'hidden'; allowDuplicate?: boolean }) =>
      api.venues.create(body),
    onSuccess: (venue: any) => {
      setVenueDuplicates(null);
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      setValue('venueName', venue.name);
      setVenueSearch(venue.name);
      setSelectedVenue({ venueId: venue.id, address: venue.address ?? undefined, venueLat: venue.latitude ?? undefined, venueLng: venue.longitude ?? undefined, timezone: venue.timezone });
      setShowAddVenueForm(false);
      setNewVenueName('');
      setNewVenueAddress('');
      setNewVenueIsResidence(false);
      setNewVenuePrivacyTier('hidden');
      setStep(3);
    },
    // A 409 here isn't a failure to explain in red text — it's the server saying "you already have
    // this one". Show the matches so the obvious action (pick the existing venue) is one click.
    onError: (e: any) => {
      setVenueDuplicates(e.code === 'duplicate_venue' ? (e.body?.candidates ?? null) : null);
    },
  });

  /**
   * Handles a pick from the file input. `add` appends to the items already read (from step 3's "Add
   * another photo or video") and re-reads them all together; otherwise it starts over. Either way the
   * whole set goes up in one request — the server merges the per-image reads (see api-server
   * scoreRead.ts). A video is one item; its best few frames are sent as images and it is never
   * uploaded itself (see videoFrames.ts).
   */
  const handleFiles = async (picked: File[], mode: 'replace' | 'add', source: PhotoSource) => {
    const existing = mode === 'add' ? uploadItems : [];
    const room = MAX_ITEMS - existing.length;
    if (room <= 0 || picked.length === 0) return;
    const notices: string[] = [];
    if (picked.length > room) {
      notices.push(`Only ${MAX_ITEMS} photos or videos can be used at once — kept the first ${room === 1 ? 'one' : room}.`);
    }
    const chosen = picked.slice(0, room);

    setAiLoading(true);
    setAiError('');

    // EXIF, HEIC conversion and a ~2000px downscale all happen client-side — see
    // prepareUploadImage.ts for why (keeps the memory-heavy decode off the server). One at a time:
    // HEIC decoding and video seeking are heavy on a phone too.
    const fresh: UploadItem[] = [];
    for (const f of chosen) {
      if (isVideoFile(f)) {
        setVideoProgress('Reading video…');
        try {
          const frames = await extractVideoFrames(f, p => setVideoProgress(`Picking the sharpest frames… ${Math.round((p.done / p.total) * 100)}%`));
          fresh.push({ kind: 'video', images: frames, source });
        } catch (err) {
          notices.push(err instanceof VideoFrameError ? err.message : VIDEO_UNSUPPORTED_MESSAGE);
        } finally {
          setVideoProgress(null);
        }
      } else {
        fresh.push({ kind: 'photo', images: [await prepareUploadImage(f)], source });
      }
    }
    setPhotoNotice(notices.join(' '));

    // Nothing usable (e.g. the only pick was a video this browser can't decode): stay put rather
    // than advancing the wizard with nothing read.
    if (fresh.length === 0) {
      setAiLoading(false);
      return;
    }

    const items = [...existing, ...fresh];
    const images = items.flatMap(i => i.images);

    // Did any of these carry GPS? A fresh set is described up front, so the notice still shows if the
    // read fails. An added set only once it's adopted — a failed add leaves the set (and this) as it was.
    const setLocation = { ...describePhotoLocation(images, items.every(i => i.source === 'camera')), count: items.length };
    if (mode === 'replace') {
      setPhotoLocation(setLocation);
      // A new set may be somewhere else entirely: drop the previous set's current-location lookup.
      setCurrentLocation({ status: 'idle' });
      setDeviceCoords(null);
      deviceAutoPickRef.current = null;
      if (latestVenueRef.current.source === 'device') {
        setNearbyVenues([]);
        setNearbySource('photo');
      }
    }

    // A single HEIC the browser couldn't convert can still use the server's own decode; the
    // multi-image path refuses that (memory), so say so here rather than after the upload.
    if (images.length > 1 && images.some(i => i.heicFailed)) {
      setAiLoading(false);
      setAiError("One of these photos is HEIC and couldn't be converted on this device — upload it on its own, or use a JPEG.");
      if (mode === 'replace') setStep(2);
      return;
    }

    // A fresh set's thumbnail is made up front so a manual save still has one if the read fails.
    if (mode === 'replace') {
      thumbnailSucceeded.current = false;
      setBestImage(images[0]);
      generateThumbnail(images[0].file).then(t => { setThumbnail(t); thumbnailSucceeded.current = true; }).catch(() => {});
    }

    try {
      const result = await api.upload(images);
      // Only a set that was actually read becomes the set: a failed add mustn't count toward the cap
      // or be re-sent with the next add.
      setUploadItems(items);
      setPhotoLocation(setLocation);
      replacePhotoPreviews(images.map(i => URL.createObjectURL(i.file)));
      applyUploadResult(result, images, mode);
    } catch (err: any) {
      setAiError(err?.message ?? 'AI extraction failed — enter details manually');
      if (mode === 'replace') setStep(2);
    } finally {
      setAiLoading(false);
    }
  };

  function applyUploadResult(result: any, images: PreparedImage[], mode: 'replace' | 'add') {
    const adding = mode === 'add';
    // Adding a photo re-reads the score; it shouldn't undo a machine or venue the user already chose.
    if (result.machineName && !(adding && (selectedMachine || aiDetectedMachine))) {
      setValue('machineName', result.machineName);
      setMachineSearch(result.machineName);
      setAiDetectedMachine(result.machineName);
      // Don't pre-select — auto-select handles exact PM matches; banner guides the rest
    }
    // One read per player display. Older servers only send `scoreRead` (a single display).
    const reads: ScoreRead[] = Array.isArray(result.playerReads)
      ? result.playerReads
      : result.scoreRead ? [result.scoreRead] : [];
    // An added photo that read nothing (empty template) says nothing about the score: keep the read
    // the user is filling in. Replacing it would make the next add's reconcile see no "original", drop
    // every digit they typed, and break backspace's un-fill (it compares against the original).
    const unreadableAdd = adding && !reads.some(r => r.template);

    // Adding a photo re-reads the whole set; digits the user already entered must survive that.
    const prev = latestScoreRef.current;
    const prevDigits = prev.display.replace(/[^0-9]/g, '');
    const [prevRead, prevValue] = prev.template != null
      ? [prev.read?.template || prev.template, prev.template]
      : [ '?'.repeat(prevDigits.length), prevDigits ]; // plain-number mode: every digit is the user's
    const carry = adding && prevValue ? { prevRead, prevValue } : null;

    if (unreadableAdd) {
      setAiError("Couldn't read the score in the added photo — kept what you had.");
    } else {
      setPlayerReads(reads);
      setChoosingPlayer(false);
      pendingCarryRef.current = null;
      if (reads.length > 1) {
        // Several player displays: only the user knows which was theirs. After an add, keep their
        // pick if it still lines up with a display in the new read; otherwise ask again, and carry
        // what they'd typed onto whichever display they pick.
        const kept = adding && typeof prev.selected === 'number'
          ? matchPlayerRead(prev.players, prev.selected, reads)
          : null;
        if (kept != null) {
          setSelectedPlayer(kept);
          applyChosenRead(reads[kept], carry);
        } else if (adding && prev.selected === 'none') {
          // They chose to type it themselves; a new photo doesn't change that.
          setSelectedPlayer('none');
        } else {
          setSelectedPlayer(null);
          pendingCarryRef.current = carry;
          clearScoreEntry();
        }
      } else {
        setSelectedPlayer(reads.length === 1 ? 0 : null);
        applyChosenRead(reads[0] ?? result.scoreRead ?? null, carry);
      }
    }
    setDifferentGamesWarning(result.differentGamesWarning ?? null);
    // The server couldn't finish reading the score (too much to read in one go); everything else in
    // the result is still good. Shown on the venue and score steps like any read failure.
    if (result.readNotice) setAiError(result.readNotice);
    // Already a zone-less camera wall clock (the earliest photo's) — the input wants it verbatim.
    const instants = images.map(i => i.capturedAt).filter((t): t is string => !!t).sort();
    if (images.some(i => i.exifDatetime) && result.playedAt) {
      setPlayedAtInstant(null);
      setValue('playedAt', naiveToLocalInput(result.playedAt));
    } else if (instants.length) {
      // Only a container/file instant (video): show it on the venue's clock, not the browser's.
      setPlayedAtInstant(instants[0]);
      setValue('playedAt', toLocalInput(instants[0], selectedVenue?.timezone));
    } else if (result.playedAt) {
      setPlayedAtInstant(null);
      setValue('playedAt', naiveToLocalInput(result.playedAt));
    }
    if (result.latitude != null && result.longitude != null && !(adding && gps)) {
      setGps({ latitude: result.latitude, longitude: result.longitude });
    }
    // The server can also find GPS the browser couldn't read (its own EXIF fallback).
    if (result.latitude != null && result.longitude != null) {
      setPhotoLocation(p => (p ? { ...p, hasGps: true } : p));
    }

    // Thumbnail from the photo the model found most legible (default: the first).
    const best = (reads[0] ?? result.scoreRead)?.bestImageIndex ?? 0;
    if (best > 0 && images[best]) {
      setBestImage(images[best]);
      generateThumbnail(images[best].file).then(t => { setThumbnail(t); thumbnailSucceeded.current = true; }).catch(() => {});
    } else if (result.thumbnailBase64 && !thumbnailSucceeded.current) {
      resizeImage(result.thumbnailBase64).then(setThumbnail).catch(() => setThumbnail(result.thumbnailBase64));
    }

    // Read venue state from the ref: this runs after an await, and the user may have picked one meanwhile.
    // Picking or typing a venue always sets the search text; the device lookup's own auto-pick doesn't
    // count as the user's choice, so a photo's better-founded suggestion may replace it.
    const venueNow = latestVenueRef.current;
    const userHasVenue = !!venueNow.search
      || (!!venueNow.selected && venueNow.selected !== deviceAutoPickRef.current);
    if (result.venues?.length) {
      // A photo's own GPS outranks a "Use my current location" list, so an added photo replaces
      // that — but an added photo never replaces photo-based suggestions or a venue already chosen.
      const replaceList = !adding || venueNow.source === 'device' || venueNow.nearby.length === 0;
      if (replaceList) {
        setNearbyVenues(result.venues);
        setNearbySource('photo');
      }
      if (!adding || (replaceList && !userHasVenue)) {
        const first = result.venues[0];
        setValue('venueName', first.name);
        setSelectedVenue({
          venueId: first.venueId,
          name: first.name,
          hereId: first.hereId ?? undefined,
          address: first.address,
          venueLat: first.venueLat,
          venueLng: first.venueLng,
          pinballMapId: first.pinballMapId,
          pmChecked: true,
          timezone: first.timezone,
        });
      }
    }
    if (!adding) setStep(2);
  }

  /**
   * "Use my current location": one user-initiated fix, fed into the same suggestion list a photo's GPS
   * produces. The position is used for the lookup only — it never goes into `gps`, so it can't end
   * up as the score's coordinates or its played-at metadata.
   */
  async function useCurrentLocation() {
    setCurrentLocation({ status: 'locating' });
    try {
      const pos = await getCurrentPosition();
      const { venues } = await api.venues.nearby(pos.latitude, pos.longitude);
      // Everything below reads the ref, not this closure: the lookup takes seconds, and the user may
      // have picked or typed a venue — or added a GPS photo — in the meantime.
      const now = latestVenueRef.current;
      setDeviceCoords({ latitude: pos.latitude, longitude: pos.longitude });
      // A photo's own GPS suggestions (from a photo added meanwhile) outrank the device's.
      if (!(now.source === 'photo' && now.nearby.length > 0)) {
        setNearbyVenues(venues ?? []);
        setNearbySource('device');
        // Same as the photo path: pre-select the top suggestion — unless the user already chose or typed one.
        const first = venues?.[0];
        if (first && !now.selected && !now.search) {
          const pick: SelectedVenue = {
            venueId: first.venueId,
            name: first.name,
            hereId: first.hereId ?? undefined,
            address: first.address,
            venueLat: first.venueLat,
            venueLng: first.venueLng,
            pinballMapId: first.pinballMapId,
            pmChecked: true,
            timezone: first.timezone,
          };
          deviceAutoPickRef.current = pick;
          setValue('venueName', first.name);
          setSelectedVenue(pick);
        }
      }
      setCurrentLocation({ status: 'done', count: venues?.length ?? 0, accuracy: pos.accuracy });
    } catch (err: any) {
      if (err instanceof CurrentPositionError && err.reason === 'denied') setGeoPermission('denied');
      setCurrentLocation({
        status: 'error',
        message: err instanceof CurrentPositionError
          ? geoFailureMessage(err.reason)
          : (err?.message ?? "Couldn't look up venues near you — pick one below instead"),
      });
    }
  }

  /**
   * A tap on a venue option picks it *and* moves on to the details step — the tap fully determines
   * the venue, so making the user scroll down to Continue was a wasted step. A mis-tap is one Back
   * (or back gesture) away, and step 2 still shows the pick highlighted. Everything the pick sets
   * off (pm-match, the venue's roster) is a query keyed on `selectedVenue` at the top of the
   * component, so it keeps loading across the step change; step 3's machine picker shows its
   * loading state until the roster lands, and Save waits for an in-flight match (see `pmMatchLoading`).
   */
  function selectVenueCard(v: {
    id?: number; name: string; address?: string | null; hereId?: string | null; venueLat?: number; venueLng?: number;
    pinballMapId?: number | null; timezone?: string | null; pmChecked?: boolean; isPrivate?: boolean;
  }) {
    setValue('venueName', v.name);
    setVenueSearch(v.name);
    setSelectedVenue({
      venueId: v.id,
      name: v.name,
      pmChecked: v.pmChecked,
      isPrivate: v.isPrivate,
      hereId: v.hereId ?? undefined,
      address: v.address ?? undefined,
      venueLat: v.venueLat,
      venueLng: v.venueLng,
      pinballMapId: v.pinballMapId ?? undefined,
      timezone: v.timezone,
    });
    setStep(3);
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
            Snap a pic or a short video of the DMD or score screen. Our AI will extract the machine name, score, time, and location.
          </p>
          {/* Two inputs on purpose: Android Chrome skips offering the camera for a `multiple` input and
              opens the photo picker instead, so the big target is a camera-first single-photo input and
              multi-select (photos or videos) is the secondary one. */}
          <button
            onClick={() => cameraRef.current?.click()}
            disabled={aiLoading}
            className="w-full rounded-xl border-2 border-dashed border-primary/50 p-12 flex flex-col items-center gap-3 hover:border-primary transition-colors disabled:opacity-50"
          >
            {aiLoading ? <Loader2 className="w-12 h-12 text-primary animate-spin" /> : <Camera className="w-12 h-12 text-primary" />}
            <span className="font-black uppercase tracking-wider text-white">
              {aiLoading ? (videoProgress ? 'Reading video...' : 'Analyzing...') : 'Tap to Take Photo'}
            </span>
            {aiLoading && videoProgress && <span className="text-xs text-muted-foreground">{videoProgress}</span>}
          </button>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) handleFiles(files, 'replace', 'camera'); }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={aiLoading}
            className="-mt-3 w-full py-2.5 rounded-lg border border-white/10 text-sm font-bold uppercase tracking-wider text-white/80 hover:border-primary/40 hover:text-white transition-colors disabled:opacity-50"
          >
            Choose photos or videos
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            className="hidden"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) handleFiles(files, 'replace', 'picker'); }}
          />
          <div className="flex flex-col gap-1 text-xs text-muted-foreground text-center -mt-3">
            <p>Up to {MAX_ITEMS} photos or videos of the same score.</p>
            <p>Old machine with flickering digits? Take a 2-second video or a few photos.</p>
            <p>Take the photo as soon as your last ball drains — older machines start a light show a few seconds later.</p>
            <p>Have a Live Photo? Tap ••• → Save as Video, then upload the video.</p>
          </div>
          {photoNotice && <p className="text-xs text-amber-400 text-center -mt-3">{photoNotice}</p>}
          {geoPermission === 'denied' && (
            <p className="text-xs text-muted-foreground text-center -mt-3">
              Location is off for this site — venue lookup works much better with it on.
            </p>
          )}
          <button onClick={() => setStep(2)} className="text-sm text-muted-foreground hover:text-white transition-colors uppercase tracking-wider">
            Skip AI & Enter Manually ›
          </button>
        </div>
      )}

      {/* Step 2: Venue */}
      {step === 2 && (
        <div className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-4">
          <BackLink onClick={goBack} label="Photo" />
          <h2 className="text-xl font-black uppercase tracking-widest text-white mb-2 -mt-2">Where Did You Play?</h2>
          {aiError && <p className="text-xs text-yellow-400 -mt-1">{aiError}</p>}
          {/* No photo GPS — or no photo at all ("Skip AI & Enter Manually") — offer the device's position. */}
          {!photoLocation?.hasGps && (
            <MissingLocationNotice
              info={photoLocation}
              photoCount={photoLocation?.count ?? 0}
              platform={platform}
              state={currentLocation}
              onUseCurrentLocation={useCurrentLocation}
            />
          )}

          <div className="relative">
            {!venueSearch && <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />}
            <input
              value={venueSearch}
              onChange={e => {
                // Typing searches; it never *is* the venue. Only picking a result (or adding a venue
                // below) sets one — a bare typed name used to be saved as a new, unplaced venue.
                setVenueSearch(e.target.value);
                setSearchTerm(e.target.value);
                setValue('venueName', '');
                setSelectedVenue(null);
              }}
              placeholder="Search venues, bars, arcades..."
              autoComplete="off"
              className={`input ${venueSearch ? 'pr-8' : 'pl-9'}`}
            />
            {venueSearch && (
              <button
                type="button"
                onClick={() => { setVenueSearch(''); setSearchTerm(''); setValue('venueName', ''); setSelectedVenue(null); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Nearby venues from AI photo */}
          {nearbyVenues.filter(v => venueMatches(searchTerm, v.name, v.address)).length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">{nearbySource === 'device' ? 'Near You' : 'Nearby'}</p>
              <div className="flex flex-col gap-1.5">
                {nearbyVenues
                  .filter(v => venueMatches(searchTerm, v.name, v.address))
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
                        onClick={() => selectVenueCard({ id: v.venueId, name: v.name, address: v.address, hereId: v.hereId, venueLat: v.venueLat, venueLng: v.venueLng, pinballMapId: v.pinballMapId, timezone: v.timezone, pmChecked: true })}
                        className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-venue/60 bg-venue/10' : 'border-white/10 hover:border-venue/40 hover:bg-white/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-venue' : 'text-muted-foreground'}`} />
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

          {/* Exact-name match on someone's private (home) venue — name only, no location */}
          {(() => {
            const shownIds = new Set([
              ...nearbyVenues.map(v => v.venueId).filter(Boolean),
              ...(venueHistory as any[]).map((v: any) => v.id),
            ]);
            const privateMatches = exactPrivateVenues.filter(p => !shownIds.has(p.id));
            if (privateMatches.length === 0) return null;
            return (
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Private venue</p>
                <div className="flex flex-col gap-1.5">
                  {privateMatches.map(p => {
                    const isSelected = selectedVenue?.venueId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectVenueCard({ id: p.id, name: p.name, isPrivate: true })}
                        className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-venue/60 bg-venue/10' : 'border-white/10 hover:border-venue/40 hover:bg-white/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          <Home className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-venue' : 'text-muted-foreground'}`} />
                          <span className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-white/80'}`}>{p.name}</span>
                          <span className="text-xs text-muted-foreground ml-auto">Private</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

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
                        className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'border-venue/60 bg-venue/10' : 'border-white/10 hover:border-venue/40 hover:bg-white/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-venue' : 'text-muted-foreground'}`} />
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

          {/* Search results: TiltTrack venues the lists above don't already show, then HERE places.
              A place that already is a TiltTrack venue arrives as that venue, never as a place. */}
          {venueSearchState.active && (() => {
            const shownIds = new Set<number>([
              ...nearbyVenues.filter(v => venueMatches(searchTerm, v.name, v.address)).map(v => v.venueId).filter((id): id is number => id != null),
              ...filteredVenueHistory.map((v: any) => v.id as number),
            ]);
            const shownHere = new Set(nearbyVenues.map(v => v.hereId).filter(Boolean));
            const result = venueSearchState.result;
            const ttHits = (result?.tiltTrack ?? []).filter(h => !shownIds.has(h.id));
            const placeHits = (result?.places ?? []).filter(p => !shownHere.has(p.hereId));
            const typedLength = searchTerm.replace(/[^\p{L}\p{N}]/gu, '').length;
            return (
              <>
                {ttHits.length > 0 && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">On TiltTrack</p>
                    <div className="flex flex-col gap-1.5">
                      {ttHits.map(h => (
                        <VenueOption
                          key={`tt-${h.id}`}
                          name={h.name}
                          address={h.address}
                          selected={selectedVenue?.venueId === h.id}
                          icon={h.isPrivate ? 'home' : 'pin'}
                          badges={<>{myVenueIds.has(h.id) ? <TagV /> : <TagTT />}{h.pinballMapId && <TagPM />}</>}
                          right={formatDistance(h.distance)}
                          onClick={() => selectVenueCard({ id: h.id, name: h.name, address: h.address, hereId: h.hereId, venueLat: h.venueLat ?? undefined, venueLng: h.venueLng ?? undefined, pinballMapId: h.pinballMapId, timezone: h.timezone, isPrivate: h.isPrivate })}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {placeHits.length > 0 && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Places</p>
                    <div className="flex flex-col gap-1.5">
                      {placeHits.map(p => (
                        <VenueOption
                          key={`here-${p.hereId}`}
                          name={p.name}
                          address={p.address}
                          selected={selectedVenue?.venueId == null && selectedVenue?.hereId === p.hereId}
                          icon="pin"
                          right={formatDistance(p.distance)}
                          onClick={() => selectVenueCard({ name: p.name, address: p.address, hereId: p.hereId, venueLat: p.venueLat ?? undefined, venueLng: p.venueLng ?? undefined, timezone: p.timezone })}
                        />
                      ))}
                    </div>
                    {result?.anchor !== 'client' && (
                      <p className="text-xs text-muted-foreground mt-1.5">Not the right one? Add the town, e.g. “{searchTerm.trim()} medford”.</p>
                    )}
                  </div>
                )}
                {venueSearchState.pending && !result && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching venues and places…</p>
                )}
                {venueSearchState.failed && (
                  <p className="text-xs text-amber-400">Venue search isn't working right now — pick from the lists above, or add the venue below.</p>
                )}
                {result && ttHits.length === 0 && placeHits.length === 0 && shownIds.size === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {typedLength < MIN_PLACE_SEARCH_CHARS ? 'Keep typing to search places too…' : `Nothing found for “${searchTerm.trim()}”. Try adding the town, or add it below.`}
                  </p>
                )}
                {/* Last resort, offered right under the results instead of as small print below Continue. */}
                {result && !showAddVenueForm && !selectedVenue && (
                  <button
                    type="button"
                    onClick={() => { setNewVenueName(searchTerm.trim()); setShowAddVenueForm(true); }}
                    className="text-left px-3 py-2.5 rounded-lg border border-dashed border-venue/40 hover:bg-venue/5 transition-colors"
                  >
                    <span className="block text-sm font-bold text-venue">Not listed? Add “{searchTerm.trim()}” with its address</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">The address puts it on the map and keeps it from being added twice.</span>
                  </button>
                )}
              </>
            );
          })()}

          {filteredVenueHistory.length === 0 && nearbyVenues.length === 0 && !searchTerm && (
            <p className="text-sm text-muted-foreground text-center py-2">Search by name — bars, arcades, anywhere with a machine</p>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={goBack}
              className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
              Back
            </button>
            {/* Continue needs a picked venue. Going on without one is its own, clearly-labelled choice
                ("Skip — no venue") — a typed-but-unpicked name is no longer quietly saved as a venue.
                Tapping a venue option advances by itself; Continue is for coming back to step 2 with a
                venue still picked (e.g. after Back) and wanting to keep it. */}
            <button type="button" onClick={() => setStep(3)} disabled={!selectedVenue}
              className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
              Continue
            </button>
          </div>
          {!selectedVenue && (
            <p className="text-xs text-muted-foreground text-center -mt-2">
              {searchTerm.trim() ? 'Pick a venue from the list to continue — or add it, or skip.' : 'Pick a venue to continue.'}
            </p>
          )}
          {!showAddVenueForm ? (
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => { setSelectedVenue(null); setValue('venueName', ''); setVenueSearch(''); setSearchTerm(''); setStep(3); }}
                className="text-xs text-muted-foreground hover:text-white transition-colors text-center"
              >
                Skip — no venue
              </button>
              <button
                type="button"
                onClick={() => { setNewVenueName(searchTerm.trim()); setShowAddVenueForm(true); }}
                className="text-xs text-venue hover:text-venue/80 transition-colors text-center"
              >
                + Add a new venue
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-venue/30 bg-venue/5 p-4 flex flex-col gap-3">
              <p className="text-xs font-bold uppercase tracking-widest text-venue">Add a New Venue</p>
              <p className="text-xs text-muted-foreground -mt-2">Only if it isn't in the search above. Name and street address, so it lands on the map.</p>
              <div>
                <label className="label">Name</label>
                <input
                  value={newVenueName}
                  onChange={e => setNewVenueName(e.target.value)}
                  placeholder="e.g. Dave's Basement"
                  className="input"
                />
              </div>
              <div className="relative">
                <label className="label">Address</label>
                <input
                  value={newVenueAddress}
                  onChange={e => { setNewVenueAddress(e.target.value); setShowAddressSuggestions(true); }}
                  onFocus={() => setShowAddressSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowAddressSuggestions(false), 150)}
                  placeholder="Street address, town"
                  className="input"
                  autoComplete="off"
                />
                {showAddressSuggestions && (addressSuggestions as any[]).length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-white/10 bg-background overflow-hidden shadow-lg">
                    {(addressSuggestions as any[]).map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => { setNewVenueAddress(s.label); setShowAddressSuggestions(false); }}
                        className="w-full text-left px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Used to match future visits to this venue — your address privacy is controlled below.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={newVenueIsResidence}
                  onChange={e => {
                    setNewVenueIsResidence(e.target.checked);
                    setNewVenuePrivacyTier(e.target.checked ? 'hidden' : 'full');
                  }}
                />
                This is my residence
              </label>
              {newVenueIsResidence && (
                <div className="flex flex-col gap-1.5 pl-1">
                  <p className="text-xs text-muted-foreground">Show my address as:</p>
                  {([
                    { value: 'full', label: 'Full address' },
                    { value: 'city_state', label: 'City & state only' },
                    { value: 'hidden', label: 'Fully hidden' },
                  ] as const).map(opt => (
                    <label key={opt.value} className="flex items-center gap-2 text-sm text-white/80">
                      <input
                        type="radio"
                        name="privacyTier"
                        checked={newVenuePrivacyTier === opt.value}
                        onChange={() => setNewVenuePrivacyTier(opt.value)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}
              {venueDuplicates && venueDuplicates.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-2">
                  <p className="text-xs text-amber-400">
                    {venueDuplicates.length === 1 && venueDuplicates[0].isPrivate ? (
                      <>A private venue named “{venueDuplicates[0].name}” exists — log here, or create your own.</>
                    ) : (
                      <>
                        {venueDuplicates.length === 1 ? 'You already have this venue' : 'You already have venues with this name nearby'}.
                        Use the existing one, unless this really is a different place.
                      </>
                    )}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {venueDuplicates.map(d => (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setValue('venueName', d.name);
                            setVenueSearch(d.name);
                            setSelectedVenue({ venueId: d.id, address: d.address ?? undefined });
                            setVenueDuplicates(null);
                            setShowAddVenueForm(false);
                            setStep(3);
                          }}
                          className="w-full text-left rounded border border-white/10 bg-card px-2.5 py-1.5 hover:bg-white/10 transition-colors"
                        >
                          <span className="block text-sm font-bold text-venue truncate">{d.name}</span>
                          <span className="block text-[0.65rem] text-muted-foreground truncate">
                            {d.isPrivate ? 'Private venue' : (
                              <>
                                {d.distance != null ? `${d.distance}m away` : 'same name'}
                                {d.address ? ` · ${d.address}` : ''}
                              </>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => createVenueMutation.mutate({
                      name: newVenueName.trim(),
                      address: newVenueAddress.trim(),
                      isResidence: newVenueIsResidence,
                      privacyTier: newVenuePrivacyTier,
                      allowDuplicate: true,
                    })}
                    className="self-start text-xs text-muted-foreground hover:text-white underline transition-colors"
                  >
                    {venueDuplicates.length === 1 && venueDuplicates[0].isPrivate ? 'Create my own venue' : 'No, this is a different venue — create it anyway'}
                  </button>
                </div>
              )}
              {createVenueMutation.isError && !venueDuplicates && (
                <p className="text-xs text-red-400">{(createVenueMutation.error as any)?.message ?? 'Failed to create venue'}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddVenueForm(false)}
                  className="flex-1 py-2 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!newVenueName.trim() || !newVenueAddress.trim() || createVenueMutation.isPending}
                  onClick={() => { setVenueDuplicates(null); createVenueMutation.mutate({
                    name: newVenueName.trim(),
                    address: newVenueAddress.trim(),
                    isResidence: newVenueIsResidence,
                    privacyTier: newVenuePrivacyTier,
                  }); }}
                  className="flex-1 py-2 rounded-lg bg-venue text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {createVenueMutation.isPending ? 'Saving...' : 'Save Venue'}
                </button>
              </div>
            </div>
          )}
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
            <BackLink onClick={goBack} label={selectedVenue ? 'Change venue' : 'Venue'} />
            <h2 className="text-xl font-black uppercase tracking-widest text-white mt-2">Score Details</h2>
            {venueName && (
              <div className="flex items-center gap-1.5 mt-1">
                <MapPin className="w-3 h-3 text-venue flex-shrink-0" />
                <p className="text-sm text-venue font-medium truncate">{venueName}</p>
              </div>
            )}
          </div>

          {/* Machine */}
          <div>
            <label className="label">Machine</label>

            {(allVenueMachines.length > 0 || venueDataLoading || pmOnlyLoading) && !machineFreeText ? (
              <div className="flex flex-col gap-2">

                {/* AI detection context — shown when AI found a name but no exact PM match yet */}
                {aiDetectedMachine && !selectedMachine && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-sm">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-400 whitespace-nowrap">AI read</span>
                    <span className="text-white/80 font-medium truncate">"{aiDetectedMachine}"</span>
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">select version below</span>
                  </div>
                )}

                {venueDataLoading || pmOnlyLoading ? (
                  <div className="flex items-center gap-2 py-3 px-1 text-muted-foreground text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading machines at this venue...
                  </div>
                ) : (
                  <>
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Suggested machines
                    </p>
                    <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto pr-1">
                      {sortedVenueMachines.map(m => {
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
                              {m.recentlyLeft && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">Recently left</span>
                              )}
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
                    </div>
                  </>
                )}

                {/* Use AI name directly — escape hatch when no PM match exists */}
                {aiDetectedMachine && !selectedMachine && !venueDataLoading && !pmOnlyLoading && allVenueMachines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => selectMachine(aiDetectedMachine)}
                    className="text-xs text-center text-muted-foreground hover:text-white/70 transition-colors py-0.5"
                  >
                    Use "{aiDetectedMachine}" directly →
                  </button>
                )}
                {!venueDataLoading && !pmOnlyLoading && (
                  <button
                    type="button"
                    onClick={() => { setMachineFreeText(true); setSelectedMachine(''); setMachineSearch(aiDetectedMachine); setValue('machineName', aiDetectedMachine); }}
                    className="text-xs text-center text-muted-foreground hover:text-white/70 transition-colors py-0.5"
                  >
                    Not listed? Type the machine name
                  </button>
                )}
              </div>
            ) : (
              /* Fallback: free-text search when no PM data (e.g. custom venue with no Pinball Map link) */
              <div>
                {aiDetectedMachine && !selectedMachine && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-sm mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-400 whitespace-nowrap">AI read</span>
                    <span className="text-white/80 font-medium truncate">"{aiDetectedMachine}"</span>
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">prefilled below</span>
                  </div>
                )}
                {machineFreeText && allVenueMachines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMachineFreeText(false)}
                    className="text-xs text-muted-foreground hover:text-white/70 transition-colors mb-1.5"
                  >
                    ← Machines at this venue
                  </button>
                )}
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
            {showPlayerPicker && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-bold text-white">Which player were you?</p>
                <p className="text-xs text-muted-foreground -mt-1.5">
                  The photo shows {playerReads.length} player scores — tap yours.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {playerReads.map((r, i) => {
                    const isSelected = selectedPlayer === i;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => selectPlayer(i)}
                        aria-pressed={isSelected}
                        aria-label={`${playerLabel(r, i)}: ${formatTemplate(r.template)}`}
                        className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${isSelected ? 'border-primary/60 bg-primary/10' : 'border-white/10 hover:border-primary/40 hover:bg-white/5'}`}
                      >
                        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">{playerLabel(r, i)}</span>
                        <span className="font-mono font-bold text-lg text-white tracking-wide">
                          {[...formatTemplate(r.template)].map((ch, k) => (
                            <span key={k} className={ch === 'x' ? 'text-amber-400' : undefined}>{ch}</span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {photoPreviews.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto">
                    {photoPreviews.map((src, i) => (
                      <img
                        key={src}
                        src={src}
                        alt={`Uploaded photo ${i + 1}`}
                        className="max-h-64 rounded-lg border border-white/10 object-contain bg-black flex-shrink-0"
                        style={{ maxWidth: photoPreviews.length > 1 ? '80%' : '100%' }}
                      />
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={selectNoPlayer}
                    className="text-xs text-muted-foreground hover:text-white transition-colors"
                  >
                    None of these — type it in
                  </button>
                  {selectedPlayer != null && (
                    <button
                      type="button"
                      onClick={() => setChoosingPlayer(false)}
                      className="text-xs text-muted-foreground hover:text-white transition-colors ml-auto"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
            {!showPlayerPicker && playerReads.length > 1 && selectedPlayer != null && (
              <div className="flex items-center gap-2 mb-2 text-xs">
                <span className="text-muted-foreground">
                  {selectedPlayer === 'none'
                    ? 'Typing the score yourself'
                    : <>You were <span className="font-bold text-white">{playerLabel(playerReads[selectedPlayer], selectedPlayer)}</span></>}
                </span>
                <button
                  type="button"
                  onClick={() => setChoosingPlayer(true)}
                  className="ml-auto text-primary font-medium hover:underline"
                >
                  {selectedPlayer === 'none' ? 'Pick a player' : 'Change player'}
                </button>
              </div>
            )}
            {!showPlayerPicker && (
              <>
              {scoreTemplate != null && scoreRead && hasUnknown(scoreRead.template) && (
                <div className="flex flex-col gap-2 mb-2">
                  <p className="flex items-start gap-2 text-xs rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    Display was mid-refresh — fill in the x's from the machine
                  </p>
                  {photoPreviews.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto">
                      {photoPreviews.map((src, i) => (
                        <img
                          key={src}
                          src={src}
                          alt={`Uploaded photo ${i + 1}`}
                          className="max-h-64 rounded-lg border border-white/10 object-contain bg-black flex-shrink-0"
                          style={{ maxWidth: photoPreviews.length > 1 ? '80%' : '100%' }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {scoreTemplate != null ? (
                <ScoreDigitInput
                  value={scoreTemplate}
                  original={scoreRead?.template ?? scoreTemplate}
                  lowConfidence={scoreRead?.lowConfidence ?? []}
                  conflicts={scoreRead?.conflicts ?? []}
                  disagreements={scoreDisagreements}
                  onDismissDisagreement={i => setScoreDisagreements(ds => ds.filter(d => d.index !== i))}
                  onChange={applyScoreTemplate}
                  onPlainMode={enterPlainScoreMode}
                />
              ) : (
                <>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={scoreDisplay}
                    onChange={e => {
                      const raw = e.target.value.replace(/[^0-9]/g, '');
                      setScoreDisplay(raw ? Number(raw).toLocaleString() : '');
                      setValue('score', raw ? Number(raw) : ('' as any));
                    }}
                    placeholder={scoreRead && hasUnknown(scoreRead.template) ? `Photo read ${formatTemplate(scoreRead.template)}` : 'e.g. 21,955,670'}
                    className="input"
                  />
                  {scoreRead && hasUnknown(scoreRead.template) && (
                    <button
                      type="button"
                      onClick={() => applyScoreTemplate(scoreRead.template)}
                      className="text-xs text-muted-foreground hover:text-white transition-colors mt-1"
                    >
                      ‹ Back to filling in the x's
                    </button>
                  )}
                </>
              )}
              {errors.scoreUnfilled
                ? <p className="err">{errors.scoreUnfilled.message}</p>
                : errors.score && <p className="err">{errors.score.message}</p>}
              {missingDigitReasons.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                  <p className="flex items-start gap-2 text-xs text-amber-400 font-bold">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    This score may be missing digits
                  </p>
                  <ul className="mt-1 pl-5 list-disc text-xs text-amber-400/80">
                    {missingDigitReasons.map(r => <li key={r}>{r}</li>)}
                  </ul>
                  <p className="mt-1 pl-5 text-xs text-muted-foreground">Check the machine — you can still save as-is.</p>
                </div>
              )}
              {scoreRead?.alignmentWarning && (
                <p className="mt-2 flex items-start gap-2 text-xs rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  {ALIGNMENT_WARNING}
                </p>
              )}
              </>
            )}
          </div>

          {/* More photos of the same display — re-reads the whole set and merges the digits */}
          {(differentGamesWarning || canAddMore || addBlockedByHeic || (aiError && uploadItems.length > 0)) && (
            <div className="flex flex-col gap-2 -mt-1">
              {differentGamesWarning && (
                <p className="flex items-start gap-2 text-xs rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  {differentGamesWarning}
                </p>
              )}
              {aiError && uploadItems.length > 0 && <p className="text-xs text-yellow-400">{aiError}</p>}
              {photoNotice && <p className="text-xs text-amber-400">{photoNotice}</p>}
              {addBlockedByHeic && (
                <p className="text-xs text-muted-foreground">
                  This photo is HEIC and couldn't be converted on this device, so it can't be combined with more.
                  Upload them together as JPEGs to add another.
                </p>
              )}
              {canAddMore && (
                <>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={aiLoading}
                      onClick={() => addCameraRef.current?.click()}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-primary/40 text-xs font-bold uppercase tracking-wider text-primary hover:border-primary transition-colors disabled:opacity-50"
                    >
                      {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                      {aiLoading ? (videoProgress ?? 'Re-reading...') : `Take another photo (${uploadItems.length}/${MAX_ITEMS})`}
                    </button>
                    <button
                      type="button"
                      disabled={aiLoading}
                      onClick={() => addPhotoRef.current?.click()}
                      className="px-3 py-2 rounded-lg border border-white/10 text-xs font-bold uppercase tracking-wider text-white/70 hover:text-white hover:border-primary/40 transition-colors disabled:opacity-50"
                    >
                      Choose
                    </button>
                  </div>
                  <input
                    ref={addCameraRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) handleFiles(files, 'add', 'camera'); }}
                  />
                  <input
                    ref={addPhotoRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="hidden"
                    onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) handleFiles(files, 'add', 'picker'); }}
                  />
                </>
              )}
            </div>
          )}

          {/* Date & Time */}
          <div>
            <label className="label">Date & Time</label>
            <input {...register('playedAt', { onChange: () => setPlayedAtInstant(null) })} type="datetime-local" className="input" />
          </div>

          {/* Type */}
          <div>
            <label className="label">Type</label>
            <select {...register('type')} className="input">
              <option value="casual">Casual</option>
              <option value="tournament">Tournament</option>
            </select>
          </div>

          {needsPlayerChoice && (
            <p className="text-xs text-amber-400 text-center -mb-2">Pick which player you were before saving</p>
          )}
          {scoreTemplate != null && unknownCount(scoreTemplate) > 0 && (
            <p className="text-xs text-amber-400 text-center -mb-2">
              Fill in every x before saving ({unknownCount(scoreTemplate)} left)
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={goBack}
              className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
              Back
            </button>
            {/* A venue tap now lands here before its Pinball Map match has answered; saving mid-match
                would drop venuePinballMapId (the link the score POST stores on the venue). */}
            <button type="submit" disabled={isSubmitting || createScore.isPending || pmMatchLoading || needsPlayerChoice || (scoreTemplate != null && unknownCount(scoreTemplate) > 0)}
              className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
              {createScore.isPending ? 'Saving...' : pmMatchLoading ? 'Checking venue…' : 'Save Score'}
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
            {fullPhoto.status === 'working' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving full-size photo…
              </p>
            )}
            {fullPhoto.status === 'saved' && (
              <p className="flex items-center gap-1.5 text-xs text-green-400" role="status">
                <CheckCircle2 className="w-3.5 h-3.5" /> Full-size photo saved
              </p>
            )}
            {fullPhoto.status === 'failed' && (
              <p className="flex items-center gap-2 text-xs text-amber-300" role="status">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Couldn't save the full-size photo — the score and thumbnail are saved.</span>
                <button type="button" onClick={() => void runFullPhotoUpload(savedScore.id)}
                  className="font-bold uppercase tracking-wider text-primary hover:text-primary/80 flex-shrink-0">
                  Retry
                </button>
              </p>
            )}
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

function formatDistance(m: number | null | undefined): string | undefined {
  if (m == null) return undefined;
  return m < 1000 ? `${m}m` : `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
}

/** One pickable venue row in the search results — same look as the Nearby / Your Venues rows. */
/** The wizard's top-of-step Back — visible without scrolling past a long step to the bottom row. */
function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start inline-flex items-center gap-1 -ml-1 py-1 pr-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
    >
      <ChevronLeft className="w-4 h-4" />
      {label}
    </button>
  );
}

function VenueOption({ name, address, selected, icon, badges, right, onClick }: {
  name: string;
  address?: string | null;
  selected: boolean;
  icon: 'pin' | 'home';
  badges?: ReactNode;
  right?: string;
  onClick: () => void;
}) {
  const Icon = icon === 'home' ? Home : MapPin;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${selected ? 'border-venue/60 bg-venue/10' : 'border-white/10 hover:border-venue/40 hover:bg-white/5'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${selected ? 'text-venue' : 'text-muted-foreground'}`} />
        <span className={`text-sm font-bold truncate ${selected ? 'text-white' : 'text-white/80'}`}>{name}</span>
        {badges}
        {right && <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{right}</span>}
      </div>
      {address && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-5">{address}</p>}
    </button>
  );
}
