import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import App from './App';
import './index.css';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/setup"
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
);
