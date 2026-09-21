import { useSyncExternalStore } from 'react';
import type { Hex } from '@monti/shared';

export interface Session {
  status: 'loading' | 'anonymous' | 'signedIn';
  account?: Hex;
  personId?: string;
}

let current: Session = { status: 'loading' };
const listeners = new Set<() => void>();

/**
 * Supplied by shared/api/sessionHydrator.ts (Task 16) so this module stays Firebase-free.
 * Receives `set` and returns an unsubscribe.
 */
export type SessionHydrator = (set: (session: Session) => void) => () => void;
let hydrator: SessionHydrator | null = null;

export function registerSessionHydrator(next: SessionHydrator | null): void {
  hydrator = next;
}

/** Called once from <App/>. Guarantees status leaves 'loading'. */
export function bootSession(): () => void {
  if (!hydrator) {
    setSession({ status: 'anonymous' });
    return () => undefined;
  }
  const unsubscribe = hydrator(setSession);
  // A hydrator that has not answered yet must not leave the guard spinning forever.
  setTimeout(() => {
    if (current.status === 'loading') setSession({ status: 'anonymous' });
  }, 3_000);
  return unsubscribe;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSession(next: Session): void {
  current = next;
  emit();
}

export function clearSession(): void {
  setSession({ status: 'anonymous' });
}

export function getSession(): Session {
  return current;
}

export function useSession(): Session {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSession,
    getSession,
  );
}
