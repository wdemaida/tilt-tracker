import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';

// A user's profile photo, or a neutral person icon when there's none (or it fails to load). Photos
// are hosted by Clerk; the server sends `imageUrl` to signed-in viewers only, so a signed-out
// visitor always gets the icon. Used by the profile header and AvatarMenu (other surfaces later).

const SIZES = {
  sm: { box: 'w-8 h-8', icon: 'w-4 h-4' },
  lg: { box: 'w-16 h-16 sm:w-20 sm:h-20', icon: 'w-8 h-8 sm:w-10 sm:h-10' },
} as const;

export default function UserAvatar({ imageUrl, size = 'sm', className = '' }: {
  imageUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  const s = SIZES[size];
  if (imageUrl && !failed) {
    return (
      <img src={imageUrl} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer"
        className={`${s.box} rounded-full object-cover border border-white/15 bg-card flex-shrink-0 ${className}`} />
    );
  }
  return (
    <span className={`${s.box} rounded-full bg-white/10 border border-white/15 flex items-center justify-center flex-shrink-0 ${className}`}>
      <UserRound className={`${s.icon} text-white/80`} aria-hidden />
    </span>
  );
}
