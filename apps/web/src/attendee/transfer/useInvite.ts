import { useEffect, useState } from 'react';
import { api, type TransferInviteResult } from '../../shared/api/functions';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { ticketOp } from '../../shared/chain/ops';
import { readTicket } from '../../shared/chain/reads';
import { useCopy } from '../../shared/i18n';
import { inviteFailure, isOpenOffer, isStillConfirming, orgIdOfTicket } from './offers';

/**
 * `loading` while the chain is asked whether an offer is already open, `open` once one is —
 * whether this screen put it there or a reload came back to it — and `confirming` when the
 * send timed out, which is neither a refusal nor a link worth handing to anybody yet.
 */
export type InvitePhase = 'loading' | 'idle' | 'working' | 'open' | 'confirming';

export interface InviteState {
  phase: InvitePhase;
  error: string;
  /** The sentence and the `sms:` link the server made, once the offer is really on chain. */
  invite: TransferInviteResult | null;
  cancelled: boolean;
  send: (phoneE164: string) => Promise<void>;
  cancel: () => Promise<void>;
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * The sender's side of an invite to somebody who has not signed up. `useTransfer` stays the
 * owner of the member → member handover; this is its sibling, because the two share nothing
 * but the revert table: there is no recipient account to pre-check against here, only a
 * number the server turns into a commitment.
 */
export function useInvite(tokenId: string): InviteState {
  const copy = useCopy();
  const [phase, setPhase] = useState<InvitePhase>('loading');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<TransferInviteResult | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // A reload lands back here with the offer already on chain, so the chain — not anything
  // this component remembers — is what says whether one is still open.
  useEffect(() => {
    let live = true;
    void (async () => {
      let open = false;
      try {
        open = isOpenOffer(await readTicket().offerOf(BigInt(tokenId)), now());
      } catch {
        // A read that did not answer is not a refusal: fall through to the send button.
      }
      if (live) setPhase(open ? 'open' : 'idle');
    })();
    return () => {
      live = false;
    };
  }, [tokenId]);

  async function send(phoneE164: string): Promise<void> {
    setPhase('working');
    setError('');
    setCancelled(false);
    try {
      // The server verifies ownership and answers with the commitment the offer is made for,
      // so it has to go first — nothing on this side can derive that commitment.
      const created = await api.createTransferInvite({ tokenId, phoneE164 });
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: await orgIdOfTicket(BigInt(tokenId)),
        functionName: 'createOffer',
        args: [BigInt(tokenId), created.commitment, BigInt(created.expiresAt)],
      });
      // Only now. A text for an offer that never landed is a dead link in somebody's inbox.
      setInvite(created);
      setPhase('open');
    } catch (cause) {
      if (isStillConfirming(cause)) {
        setPhase('confirming');
        return;
      }
      setError(inviteFailure(copy, cause));
      setPhase('idle');
    }
  }

  async function cancel(): Promise<void> {
    const previous = phase;
    setPhase('working');
    setError('');
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: await orgIdOfTicket(BigInt(tokenId)),
        functionName: 'cancelOffer',
        args: [BigInt(tokenId)],
      });
      setInvite(null);
      setCancelled(true);
      setPhase('idle');
    } catch (cause) {
      setError(inviteFailure(copy, cause));
      setPhase(previous);
    }
  }

  return { phase, error, invite, cancelled, send, cancel };
}
