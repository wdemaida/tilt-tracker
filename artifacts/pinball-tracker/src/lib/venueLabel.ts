/**
 * A private venue's owner, as the label beside its name: several people can call their home "HOME",
 * so it reads "HOME (@collasta)". The server decides whether the handle may be shown at all
 * (`ownerUsername` / `venueOwnerUsername` — null for public venues, and for someone's home whose
 * "Show my machines/scores publicly" switch is off; see api-server venueOwner.ts). Your own home reads
 * "HOME (you)" — your handle there would just be noise, but a plain "HOME" could be mistaken for a
 * stranger's home whose switch is off.
 *
 * `<VenueName>` renders it (the handle as a profile link); this is the plain-text form for places
 * that need a string — a title, an aria-label, a <select> option.
 */
export type VenueOwnerLabel = { kind: 'you' } | { kind: 'handle'; username: string } | null;

export function venueOwnerLabel(ownerUsername: string | null | undefined, myUsername: string | null | undefined): VenueOwnerLabel {
  if (!ownerUsername) return null;
  if (myUsername && ownerUsername.toLowerCase() === myUsername.toLowerCase()) return { kind: 'you' };
  return { kind: 'handle', username: ownerUsername };
}

export function venueLabel(name: string, ownerUsername: string | null | undefined, myUsername: string | null | undefined): string {
  const owner = venueOwnerLabel(ownerUsername, myUsername);
  if (!owner) return name;
  return owner.kind === 'you' ? `${name} (you)` : `${name} (@${owner.username})`;
}
