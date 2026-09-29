import { useState } from 'react';
import { encodeFunctionData } from 'viem';
import type { Hex } from '@monti/shared';
import { ticketAbi } from '../../shared/chain/abis';
import { sendAction } from '../../shared/relay/sendAction';
import { readTicket } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';
import { useCopy } from '../../shared/i18n';
import { useSession } from '../../shared/session';
import { precheckMessage, runPrecheck, type PrecheckFailure } from './precheck';

/**
 * The forwarder/contract error code a relayed action carries on a **determinate** refusal, read
 * structurally off `details.code` — the frozen `{ code, message }` shape a `relays/{id}` doc's
 * `error` carries and the same one `relayClaimError` reads. Empty for an **indeterminate** failure
 * (a dropped relay listener, a lost callable response): the write may yet be on chain, so a screen
 * treats an empty code as "still confirming" rather than as a refusal to resend blindly over.
 */
export function relayActionCode(cause: unknown): string {
  const details = (cause as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code } = details as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return '';
}

/** A screen's own error table, matched by the contract error **name** the relay reported. */
export function matchByName<T>(
  code: string,
  table: ReadonlyArray<readonly [string, T]>,
): T | undefined {
  return table.find(([name]) => name === code)?.[1];
}

/**
 * The eight reverts `Ticket._update` can raise on a handover, each pointing at the pre-check
 * rule that already owns a sentence in both locales. The pre-check reads a moment before the
 * operation runs, so a rule can still flip underneath it — a race, or a stale read — and when
 * it does the relayer names the rule in the doc's `error.code`. Saying which rule it was beats
 * one sentence for all eight.
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

/** The pre-check failure a handover revert **name** maps to, or nothing for a name off the eight. */
export function revertRuleByName(code: string): PrecheckFailure | undefined {
  return REVERT_RULES.find(([name]) => name === code)?.[1];
}

/**
 * The one 01b revert a handover can raise that no pre-check rule covers. `_update`'s rotation
 * quarantine reads the **recipient's** person (abi-delta-01b.md §6), and `runPrecheck` cannot
 * ask the same question — it would need `Identity.personOf`, which this app does not read — so
 * it is answered here, on the way back, rather than bolted onto `PrecheckFailure` as a rule
 * nothing ever pre-checks.
 *
 * `DeviceLocked` deliberately stays out of this table even though 01b made it bidirectional:
 * `_update` raises it for the sender and the recipient alike, and `transfer.alertLocked` names
 * the recipient's phone. Half the time that would name the wrong phone, which is worse than
 * the generic sentence. The recipient's lock is already caught before the send, by the
 * pre-check's `locked` rule.
 */
const SEND_REVERTS: ReadonlyArray<readonly [string, (copy: Copy) => string]> = [
  ['RotationPending', (copy) => copy.transfer.alertRecipientMoved],
];

/**
 * Member → member handover: one relayed `safeTransferFrom`. Every rule it could break was already
 * checked by `runPrecheck`; the contract checks again, and the relayer names any it catches.
 */
export async function sendTransfer(from: Hex, to: Hex, tokenId: bigint): Promise<void> {
  await sendAction(
    'safeTransferFrom',
    'ticket',
    encodeFunctionData({ abi: ticketAbi, functionName: 'safeTransferFrom', args: [from, to, tokenId] }),
  );
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
      const [tiers, tierIndex] = await Promise.all([ticket.tiers(eventId), ticket.tierOf(id)]);
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
      await sendTransfer(from, to, id);
      setPhase('sent');
    } catch (cause) {
      const code = relayActionCode(cause);
      // No determinate code: the handover may still be on its way (a dropped relay listener). Say
      // so rather than invite a second one that would move the same ticket twice.
      if (code === '') {
        setPhase('confirming');
        return;
      }
      // This screen's own table first, then the eight rules the pre-check already owns.
      const own = matchByName(code, SEND_REVERTS);
      const rule = revertRuleByName(code);
      // A revert nobody here recognises is not something the person can act on.
      setError(own ? own(copy) : rule ? precheckMessage(copy, rule) : copy.transfer.failed);
      setPhase('idle');
    }
  }

  return { phase, error, run };
}
