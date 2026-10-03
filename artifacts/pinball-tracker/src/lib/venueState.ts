// The US state a venue address is in, for the Venues page's and the machine venues modal's state
// filters. Always run it on the address the server sent — already redacted per privacy tier — so a
// hidden-tier home (address null) never matches a state: privacy by construction. `venues.state` is
// sparse, so the address is the better source.
//
// Addresses look like "..., City, ST" or "..., City, ST ZIP, United States" — the state
// abbreviation is whichever comma-separated segment starts with two uppercase letters.
export function parseState(address: string | null | undefined): string | null {
  if (!address) return null;
  const segments = address.split(',').map(s => s.trim());
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = segments[i].match(/^([A-Z]{2})\b/);
    if (m) return m[1];
  }
  return null;
}
