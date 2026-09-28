// The relayer's own record of a check-in, watched from `sent` to a settled answer.
//
// After `relayCheckIn` answers `sent`, the gate has shown PASS but the chain has not spoken yet.
// The settled verdict is the `relays/{relayId}` document the relayer writes — `confirmed` when the
// transaction is mined, `failed` when it reverted or was dropped. This is the whole of the state
// source the old bundler receipt plus the on-chain `CheckedIn` watch used to be (design §7): the
// staff phone reads one Firestore document, not the chain, and the relayId is the one the callable
// just handed back.
//
// A read that cannot be made is **not** a verdict. The `onError` path says nothing, so a tap that
// was admitted on `sent` stays admitted rather than being turned red by a Firestore blip — the
// chain's one-time check is the authority, and this document is only the fast way to hear from it.
import { doc, onSnapshot } from 'firebase/firestore';

import { getDb } from '../../shared/api/firebase';

/** The two settled states of a relay document that this watch reports. */
export type RelaySettlement = 'confirmed' | 'failed';

/**
 * Watches `relays/{relayId}` until it settles. The staff member is the relay's `personId` (they
 * submitted it), so the security rules let them read their own document. Returns the unsubscribe;
 * the caller owns it and stops it on the next tap, on `retry`, and on unmount.
 */
export function watchRelay(
  relayId: string,
  onSettled: (status: RelaySettlement, usedAt?: number) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), 'relays', relayId),
    (snapshot) => {
      const data = snapshot.data() as { status?: string; usedAt?: number } | undefined;
      if (data?.status === 'confirmed') onSettled('confirmed', data.usedAt);
      else if (data?.status === 'failed') onSettled('failed');
    },
    () => {
      // Unreadable is not refused: the tap keeps whatever the callable's own answer set.
    },
  );
}
