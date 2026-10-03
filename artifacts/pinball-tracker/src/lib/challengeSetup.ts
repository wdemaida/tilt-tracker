// New-user challenge setup (the onboarding nudge). Pure helpers, no React:
//  - challengeSetupState: which parts of "Machines you can get to" are filled — preferred machines,
//    preferred venues, the Last Resort area. `any` hides the Home nudge; `all` is just for the ticks.
//  - The Home strip's "Not now" is remembered per user in localStorage only (no DB column — it's a
//    hint, and losing it on another device just shows the strip once more there).
// The nudge links to `/users/<username>?setup=1`, which opens the card with its intro (UserPage).

export interface ChallengeSetupState {
  machines: boolean;
  venues: boolean;
  area: boolean;
  /** At least one part is filled — the nudge goes away. */
  any: boolean;
  /** Every part is filled. */
  all: boolean;
}

export function challengeSetupState(
  prefs: { machines?: unknown[] | null; venues?: unknown[] | null } | null | undefined,
  area: { area?: unknown | null } | null | undefined,
): ChallengeSetupState {
  const machines = (prefs?.machines?.length ?? 0) > 0;
  const venues = (prefs?.venues?.length ?? 0) > 0;
  const hasArea = area?.area != null;
  return { machines, venues, area: hasArea, any: machines || venues || hasArea, all: machines && venues && hasArea };
}

export const nudgeDismissKey = (userId: number | string) => `tilttrack.challengeSetupNudge.dismissed.${userId}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
/** localStorage, or null where even touching it throws (some private modes, blocked site data). */
function defaultStore(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** True once this user has tapped "Not now". Storage missing or throwing → false (show the strip). */
export function readDismissed(userId: number | string, store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  try { return store.getItem(nudgeDismissKey(userId)) === '1'; } catch { return false; }
}

/** Remember "Not now". Storage missing or throwing → not remembered (the caller still hides it for this visit). */
export function writeDismissed(userId: number | string, store: Store | null = defaultStore()): void {
  if (!store) return;
  try { store.setItem(nudgeDismissKey(userId), '1'); } catch { /* not remembered */ }
}

/** Show the Home strip: a signed-in, active user with nothing set up who hasn't dismissed it. */
export function shouldNudge({ me, state, dismissed }: {
  me: { disabledAt?: string | Date | null } | null | undefined;
  state: ChallengeSetupState;
  dismissed: boolean;
}): boolean {
  return !!me && !me.disabledAt && !state.any && !dismissed;
}
