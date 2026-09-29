// Stale-tab guard. Each build bakes its id into the bundle (vite.config.ts) and ships /version.json
// with the same id. A tab left open across a deploy keeps running the old bundle — a score posted
// from one (2026-09-25) went through a code path the new client no longer had. When the tab comes
// back to the foreground (at most every CHECK_EVERY_MS) we fetch /version.json; a different id means a
// newer deploy, and UpdateBanner offers a reload. Never reloads by itself — that would throw away a
// score half-entered in the Add Score wizard.

/** This bundle's build id — also sent to the api-server as X-App-Version (api.ts). */
export const APP_BUILD_ID: string = import.meta.env.VITE_APP_BUILD_ID ?? 'unknown';

export const CHECK_EVERY_MS = 10 * 60_000;

/** The deployed build id, or null when it can't be read (offline, dev server, no file). Never throws. */
export async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.buildId === 'string' ? body.buildId : null;
  } catch {
    return null;
  }
}
