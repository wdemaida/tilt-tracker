const GUEST_KEY = 'tilttrack_guest_mode';

export function isGuestMode(): boolean {
  return localStorage.getItem(GUEST_KEY) === '1';
}

export function enableGuestMode(): void {
  localStorage.setItem(GUEST_KEY, '1');
}

export function clearGuestMode(): void {
  localStorage.removeItem(GUEST_KEY);
}
