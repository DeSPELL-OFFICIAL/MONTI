import { onAuthStateChanged } from 'firebase/auth';
import { registerSessionHydrator, type SessionHydrator } from '../session';
import { storedCredential } from '../passkey';
import { getAttendeeAccount } from '../chain/accounts';
import { getFirebaseAuth } from './firebase';

/**
 * Resolves the session exactly once per auth change. A signed-in Firebase user with a
 * passkey on this device becomes 'signedIn'; anything else is 'anonymous'. This file is the
 * only one that knows both halves, which is what keeps session.ts Firebase-free.
 */
export const firebaseSessionHydrator: SessionHydrator = (set) =>
  onAuthStateChanged(getFirebaseAuth(), (user) => {
    if (!user || !storedCredential()) {
      set({ status: 'anonymous' });
      return;
    }
    void getAttendeeAccount()
      .then((account) => set({ status: 'signedIn', account: account.address }))
      .catch(() => set({ status: 'anonymous' }));
  });

export function installSessionHydrator(): void {
  registerSessionHydrator(firebaseSessionHydrator);
}
