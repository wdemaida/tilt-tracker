import { useEffect, useRef } from 'react';
import { SignUp } from '@clerk/clerk-react';

export default function SignUpPage() {
  const containerRef = useRef<HTMLDivElement>(null);

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
    </div>
  );
}
