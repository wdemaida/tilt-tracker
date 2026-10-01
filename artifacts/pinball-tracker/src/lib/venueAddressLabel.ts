// What a venue with no address shows in place of one — the venue page header and the Venues list.
//
// "Address hidden" is only true when this viewer gets the redacted view: someone else's private
// venue (the server sends `isPrivate`, and no `canEdit`). The owner and admins get the real row, so a
// missing address there really is missing — Will's Basement read "Address hidden" at Full address
// because its stored address was empty. Anyone else looking at a public venue with no address gets
// nothing (the Venues list has its own "Needs address" badge for people who can fix it).

export type MissingAddressLabel = 'hidden' | 'none_on_file' | null;

export function missingAddressLabel(v: { isPrivate?: boolean; canEdit?: boolean }): MissingAddressLabel {
  if (v.canEdit) return 'none_on_file';
  if (v.isPrivate) return 'hidden';
  return null;
}
