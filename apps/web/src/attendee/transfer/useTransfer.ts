import { useState } from 'react';
import type { Hex } from '@monti/shared';
import { OpReverted, ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { readTicket } from '../../shared/chain/reads';
import { useCopy } from '../../shared/i18n';
import { useSession } from '../../shared/session';
import { precheckMessage, runPrecheck } from './precheck';

/** `wait` gave up before the operation landed. Not a failure — it is still on its way. */
const STILL_CONFIRMING = 'TIMEOUT';

/**
 * Member → member handover: one `safeTransferFrom` sponsored by the event's organisation.
 * Every rule it could break was already checked by `runPrecheck`; the contract checks again.
 */
export async function sendTransfer(from: Hex, to: Hex, tokenId: bigint, orgId: bigint): Promise<void> {
  await ticketOp({
    account: await getAttendeeAccount(),
    orgId,
    functionName: 'safeTransferFrom',
    args: [from, to, tokenId],
  });
}

export type TransferPhase = 'idle' | 'working' | 'confirming' | 'sent';

export interface TransferState {
  phase: TransferPhase;
  error: string;
  run: (to: Hex) => Promise<void>;
}

/** Reads what the pre-check needs, blocks on the first failing rule, then sends. */
export function useTransfer(tokenId: string): TransferState {
  const copy = useCopy();
  const session = useSession();
  const [phase, setPhase] = useState<TransferPhase>('idle');
  const [error, setError] = useState('');

  async function run(to: Hex): Promise<void> {
    const from = session.account;
    if (!from) return;
    setPhase('working');
    setError('');
    try {
      const ticket = readTicket();
      const id = BigInt(tokenId);
      const eventId = await ticket.eventOf(id);
      const [meta, tiers, tierIndex] = await Promise.all([
        ticket.eventMeta(eventId),
        ticket.tiers(eventId),
        ticket.tierOf(id),
      ]);
      const failure = await runPrecheck({
        tokenId: id,
        eventId,
        from,
        to,
        now: Math.floor(Date.now() / 1000),
        // A tier the chain cannot find reads back as 0, and 0 is what the contract blocks on.
        maxPerWallet: Number(tiers[tierIndex]?.maxPerWallet ?? 0),
      });
      if (failure) {
        setError(precheckMessage(copy, failure));
        setPhase('idle');
        return;
      }
      await sendTransfer(from, to, id, meta.orgId);
      setPhase('sent');
    } catch (cause) {
      if (cause instanceof OpReverted && cause.revertReason === STILL_CONFIRMING) {
        setPhase('confirming');
        return;
      }
      // A revert here is a rule the pre-check could not see (a race, or a stale read).
      setError(cause instanceof OpReverted ? copy.transfer.failed : copy.common.error);
      setPhase('idle');
    }
  }

  return { phase, error, run };
}
