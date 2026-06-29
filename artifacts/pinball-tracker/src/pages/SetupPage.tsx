import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLocation } from 'wouter';
import { PinballIcon } from '../components/PinballIcon';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';

const schema = z.object({
  displayName: z.string().min(1, 'Required'),
  username: z.string().min(2).regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers, and underscores only'),
});

type FormData = z.infer<typeof schema>;

export default function SetupPage() {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const [, navigate] = useLocation();
  const [error, setError] = useState('');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setError('');
    try {
      await api.users.setup({ username: data.username, displayName: data.displayName });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    }
  };

  if (!isLoaded) return null;
  if (!isSignedIn) { navigate('/sign-in'); return null; }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="flex flex-col items-center mb-8 gap-3">
        <div className="w-16 h-16 rounded-2xl bg-primary/20 flex items-center justify-center border border-primary/50">
          <PinballIcon className="w-8 h-8" />
        </div>
        <h1 className="text-3xl font-black uppercase tracking-widest text-white text-center">Set Up Your Profile</h1>
        <p className="text-sm text-muted-foreground text-center">Choose a username and display name to get started</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="rounded-xl border border-white/10 bg-card p-6 flex flex-col gap-4">
        <div>
          <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Display Name
          </label>
          <input
            {...register('displayName')}
            placeholder="Your full name or nickname"
            className="w-full rounded-lg border border-white/10 bg-background px-4 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
          {errors.displayName && <p className="text-xs text-red-400 mt-1">{errors.displayName.message}</p>}
        </div>

        <div>
          <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Username
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
            <input
              {...register('username')}
              placeholder="yourhandle"
              className="w-full rounded-lg border border-white/10 bg-background pl-7 pr-4 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">Letters, numbers, and underscores only</p>
          {errors.username && <p className="text-xs text-red-400">{errors.username.message}</p>}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full py-3 rounded-lg bg-primary text-white font-bold uppercase tracking-wider text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isSubmitting ? 'Setting up...' : '› Let\'s Go'}
        </button>
      </form>
    </div>
  );
}
