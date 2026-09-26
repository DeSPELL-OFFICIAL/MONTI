import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api/functions';
import { useSession } from './session';

/**
 * Did this person ever finish signup? The Firebase claims cannot answer it: `personId` and
 * `account` are minted by `registerPasskey`, one step before the chain registration that makes
 * a person `active`. So a browser that stopped at step 3 is signed in, looks signed in, and is
 * refused by `startKyc` (`NOT_ACTIVE`) and by every claim. `getSignupStatus().status` is the
 * only thing that knows, and this asks it once per signed-in person per page life.
 *
 *  - `unknown`  nothing asked yet, or the question could not be answered. Never blocks anyone:
 *               a dropped connection must not push a finished attendee into signup.
 *  - `pending`  signup stopped before the chain registration — this is the one that redirects.
 *  - `done`     anything else the server reports, including `active`, `kyc_ok` and `rejected`.
 */
export type Registration = 'unknown' | 'checking' | 'pending' | 'done';

let state: Registration = 'unknown';
/** The person the answer belongs to, and the record that the question was already asked. */
let asked: string | null = null;
const listeners = new Set<() => void>();

function set(next: Registration): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getRegistration(): Registration {
  return state;
}

/**
 * Asks the server once. A rejection leaves `unknown` and is deliberately not retried: the guard
 * would otherwise ask again on every render, and the worst outcome here is a person who is told
 * to finish a signup they already finished.
 */
export function ensureRegistrationChecked(personId: string): void {
  if (asked === personId) return;
  asked = personId;
  set('checking');
  void api
    .getSignupStatus()
    .then(({ status }) => {
      if (asked === personId) set(status === 'pending' ? 'pending' : 'done');
    })
    .catch(() => {
      if (asked === personId) set('unknown');
    });
}

/** The registration just landed — say so rather than ask the server the same question again. */
export function markRegistered(): void {
  set('done');
}

/**
 * Stop asking for the rest of this page life. The one caller is the device screen when the
 * browser cannot make a key at all: there is nothing left to finish, and a guard that kept
 * redirecting would lock that person out of every screen they still can use.
 */
export function deferRegistration(): void {
  set('unknown');
}

/** Sign-out and tests. The next signed-in person is a different question. */
export function resetRegistration(): void {
  asked = null;
  set('unknown');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRegistration(): Registration {
  const session = useSession();
  const personId = session.status === 'signedIn' ? session.personId : undefined;
  useEffect(() => {
    if (personId) ensureRegistrationChecked(personId);
  }, [personId]);
  return useSyncExternalStore(subscribe, getRegistration, getRegistration);
}
