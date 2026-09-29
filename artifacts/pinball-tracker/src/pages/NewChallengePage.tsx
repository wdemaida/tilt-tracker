import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, Check, Home, Info, Loader2, MapPin, Minus, Plus, Swords, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { useMyFriends } from '../lib/myFriends';
import { toLocalInput, localInputToIso } from '../lib/datetime';
import { MachineThumb } from '../components/ChallengeParts';
import MachinePicker, { nameMatches, pickerInputClass, type MachineOption } from '../components/MachinePicker';
import {
  TYPE_META, TYPE_ORDER, SCORE_RULES, REC_LEVEL_LABEL, challengeErrorText, challengeKey, recommendationsKey,
  invalidateChallengeQueries, formatScore, formatDuration,
} from '../lib/challenges';
import type { ChallengeRecommendation, ChallengeType, ChallengeVenueOption as VenueOption, CreateChallengeBody, PodUser } from '../lib/api';

// /challenges/new — one form, top to bottom: who, what machine, what kind, when, where, send.
// Prefill with `?friend=<username>&machine=<id>[&mode=exact]` (the Friends tab, a profile and a
// machine page link here). Everything is validated again on the server; its error codes map to
// challengeErrorText().
//
// Once a friend is picked, "Recommended for @friend" lists machines they can reach (their "Challenge
// me on" picks, machines at venues they can get to, machines they played lately) — picking one sets
// the exact model, since a Pro and a Premium can play very differently.
//
// `?counterOf=<id>` — a counter-offer ("can't get to this one"): the friend is the original's
// challenger (fixed), type and duration are prefilled from it, and sending goes to
// POST /challenges/:id/counter, which ends the original as countered.

const DAY = 86_400_000;
const END_PRESETS = [
  { key: '3d', label: '3 days', ms: 3 * DAY },
  { key: '1w', label: '1 week', ms: 7 * DAY },
  { key: '2w', label: '2 weeks', ms: 14 * DAY },
  { key: 'custom', label: 'Custom', ms: 0 },
] as const;
type EndKey = (typeof END_PRESETS)[number]['key'];

