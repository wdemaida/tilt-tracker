import { decodeScaled, withDecodeLock } from './prepareUploadImage';

// A profile photo, made small before it goes to Clerk (user.setProfileImage). Clerk shows avatars at
// a few dozen pixels; a 12MP phone photo would be ~5MB of upload for nothing. Same decode path as
// score photos: decodeScaled (reduced-size decode, EXIF orientation applied), one decode at a time
// via withDecodeLock, then redrawn through a canvas — which also drops EXIF/GPS from the file.

export const AVATAR_MAX_EDGE = 512;
export const AVATAR_JPEG_QUALITY = 0.9;

/** The ≤512px JPEG to upload. Throws a user-facing Error when the image can't be read. */
export function prepareAvatarFile(file: Blob): Promise<File> {
  return withDecodeLock(async () => {
    let decoded;
    try {
      decoded = await decodeScaled(file, AVATAR_MAX_EDGE);
    } catch {
      throw new Error('Couldn’t read that image — try a JPEG or PNG.');
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Couldn’t prepare that image.');
      ctx.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', AVATAR_JPEG_QUALITY));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error('Couldn’t prepare that image.');
      return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
    } finally {
      decoded.close();
    }
  });
}
