import { onIdTokenChanged } from 'firebase/auth';
import type { Hex } from '@monti/shared';
import { registerSessionHydrator, type SessionHydrator } from '../session';
import { getFirebaseAuth } from './firebase';

/** The shapes loginVerify mints its claims in: a 32-byte person id and a 20-byte address. */
const PERSON_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The signed-in identity is whatever the custom token says it is. `loginVerify` puts exactly
 * `{ personId, account }` into the claims, firestore.rules reads `request.auth.token.account`,
 * and this reads the same claims — so the session, the rules and the server cannot disagree.
 * The account is never recomputed from the local passkey: a counterfactual address derived
 * here would silently diverge from the claim the rules check.
 *
 * `onIdTokenChanged` rather than `onAuthStateChanged` because the claims are the payload:
 * the first token after `signInWithCustomToken`, and every refresh after it, has to land.
 */
export const firebaseSessionHydrator: SessionHydrator = (set) =>
  onIdTokenChanged(getFirebaseAuth(), (user) => {
    if (!user) {
      // Signing out drops personId and account with the rest of the session object.
      set({ status: 'anonymous' });
      return;
    }
    void user
      .getIdTokenResult()
      .then(({ claims }) => {
        const personId = claims['personId'];
        const account = claims['account'];
        // A Firebase session without MONTI claims (a phone sign-in mid-signup) is not signed in.
        if (
          typeof personId !== 'string' || !PERSON_ID_RE.test(personId) ||
          typeof account !== 'string' || !ADDRESS_RE.test(account)
        ) {
          set({ status: 'anonymous' });
          return;
        }
        set({ status: 'signedIn', personId, account: account as Hex });
      })
      .catch(() => set({ status: 'anonymous' }));
  });

export function installSessionHydrator(): void {
  registerSessionHydrator(firebaseSessionHydrator);
}