function Step({ n, title, children, hint }: { n: number; title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-card p-4 mb-4">
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white mb-1">
        <span className="w-5 h-5 rounded-full bg-white/10 text-[10px] flex items-center justify-center text-white/80">{n}</span>
        {title}
      </h2>
      {hint && <p className="text-xs text-muted-foreground mb-3">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 p-1 rounded-lg bg-white/5 border border-white/10">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-colors ${
            value === o.value ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const inputClass = pickerInputClass;

/** One recommendation row: pick it to challenge on that exact machine. */
function RecommendationRow({ r, onPick }: { r: ChallengeRecommendation; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex items-center gap-3 rounded-lg border border-white/10 px-2.5 py-2 text-left hover:border-machine/50 transition-colors"
    >
      <MachineThumb name={r.name} imageUrl={r.imageUrl} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-machine truncate">{r.name}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {r.venueLabel && (
            r.venueLabel === 'at home'
              ? <span className="inline-flex items-center gap-1"><Home className="w-3 h-3" aria-hidden /> at home</span>
              : <span className="inline-flex items-center gap-1 text-venue min-w-0"><MapPin className="w-3 h-3 flex-shrink-0" aria-hidden /><span className="truncate">{r.venueLabel}</span></span>
          )}
          {r.viewerBest != null && <span>Your best <span className="text-primary font-semibold">{formatScore(r.viewerBest)}</span></span>}
        </span>
      </span>
      {r.viewerCanReach && (
        <span className="flex-shrink-0 rounded-md border border-friend/40 bg-friend/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-friend">
          You can reach it too
        </span>
      )}
    </button>
  );
}

/** A preset matching `ms` within an hour, else 'custom'. */
function presetFor(ms: number): EndKey {
  return END_PRESETS.find(p => p.ms && Math.abs(p.ms - ms) < 60 * 60 * 1000)?.key ?? 'custom';
}

export default function NewChallengePage() {
  const api = useApi();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const counterOf = Number(params.get('counterOf')) || null;
  const prefillFriend = counterOf ? null : params.get('friend');
  const prefillMachine = Number(params.get('machine')) || null;
  const prefillExact = params.get('mode') === 'exact';

  const { friends, isLoading: friendsLoading } = useMyFriends();
  const { data: allMachines = [], isLoading: machinesLoading } = useQuery({
    queryKey: ['machines', 'all-for-challenge'],
    queryFn: () => api.machines.list(false) as Promise<MachineOption[]>,
    staleTime: 60_000,
  });
  const { data: myMachines = [] } = useQuery({
    queryKey: ['machines', 'mine-for-challenge'],
    queryFn: () => api.machines.list(true) as Promise<MachineOption[]>,
    staleTime: 60_000,
  });

  // ── form state ──
  const [friend, setFriend] = useState<PodUser | null>(null);
  const [machineId, setMachineId] = useState<number | null>(prefillMachine);
  const [matchMode, setMatchMode] = useState<'game' | 'exact'>(prefillExact ? 'exact' : 'game');
  const [type, setType] = useState<ChallengeType | null>(null);
  const [raceTarget, setRaceTarget] = useState<'mine' | 'number'>('mine');
  const [targetText, setTargetText] = useState('');
  const [minPlays, setMinPlays] = useState(3);
  const [startMode, setStartMode] = useState<'accept' | 'date'>('accept');
  const [startInput, setStartInput] = useState(() => toLocalInput(new Date(Date.now() + DAY)));
  const [endKey, setEndKey] = useState<EndKey>('1w');
  const [endInput, setEndInput] = useState(() => toLocalInput(new Date(Date.now() + 7 * DAY)));
  const [venueLocked, setVenueLocked] = useState(false);
  const [venue, setVenue] = useState<VenueOption | null>(null);
  const [venueQuery, setVenueQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Prefill the friend once the list arrives.
  useEffect(() => {
    if (!prefillFriend || friend) return;
    const f = friends.find(x => x.user.username.toLowerCase() === prefillFriend.toLowerCase());
    if (f) setFriend(f.user);
  }, [prefillFriend, friends, friend]);
  const prefillNotFriend = !!prefillFriend && !friendsLoading && !friends.some(x => x.user.username.toLowerCase() === prefillFriend.toLowerCase());

  // ── counter-offer mode ──
  const originalQuery = useQuery({
    queryKey: challengeKey(counterOf ?? 0),
    queryFn: () => api.challenges.get(counterOf!),
    enabled: counterOf != null,
    retry: false,
  });
  const original = originalQuery.data ?? null;
  const originalCreator = original?.participants.find(p => p.isCreator)?.user ?? null;
  const prefilledFromOriginal = useRef(false);
  useEffect(() => {
    if (!original || prefilledFromOriginal.current || friendsLoading) return;
    prefilledFromOriginal.current = true;
    const f = friends.find(x => x.user.id === originalCreator?.id);
    if (f) setFriend(f.user);
    setType(original.type);
    if (original.type === 'average' && original.minPlays) setMinPlays(original.minPlays);
    // Same length of challenge, counted from now.
    const length = +new Date(original.endsAt) - +new Date(original.startsAt ?? original.createdAt);
    const key = presetFor(length);
    setEndKey(key);
    if (key === 'custom') setEndInput(toLocalInput(new Date(Date.now() + Math.max(length, 60 * 60 * 1000))));
  }, [original, originalCreator, friends, friendsLoading]);
  const counterBlocked = counterOf != null && (originalQuery.isError || (!!original && !(original.me.canCounter ?? original.me.canDecline)));
  const counterNotFriend = counterOf != null && !!original && !friendsLoading && !friends.some(x => x.user.id === originalCreator?.id);

  // ── recommendations for the picked friend ──
  const recsQuery = useQuery({
    queryKey: recommendationsKey(friend?.username ?? ''),
    queryFn: () => api.challenges.recommendations(friend!.username),
    enabled: !!friend,
    staleTime: 60_000,
    retry: false,
  });
  const recs = recsQuery.data?.recommendations ?? [];
  const recLevels = ([1, 2, 3] as const).map(level => ({ level, items: recs.filter(r => r.level === level) })).filter(g => g.items.length);

  const recPick = recs.find(r => r.machineId === machineId);
  const machine: MachineOption | null = allMachines.find(m => m.id === machineId)
    ?? (recPick ? { id: recPick.machineId, name: recPick.name, imageUrl: recPick.imageUrl } : null);
  const myBest = machineId != null ? myMachines.find(m => m.id === machineId)?.bestScore ?? recPick?.viewerBest ?? null : null;
  const pickRecommendation = (r: ChallengeRecommendation) => { setMachineId(r.machineId); setMatchMode('exact'); };

  // Only public venues that have the machine (in the chosen match mode) — the server re-checks on
  // send and answers machine_not_at_venue if Pinball Map has since moved it.
  const venueOptionsQuery = useQuery({
    queryKey: ['challenges', 'venue-options', machineId, matchMode],
    queryFn: () => api.challenges.venueOptions(machineId!, matchMode),
    enabled: machineId != null,
    staleTime: 60_000,
  });
  const venueOptions = venueOptionsQuery.data ?? [];
  const venueResults = useMemo(() => {
    const q = venueQuery.trim();
    return (q ? venueOptions.filter(v => nameMatches(v.name, q)) : venueOptions).slice(0, 8);
  }, [venueQuery, venueOptions]);
  // A different machine or match mode can rule out the venue already picked: drop it once the new
  // list says so (and drop it outright if the machine is cleared).
  useEffect(() => {
    if (!venue) return;
    if (machineId == null) { setVenue(null); return; }
    if (venueOptionsQuery.isSuccess && !venueOptionsQuery.data.some(v => v.id === venue.id)) setVenue(null);
  }, [venue, machineId, venueOptionsQuery.isSuccess, venueOptionsQuery.data]);

  // ── window ──
  const now = Date.now();
  const startMs = startMode === 'date' && startInput ? +new Date(localInputToIso(startInput)) : null;
  const preset = END_PRESETS.find(p => p.key === endKey)!;
  const endMs = endKey === 'custom'
    ? (endInput ? +new Date(localInputToIso(endInput)) : NaN)
    : (startMs ?? now) + preset.ms;

  const targetNum = targetText.trim() ? Number(targetText.replace(/[^0-9]/g, '')) : NaN;
  const typeReady = type != null && (type !== 'race' || raceTarget === 'mine' || (Number.isInteger(targetNum) && targetNum > 0));
  const venueReady = !venueLocked || !!venue;
  const windowReady = Number.isFinite(endMs) && (startMode === 'accept' || (startMs != null && Number.isFinite(startMs)));
  const ready = !!friend && !!machine && typeReady && venueReady && windowReady && !counterBlocked;

  const send = useMutation({
    mutationFn: async () => {
      const body: CreateChallengeBody = {
        friendId: friend!.id,
        type: type!,
        machineId: machine!.id,
        matchMode,
        endsAt: new Date(endMs).toISOString(),
      };
      if (startMode === 'date' && startMs != null) body.startsAt = new Date(startMs).toISOString();
      if (type === 'race' && raceTarget === 'number') body.targetScore = targetNum;
      if (type === 'average') body.minPlays = minPlays;
      if (venueLocked && venue) body.venueId = venue.id;
      if (counterOf != null) {
        const { friendId: _f, ...rest } = body;
        return (await api.challenges.counter(counterOf, rest)).counter;
      }
      return api.challenges.create(body);
    },
    onSuccess: c => { invalidateChallengeQueries(); navigate(`/challenges/${c.id}`); },
    onError: e => setError(challengeErrorText(e, counterOf != null ? 'Could not send the counter-offer' : 'Could not send the challenge')),
  });

  const durationText = Number.isFinite(endMs) ? formatDuration(endMs - (startMs ?? now)) : null;

  return (
    <div className="max-w-2xl">
      <Link href={counterOf ? `/challenges/${counterOf}` : '/crew?tab=challenges'} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> {counterOf ? 'Back to the challenge' : 'Challenges'}
      </Link>
      <h1 className={`text-3xl font-black uppercase tracking-widest text-white flex items-center gap-3 ${counterOf ? 'mb-2' : 'mb-6'}`}>
        <Swords className="w-7 h-7 text-friend" aria-hidden /> {counterOf ? 'Suggest another machine' : 'New challenge'}
      </h1>
      {counterOf != null && (
        <div className="mb-6 text-sm text-muted-foreground">
          {originalQuery.isLoading ? (
            <p className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the challenge…</p>
          ) : originalQuery.isError ? (
            <p className="text-red-400">{challengeErrorText(originalQuery.error, 'Could not load the challenge you’re answering')}</p>
          ) : original && (
            <p>
              Can’t get to <span className="text-machine font-semibold">{original.machine.name}</span>? Offer{' '}
              {originalCreator ? <span className="text-friend font-semibold">@{originalCreator.username}</span> : 'them'} a machine you can both play.
              Sending it answers their challenge — it shows as countered, not declined.
              {counterBlocked && <span className="block mt-1 text-amber-300">This challenge can’t be answered any more.</span>}
            </p>
          )}
        </div>
      )}

      {/* 1 — friend */}
      <Step n={1} title="Who" hint={counterOf ? 'The counter-offer goes to whoever challenged you.' : 'Only your friends can be challenged.'}>
        {counterOf ? (
          friend ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-friend bg-friend/15 text-friend text-sm">
              <Check className="w-3.5 h-3.5" aria-hidden />
              <span className="font-semibold">{friend.displayName}</span>
              <span className="text-friend/80">@{friend.username}</span>
            </span>
          ) : counterNotFriend ? (
            <p className="text-xs text-amber-300">You’re no longer friends with @{originalCreator?.username}, so you can’t send them a counter-offer.</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
          )
        ) : friendsLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading friends…</p>
        ) : friends.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have no friends yet. <Link href="/crew" className="text-friend hover:underline">Find the people you play with</Link> first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {friends.map(({ user }) => {
              const on = friend?.id === user.id;
              return (
                <button
                  key={user.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFriend(on ? null : user)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-colors ${
                    on ? 'border-friend bg-friend/15 text-friend' : 'border-white/15 text-white/80 hover:border-friend/50'
                  }`}
                >
                  {on && <Check className="w-3.5 h-3.5" aria-hidden />}
                  <span className="font-semibold">{user.displayName}</span>
                  <span className={on ? 'text-friend/80' : 'text-muted-foreground'}>@{user.username}</span>
                </button>
              );
            })}
          </div>
        )}
        {prefillNotFriend && (
          <p className="text-xs text-amber-300 mt-2">@{prefillFriend} isn’t your friend yet — you can only challenge friends.</p>
        )}
      </Step>

      {/* 2 — machine */}
      <Step n={2} title="Machine">
        {machine ? (
          <div className="flex items-center gap-3">
            <MachineThumb name={machine.name} imageUrl={machine.imageUrl} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold uppercase tracking-wider text-machine break-words">{machine.name}</p>
              <p className="text-xs text-muted-foreground">
                {[machine.manufacturer, machine.year].filter(Boolean).join(' · ')}
                {myBest != null && <>{(machine.manufacturer || machine.year) ? ' · ' : ''}Your best <span className="text-primary font-semibold">{formatScore(myBest)}</span></>}
              </p>
            </div>
            <button type="button" onClick={() => setMachineId(null)} className="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white px-2 py-1">
              Change
            </button>
          </div>
        ) : (
          <>
            {friend && (recsQuery.isLoading || recLevels.length > 0) && (
              <div className="mb-4 rounded-lg border border-friend/25 bg-friend/5 p-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-friend mb-2">Recommended for @{friend.username}</p>
                {recsQuery.isLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Finding machines they can reach…</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {recLevels.map(g => (
                      <div key={g.level}>
                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{REC_LEVEL_LABEL[g.level]}</p>
                        <div className="flex flex-col gap-1.5">
                          {g.items.map(r => <RecommendationRow key={r.machineId} r={r} onPick={() => pickRecommendation(r)} />)}
                        </div>
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground">Picking one challenges on that exact model.</p>
                  </div>
                )}
              </div>
            )}
            <MachinePicker
              allMachines={allMachines}
              myMachines={myMachines}
              loading={machinesLoading}
              onPick={m => setMachineId(m.id)}
            />
          </>
        )}
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Which models count</p>
          <Segmented
            label="Which models count"
            value={matchMode}
            onChange={setMatchMode}
            options={[{ value: 'game', label: 'Any model' }, { value: 'exact', label: 'Exact model' }]}
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            {matchMode === 'game'
              ? 'Pro, Premium and LE of the same game all count.'
              : 'Only this exact model counts.'}
          </p>
        </div>
      </Step>

      {/* 3 — type */}
      <Step n={3} title="Type of challenge">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TYPE_ORDER.map(t => {
            const on = type === t;
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setType(t)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  on ? 'border-primary bg-primary/10' : 'border-white/10 hover:border-white/25'
                }`}
              >
                <span className={`block text-sm font-black uppercase tracking-wider ${on ? 'text-white' : 'text-white/90'}`}>{TYPE_META[t].label}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{TYPE_META[t].blurb}</span>
              </button>
            );
          })}
        </div>

        {type === 'race' && (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Target to beat</p>
            <Segmented
              label="Target to beat"
              value={raceTarget}
              onChange={setRaceTarget}
              options={[
                { value: 'mine', label: myBest != null ? `Beat my best (${formatScore(myBest)})` : 'Beat my best' },
                { value: 'number', label: 'Pick a number' },
              ]}
            />
            {raceTarget === 'mine' ? (
              <p className="text-xs text-muted-foreground mt-1.5">
                {myBest != null
                  ? <>Your best when you send it{matchMode === 'game' ? ' — on any model of this game, if that’s higher' : ''}. It has to be beaten, not matched.</>
                  : 'Uses your best score on this machine when you send it — you need one first.'}
              </p>
            ) : (
              <input
                inputMode="numeric"
                value={targetText ? Number(targetText.replace(/[^0-9]/g, '') || 0).toLocaleString() : ''}
                onChange={e => setTargetText(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="e.g. 50,000,000"
                aria-label="Target score"
                className={`${inputClass} mt-2 max-w-xs`}
              />
            )}
            <p className="text-xs text-muted-foreground mt-1.5">First to beat it wins instantly. If nobody does by the end, it’s abandoned — no winner.</p>
          </div>
        )}
        {type === 'average' && (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Minimum plays to qualify</p>
            <div className="inline-flex items-center gap-2">
              <button type="button" aria-label="Fewer plays" disabled={minPlays <= 3} onClick={() => setMinPlays(n => Math.max(3, n - 1))}
                className="w-9 h-9 rounded-lg border border-white/15 flex items-center justify-center text-white disabled:opacity-30 hover:border-white/30">
                <Minus className="w-4 h-4" />
              </button>
              <span className="w-10 text-center text-xl font-black text-white" aria-live="polite">{minPlays}</span>
              <button type="button" aria-label="More plays" disabled={minPlays >= 10} onClick={() => setMinPlays(n => Math.min(10, n + 1))}
                className="w-9 h-9 rounded-lg border border-white/15 flex items-center justify-center text-white disabled:opacity-30 hover:border-white/30">
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Every counting score goes into the average. If nobody reaches {minPlays} plays, it’s abandoned.</p>
          </div>
        )}
        {type === 'most_improved' && (
          <p className="text-xs text-muted-foreground mt-3 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />
            You both need a score on this machine from before the challenge starts — that’s what improvement is measured from.
          </p>
        )}
      </Step>

      {/* 4 — window */}
      <Step n={4} title="When">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Starts</p>
        <Segmented
          label="Starts"
          value={startMode}
          onChange={setStartMode}
          options={[{ value: 'accept', label: 'When they accept' }, { value: 'date', label: 'Pick a time' }]}
        />
        {startMode === 'date' && (
          <>
            <input type="datetime-local" value={startInput} onChange={e => setStartInput(e.target.value)} aria-label="Start time"
              className={`${inputClass} mt-2 max-w-xs [color-scheme:dark]`} />
            <p className="text-xs text-muted-foreground mt-1.5">If they haven’t accepted by then, the challenge expires.</p>
          </>
        )}
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-4 mb-1.5">
          Ends {endKey !== 'custom' && (startMode === 'accept' ? '— counted from now' : '— after the start')}
        </p>
        <Segmented
          label="Ends"
          value={endKey}
          onChange={k => {
            setEndKey(k);
            if (k === 'custom' && Number.isFinite(endMs)) setEndInput(toLocalInput(new Date(endMs)));
          }}
          options={END_PRESETS.map(p => ({ value: p.key, label: p.label }))}
        />
        {endKey === 'custom' && (
          <input type="datetime-local" value={endInput} onChange={e => setEndInput(e.target.value)} aria-label="End time"
            className={`${inputClass} mt-2 max-w-xs [color-scheme:dark]`} />
        )}
        {Number.isFinite(endMs) && (
          <p className="text-xs text-muted-foreground mt-1.5">
            Ends {new Date(endMs).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {durationText && <> · runs up to {durationText}</>}.
            {startMode === 'accept' && ' The end time is fixed, so a slow accept shortens it.'}
          </p>
        )}
      </Step>

      {/* 5 — venue */}
      <Step n={5} title="Where" hint="Optional: only scores at one venue count.">
        <Segmented
          label="Venue"
          value={venueLocked ? 'one' : 'any'}
          onChange={v => setVenueLocked(v === 'one')}
          options={[{ value: 'any', label: 'Any venue' }, { value: 'one', label: 'One venue' }]}
        />
        {venueLocked && (
          venue ? (
            <div className="mt-3 flex items-center gap-2">
              <MapPin className="w-4 h-4 text-venue flex-shrink-0" aria-hidden />
              <span className="text-sm text-venue font-semibold flex-1 min-w-0 truncate">{venue.name}</span>
              <button type="button" onClick={() => setVenue(null)} aria-label="Clear venue" className="p-1 text-muted-foreground hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <input type="search" value={venueQuery} onChange={e => setVenueQuery(e.target.value)}
                placeholder={machine ? `Search venues with ${machine.name}…` : 'Search public venues…'}
                aria-label="Search venues" className={inputClass} disabled={!machine} />
              <div className="mt-2 flex flex-col gap-1">
                {venueResults.map(v => (
                  <button key={v.id} type="button" onClick={() => { setVenue(v); setVenueQuery(''); }}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2 text-left hover:border-venue/50 transition-colors">
                    <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" aria-hidden />
                    <span className="text-sm text-venue truncate flex-1 min-w-0">{v.name}</span>
                    {(v.city || v.state) && <span className="text-[11px] text-muted-foreground flex-shrink-0">{[v.city, v.state].filter(Boolean).join(', ')}</span>}
                  </button>
                ))}
                {!machine ? (
                  <p className="text-xs text-muted-foreground">Pick a machine first — only venues that have it can be chosen.</p>
                ) : venueOptionsQuery.isLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Finding venues with this machine…</p>
                ) : venueOptionsQuery.isError ? (
                  <p className="text-xs text-red-300">{challengeErrorText(venueOptionsQuery.error)}</p>
                ) : venueOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No public venue on TiltTrack has {matchMode === 'game' ? 'any model of this game' : 'this exact model'} right now. Home venues can’t be used.</p>
                ) : venueResults.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No venue with this machine matches “{venueQuery.trim()}”.</p>
                ) : null}
              </div>
            </div>
          )
        )}
      </Step>

      {/* review */}
      <section className="rounded-xl border border-friend/30 bg-friend/5 p-4 mb-4">
        <h2 className="text-xs font-bold uppercase tracking-widest text-friend mb-2">Review</h2>
        <ul className="text-sm text-white/85 space-y-1">
          <li>{friend ? <>vs <span className="text-friend font-semibold">@{friend.username}</span></> : <span className="text-muted-foreground">Pick a friend</span>}</li>
          <li>{machine ? <><span className="text-machine font-semibold">{machine.name}</span> · {matchMode === 'game' ? 'any model' : 'exact model'}</> : <span className="text-muted-foreground">Pick a machine</span>}</li>
          <li>
            {type ? <>
              {TYPE_META[type].label}
              {type === 'race' && (raceTarget === 'number'
                ? (Number.isFinite(targetNum) && targetNum > 0 ? <> · beat <span className="text-primary font-semibold">{formatScore(targetNum)}</span></> : ' · enter a target')
                : <> · beat your best{myBest != null && <> (<span className="text-primary font-semibold">{formatScore(myBest)}</span>)</>}</>)}
              {type === 'average' && <> · at least {minPlays} plays</>}
            </> : <span className="text-muted-foreground">Pick a type</span>}
          </li>
          <li>{startMode === 'accept' ? 'Starts when they accept' : startMs ? `Starts ${new Date(startMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Pick a start time'}
            {Number.isFinite(endMs) && <> · ends {new Date(endMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}</li>
          <li>{venueLocked ? (venue ? <>Only at <span className="text-venue font-semibold">{venue.name}</span></> : <span className="text-muted-foreground">Pick a venue</span>) : 'Any venue'}</li>
        </ul>
        <ul className="mt-3 pt-3 border-t border-white/10 text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
          {SCORE_RULES.map(r => <li key={r}>{r}</li>)}
        </ul>
      </section>

      {error && <p className="text-sm text-red-400 mb-3" role="alert">{error}</p>}

      <button
        type="button"
        disabled={!ready || send.isPending}
        onClick={() => { setError(null); send.mutate(); }}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-friend text-zinc-950 text-sm font-black uppercase tracking-wider hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Swords className="w-4 h-4" aria-hidden />}
        {counterOf ? 'Send counter-offer' : 'Send challenge'}
      </button>
    </div>
  );
}
