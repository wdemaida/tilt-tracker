import type { ReactNode } from 'react';

// A tiny app-wide toast store (no dependency). `toast()` from anywhere; <Toaster /> (mounted once
// in Layout) renders the stack. Toasts are for confirmation and passive news ("Saved", "You earned
// a badge") — anything the user must act on or read carefully stays inline where it happened, and
// errors that need fixing stay next to the field. Kinds: success | error | info.

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  title: ReactNode;
  body?: ReactNode;
  tone?: ToastTone;
  /** Replaces the tone icon (e.g. a BadgeImage). */
  icon?: ReactNode;
  /** Makes the toast a link (in-app path). */
  href?: string;
  /** ms before it goes; default 5000 (errors 8000). 0 = until dismissed. */
  duration?: number;
  /** A toast with the same id replaces the visible one instead of stacking. */
  id?: string;
}

export interface Toast extends ToastInput {
  id: string;
  tone: ToastTone;
  duration: number;
}

const MAX_VISIBLE = 4;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
let seq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function toast(input: ToastInput): string {
  const tone = input.tone ?? 'success';
  const t: Toast = { ...input, tone, id: input.id ?? `t${++seq}`, duration: input.duration ?? (tone === 'error' ? 8000 : 5000) };
  toasts = [...toasts.filter(x => x.id !== t.id), t].slice(-MAX_VISIBLE);
  emit();
  return t.id;
}

export function dismissToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

export function subscribeToasts(fn: (t: Toast[]) => void): () => void {
  listeners.add(fn);
  fn(toasts);
  return () => { listeners.delete(fn); };
}
