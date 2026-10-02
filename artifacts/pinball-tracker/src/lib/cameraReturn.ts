// "Take photo" hands control to the camera app, which runs on top of the browser. On a phone short
// on memory (seen: Galaxy S23 Ultra, Vivaldi with ~100 tabs) Android closes the browser while the
// camera is up, and when the camera finishes the browser reloads /add with no photo. We can't fix the
// handoff, so the Add Score page records a pending capture before opening the camera and, if it comes
// back to a fresh record with no photo, points the user at taking it in the camera app and uploading.
//
// localStorage because the record has to survive the tab being killed. Every access is wrapped:
// storage can throw (private mode, blocked site data) and the hint is never worth breaking the page.

const KEY = 'tilttrack-camera-pending';

/** A pending capture older than this is from some earlier visit, not a camera that just came back. */
export const CAMERA_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Call as the camera opens. */
export function markCameraPending(now = Date.now(), store = defaultStore()): void {
  try { store?.setItem(KEY, String(now)); } catch { /* storage unavailable — no hint, nothing else lost */ }
}

/** Call once a photo arrives by any route. */
export function clearCameraPending(store = defaultStore()): void {
  try { store?.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Was a capture started within CAMERA_PENDING_MAX_AGE_MS and never answered? Consumes the record
 * either way, so the hint shows once per failure rather than on every later visit.
 */
export function takeFreshCameraPending(now = Date.now(), store = defaultStore()): boolean {
  let raw: string | null = null;
  try { raw = store?.getItem(KEY) ?? null; } catch { return false; }
  if (raw == null) return false;
  clearCameraPending(store);
  const at = Number(raw);
  return Number.isFinite(at) && at <= now && now - at <= CAMERA_PENDING_MAX_AGE_MS;
}
