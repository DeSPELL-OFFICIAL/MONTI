import { useState } from 'react';
import type { Hex } from '@monti/shared';
import { ticketAbi } from '../../shared/chain/abis';
import {
  errorSelector as abiErrorSelector,
  revertMatch as abiRevertMatch,
  selectorOf,
} from '../../shared/chain/revert';
import { OpReverted, ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { readTicket } from '../../shared/chain/reads';
import { useCopy } from '../../shared/i18n';
import { useSession } from '../../shared/session';
import { precheckMessage, runPrecheck, type PrecheckFailure } from './precheck';

/** `wait` gave up before the operation landed. Not a failure — it is still on its way. */
const STILL_CONFIRMING = 'TIMEOUT';

/**
 * The eight reverts `Ticket._update` can raise on a handover, each pointing at the pre-check
 * rule that already owns a sentence in both locales. The pre-check reads a moment before the
 * operation runs, so a rule can still flip underneath it — a race, or a stale read — and when
 * it does the chain names the rule in the first four bytes of the revert data. Saying which
 * rule it was beats one sentence for all eight.
 */
const REVERT_RULES: ReadonlyArray<readonly [string, PrecheckFailure]> = [
  ['TicketRevoked', 'revoked'],
  ['TransfersDisabled', 'notTransferable'],
  ['AlreadyCheckedIn', 'alreadyEntered'],
  ['TransferCutoffPassed', 'afterCutoff'],
  ['NotMember', 'notMember'],
  ['KycRequired', 'recipientNotVerified'],
  ['TransferLimitReached', 'noTransfersLeft'],
  ['MaxPerWalletExceeded', 'maxPerWallet'],
];

/** The two lookups in `shared/chain/revert.ts`, bound to `Ticket` — every screen that shares
 *  the table below sends a `Ticket` write. The organiser's gate screen reads `Organizers`
 *  refusals through the same helpers with its own ABI. */
export const errorSelector = (errorName: string): string | undefined =>
  abiErrorSelector(ticketAbi, errorName);

/**
 * The same lookup for a screen with its own table. The invite and the inbox send other
 * `Ticket` writes — `createOffer`, `cancelOffer`, `acceptOffer` — whose refusals are not all
 * among the eight below, so they pair their own error names with their own sentences here and
 * fall back to `revertRule` for the ones a handover already owns.
 */
export const revertMatch = <T,>(
  revertReason: Hex,
  table: ReadonlyArray<readonly [string, T]>,
): T | undefined => abiRevertMatch(ticketAbi, revertReason, table);

/** Built once, from the generated ABI rather than from hand-copied selectors. */
let bySelector: Map<string, PrecheckFailure> | undefined;

export function revertRule(revertReason: Hex): PrecheckFailure | undefined {
  bySelector ??= new Map(
    // A name the generated ABI no longer carries drops out of the map instead of throwing.
    REVERT_RULES.flatMap(([errorName, failure]) => {
      const selector = errorSelector(errorName);
      return selector === undefined ? [] : [[selector, failure] as const];
    }),
  );
  return bySelector.get(selectorOf(revertReason));
}

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
      if (cause instanceof OpReverted) {
        if (cause.revertReason === STILL_CONFIRMING) {
          setPhase('confirming');
          return;
        }
        const rule = cause.revertReason ? revertRule(cause.revertReason) : undefined;
        // A revert nobody here recognises is not something the person can act on.
        setError(rule ? precheckMessage(copy, rule) : copy.transfer.failed);
      } else {
        setError(copy.common.error);
      }
      setPhase('idle');
    }
  }

  return { phase, error, run };
}
