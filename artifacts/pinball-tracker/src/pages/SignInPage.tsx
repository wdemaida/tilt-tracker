import { useState } from 'react';
import { useSignIn, useAuth } from '@clerk/clerk-react';
import { Link, useLocation } from 'wouter';
import { enableGuestMode } from '../lib/guestMode';

type Step = 'credentials' | 'mfa' | 'verify_device';

export default function SignInPage() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const { isSignedIn } = useAuth();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeStrategy, setCodeStrategy] = useState('email_code');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleClientTrust() {
    if (!signIn) return;
    const factors = signIn.supportedFirstFactors ?? [];
    const emailFactor = factors.find((f: any) => f.strategy === 'email_code') as any;
    if (emailFactor) {
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: emailFactor.emailAddressId });
      setCodeStrategy('email_code');
      setStep('verify_device');
    } else {
      setError('Device verification required. Please sign in on desktop and try again, or contact support.');
    }
  }

  async function afterAttempt(result: any) {
    if (!signIn) return;
    if (result.status === 'complete') {
      await setActive({ session: result.createdSessionId });
      window.location.assign('/');
    } else if (result.status === 'needs_second_factor') {
      const strategy = signIn.supportedSecondFactors?.[0]?.strategy ?? 'totp';
      setCodeStrategy(strategy);
      if (strategy !== 'totp') {
        await signIn.prepareSecondFactor({ strategy: strategy as any });
      }
      setStep('mfa');
    } else if ((result.status as string) === 'needs_client_trust') {
      await handleClientTrust();
    } else {
      setError('Unexpected sign-in status: ' + result.status);
    }
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || loading) return;
    setLoading(true);
    setError('');
    try {
      const createResult = await signIn!.create({ identifier: email });
      if ((createResult.status as string) === 'needs_client_trust') {
        await handleClientTrust();
        return;
      }
      const result = await signIn!.attemptFirstFactor({ strategy: 'password', password });
      await afterAttempt(result);
    } catch (err: any) {
      setError(err?.errors?.[0]?.longMessage ?? err?.errors?.[0]?.message ?? 'Sign-in failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || loading) return;
    setLoading(true);
    setError('');
    try {
      let result: any;
      if (step === 'mfa') {
        result = await signIn.attemptSecondFactor({ strategy: codeStrategy as any, code });
      } else {
        // verify_device — email_code as first factor
        result = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
      }
      await afterAttempt(result);
    } catch (err: any) {
      setError(err?.errors?.[0]?.longMessage ?? err?.errors?.[0]?.message ?? 'Verification failed.');
    } finally {
      setLoading(false);
    }
  }

  function handleGuest() {
    enableGuestMode();
    navigate('/');
  }

  if (isSignedIn) { navigate('/'); return null; }

  const inputClass = 'border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 w-full';

  return (
    <div className="flex flex-col items-center py-6 sm:py-16 px-4 gap-6">
      <div className="text-center">
        <h1 className="text-3xl font-black uppercase tracking-widest text-white">Welcome Back</h1>
        <p className="text-sm text-muted-foreground mt-1">Sign in to track your pinball scores</p>
      </div>

      {step === 'credentials' && (
        <form onSubmit={handleCredentials} className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-sm font-semibold text-gray-700">Email address</label>
            <input
              id="email" type="email" autoComplete="email" required
              value={email} onChange={e => setEmail(e.target.value)}
              className={inputClass} placeholder="you@example.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm font-semibold text-gray-700">Password</label>
            <input
              id="password" type="password" autoComplete="current-password" required
              value={password} onChange={e => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <button
            type="submit" disabled={loading || !isLoaded}
            className="w-full bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white rounded-lg py-3 font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Continue'}
          </button>
          <p className="text-center text-sm text-gray-500">
            Don't have an account?{' '}
            <Link href="/sign-up" className="text-violet-600 font-semibold hover:underline">Sign up</Link>
          </p>
        </form>
      )}

      {step === 'credentials' && (
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
      )}

      {(step === 'mfa' || step === 'verify_device') && (
        <form onSubmit={handleCode} className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6 flex flex-col gap-4">
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-700">
              {step === 'verify_device'
                ? 'Check your email for a verification code to confirm this device'
                : codeStrategy === 'totp'
                  ? 'Enter the code from your authenticator app'
                  : 'Enter the verification code we sent you'}
            </p>
          </div>
          <input
            type="text" inputMode="numeric" autoComplete="one-time-code" required
            value={code} onChange={e => setCode(e.target.value)}
            className={inputClass + ' text-center text-lg tracking-widest'}
            placeholder="000000" maxLength={6}
          />
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <button
            type="submit" disabled={loading || !isLoaded}
            className="w-full bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white rounded-lg py-3 font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {loading ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" onClick={() => { setStep('credentials'); setError(''); setCode(''); }}
            className="text-sm text-gray-500 hover:text-gray-700">
            ← Back
          </button>
        </form>
      )}
    </div>
  );
}
