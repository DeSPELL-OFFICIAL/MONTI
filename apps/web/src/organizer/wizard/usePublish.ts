import { useCallback, useState } from 'react';
import { encodeErrorResult, type Hex } from 'viem';
import { montiPaymasterAbi } from '@monti/shared';
import { getStaffAccount } from '../../shared/chain/accounts';
import { OpReverted, ticketOp } from '../../shared/chain/ops';
import { callableFailure } from '../../shared/api/functions';
// Exported by the hand-over screen for exactly this: a screen with its own table of revert
// names pairs them with its own sentences, rather than copying selector arithmetic around.
import { revertMatch } from '../../attendee/transfer/useTransfer';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import { buildEventMeta, buildTiers, validateDraft, type DraftProblem, type WizardDraft } from './buildEventMeta';
import { ImageRejected, pinEventImage } from './pinata';

/** Every sentence `copy.wizard.problems` owns. A superset of what the local mirror can find. */
export type WizardProblem = keyof OrganizerCopy['wizard']['problems'];

// The local mirror's answers are a subset, so a rule it finds always has a sentence.
const _draftProblemsAreCovered: Record<DraftProblem, WizardProblem> = {
  orgId: 'orgId', title: 'title', description: 'description', image: 'image', venue: 'venue',
  region: 'region', category: 'category', schedule: 'schedule', sale: 'sale', cutoff: 'cutoff',
  maxTransfers: 'maxTransfers', tiersEmpty: 'tiersEmpty', tiersTooMany: 'tiersTooMany',
  tierName: 'tierName', tierSupply: 'tierSupply', tierMaxPerWallet: 'tierMaxPerWallet',
};
void _draftProblemsAreCovered;

/**
 * What `Ticket.createEvent` can revert with, against the sentence that names the same rule.
 * `validateDraft` blocks all three before the operation is sent, so reaching one of these means
 * the draft changed underneath the check — or that the mirror and the contract disagree, which
 * is worth saying precisely rather than under one sentence for everything.
 */
const REVERT_PROBLEMS: ReadonlyArray<readonly [string, WizardProblem]> = [
  ['Unauthorized', 'notYourOrg'],
  ['InvalidSchedule', 'schedule'],
  ['InvalidTiers', 'tiersEmpty'],
];

/**
 * How the paymaster refuses to pay. Until sub-plan 01b's `setAllowed`, no organiser selector is
 * on its allowlist, so `createEvent` is rejected while the operation is still being simulated —
 * the bundler answers the send with the paymaster's revert, which never becomes an `OpReverted`
 * because nothing ever landed. Both the error name and its four bytes are looked for: a bundler
 * may hand back either, wrapped in a message of its own.
 */
const PAYMASTER_REFUSALS: readonly string[] = ['SelectorNotAllowed', 'TargetNotAllowed', 'AA33'];

function paymasterSelectors(): string[] {
  return ['SelectorNotAllowed', 'TargetNotAllowed'].flatMap((errorName) => {
    try {
      return [encodeErrorResult({ abi: montiPaymasterAbi, errorName }).toLowerCase()];
    } catch {
      return [];
    }
  });
}

/** Flattens a bundler rejection: viem nests the reason under `details`, `shortMessage`, `cause`. */
function describeError(cause: unknown, depth = 0): string {
  if (depth > 4 || typeof cause !== 'object' || cause === null) return String(cause ?? '');
  const error = cause as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
  return [error.message, error.details, error.shortMessage, describeError(error.cause, depth + 1)]
    .map((part) => (typeof part === 'string' ? part : ''))
    .join(' ');
}

/** True when nothing agreed to pay for this operation, so it was never even sent. */
export function isUnsponsored(cause: unknown): boolean {
  if (cause instanceof OpReverted) return false;
  const text = describeError(cause).toLowerCase();
  if (text === '') return false;
  return (
    PAYMASTER_REFUSALS.some((name) => text.includes(name.toLowerCase())) ||
    paymasterSelectors().some((selector) => text.includes(selector))
  );
}

export type PublishPhase = 'idle' | 'pinning' | 'sending' | 'confirming' | 'published';

export interface PublishState {
  phase: PublishPhase;
  /** Named rules the organiser can go back and fix, in the order the steps ask for them. */
  problems: WizardProblem[];
  /** One sentence for a failure that names no field. Empty when there is none. */
  error: string;
  publish: () => Promise<void>;
}

/**
 * Publishes the draft: the picture and the readable half are pinned by the backend, then
 * `createEvent` goes out as one sponsored operation. Nothing here talks to a pinning service,
 * and nothing here signs anything the organiser's own passkey did not sign.
 */
export function usePublish(draft: WizardDraft, onPublished: () => void): PublishState {
  const copy = useOrganizerCopy();
  const [phase, setPhase] = useState<PublishPhase>('idle');
  const [problems, setProblems] = useState<WizardProblem[]>([]);
  const [error, setError] = useState('');

  const publish = useCallback(async (): Promise<void> => {
    const found = validateDraft(draft);
    setProblems(found);
    setError('');
    if (found.length > 0 || draft.image === null) return;

    setPhase('pinning');
    try {
      const { metadataCid } = await pinEventImage({
        orgId: draft.orgId,
        image: draft.image,
        name: draft.title,
        description: draft.description,
      });
      setPhase('sending');
      await ticketOp({
        account: await getStaffAccount(),
        orgId: BigInt(draft.orgId),
        functionName: 'createEvent',
        args: [buildEventMeta(draft, metadataCid), buildTiers(draft)],
      });
      setPhase('published');
      onPublished();
    } catch (cause) {
      // The operation is still on its way; it did not fail. Same rule as the hand-over screen.
      if (cause instanceof OpReverted && cause.revertReason === 'TIMEOUT') {
        setPhase('confirming');
        return;
      }
      setPhase('idle');
      if (cause instanceof ImageRejected) {
        setProblems([cause.problem]);
        return;
      }
      if (cause instanceof OpReverted) {
        const problem = cause.revertReason
          ? revertMatch(cause.revertReason as Hex, REVERT_PROBLEMS)
          : undefined;
        if (problem) setProblems([problem]);
        else setError(copy.wizard.failed);
        return;
      }
      if (isUnsponsored(cause)) {
        setError(copy.wizard.unsponsored);
        return;
      }
      const { code, reason } = callableFailure(cause);
      if (code === 'permission-denied') setProblems(['notYourOrg']);
      else if (reason === 'IMAGE_TOO_LARGE') setProblems(['imageTooLarge']);
      else if (reason === 'BAD_MIME') setProblems(['imageType']);
      else if (code !== '') setProblems(['pinFailed']);
      else setError(copy.wizard.failed);
    }
  }, [copy, draft, onPublished]);

  return { phase, problems, error, publish };
}
