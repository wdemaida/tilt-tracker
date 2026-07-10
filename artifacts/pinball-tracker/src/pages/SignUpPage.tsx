import { useEffect, useRef } from 'react';
import { SignUp } from '@clerk/clerk-react';
import { useLocation } from 'wouter';
import { enableGuestMode } from '../lib/guestMode';

export default function SignUpPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  function handleGuest() {
    enableGuestMode();
    navigate('/');
  }

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const scrollButtonIntoView = () => {
      if (!containerRef.current) return;
      const btn = containerRef.current.querySelector<HTMLElement>('.cl-formButtonPrimary');
      if (!btn) return;
      const btnBottom = btn.getBoundingClientRect().bottom;
      const visibleBottom = vv.offsetTop + vv.height;
      if (btnBottom > visibleBottom - 8) {
        window.scrollBy({ top: btnBottom - visibleBottom + 24, behavior: 'smooth' });
      }
    };

    vv.addEventListener('resize', scrollButtonIntoView);
    return () => vv.removeEventListener('resize', scrollButtonIntoView);
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col items-center justify-center py-4 sm:py-16 gap-6">
      <div className="text-center mb-2">
        <h1 className="text-3xl font-black uppercase tracking-widest text-white">Create Account</h1>
        <p className="text-sm text-muted-foreground mt-1">Start tracking your pinball scores</p>
      </div>
      <SignUp routing="path" path="/sign-up" fallbackRedirectUrl="/setup" signInUrl="/sign-in" />
      <div className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={handleGuest}
          className="text-sm font-semibold text-gray-300 hover:text-white underline underline-offset-2"
        >
          Continue as guest
        </button>
        <p className="text-xs text-muted-foreground text-center max-w-sm">
          Guests can browse scores, machines, and venues, but can't submit their own scores.
        </p>
      </div>
    </div>
  );
}
