import { useCallback, useState } from 'react';
import type { Hex } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import { getStaffAccount } from '../../shared/chain/accounts';
import { createdEventId } from '../../shared/chain/createdEvent';
import { OpReverted, resolveSubmittedOp, ticketOp } from '../../shared/chain/ops';
import { revertMatch } from '../../shared/chain/revert';
import { isUnsponsored } from '../../shared/chain/unsponsored';
import { callableFailure } from '../../shared/api/functions';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import { buildEventMeta, buildTiers, validateDraft, type DraftProblem, type WizardDraft } from './buildEventMeta';
import { ImageRejected, pinEventImage } from './pinata';

/** Every sentence `copy.wizard.problems` owns. A superset of what the local mirror can find. */
export type WizardProblem = keyof OrganizerCopy['wizard']['problems'];

// The local mirror's answers are a subset, so a rule it finds always has a sentence.
const _draftProblemsAreCovered: Record<DraftProblem, WizardProblem> = {
  orgId: 'orgId', title: 'title', description: 'description', image: 'image', venue: 'venue',
  venueTooLong: 'venueTooLong',
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

export type PublishPhase = 'idle' | 'pinning' | 'sending' | 'confirming' | 'published';

export interface PublishState {
  phase: PublishPhase;
  /** Named rules the organiser can go back and fix, in the order the steps ask for them. */
  problems: WizardProblem[];
  /** One sentence for a failure that names no field. Empty when there is none. */
  error: string;
  /**
   * The id of the event that was just created, read out of its own `EventCreated` log, or `''`
   * when the operation's logs did not carry one (a `wait` that gave up has none at all). The
   * organiser's home screen still takes the number by hand for exactly that case.
   */
  eventId: string;
  publish: () => Promise<void>;
}

/**
 * Publishes the draft: the picture and the readable half are pinned by the backend, then
 * `createEvent` goes out as one sponsored operation. Nothing here talks to a pinning service,
 * and nothing here signs anything the organiser's own passkey did not sign.
 */
export function usePublish(
  draft: WizardDraft,
  onPublished: () => void,
  patch: (next: Partial<WizardDraft>) => void,
): PublishState {
  const copy = useOrganizerCopy();
  const [phase, setPhase] = useState<PublishPhase>('idle');
  const [problems, setProblems] = useState<WizardProblem[]>([]);
  const [error, setError] = useState('');
  const [eventId, setEventId] = useState('');

  const publish = useCallback(async (): Promise<void> => {
    // One `createEvent` per draft. A previous attempt whose `wait` gave up may still be in
    // flight, and the draft outlives the page, so the first question is always what became of
    // that one — never "send it again". A bundler we cannot reach answers `pending`, because
    // the safe reply to "did my event get created?" is never a second event.
    if (draft.submittedOpHash !== '') {
      setProblems([]);
      setError('');
      setPhase('confirming');
      const submitted = await resolveSubmittedOp(draft.submittedOpHash as Hex).catch(
        () => ({ state: 'pending', logs: [] }) as const,
      );
      if (submitted.state === 'pending') return;
      if (submitted.state === 'landed') {
        // It did land after all, so the event exists and its log says which one.
        setEventId(createdEventId(submitted.logs));
        setPhase('published');
        onPublished();
        return;
      }
      // It reverted. The same draft may be sent again, so the hash goes away first.
      patch({ submittedOpHash: '' });
    }

    const found = validateDraft(draft);
    setProblems(found);
    setError('');
    if (found.length > 0 || draft.image === null) return;

    // Validation trims; so does what is sent, so the organisation checked is the one paid for.
    const orgId = draft.orgId.trim();

    setPhase('pinning');
    try {
      const { metadataCid } = await pinEventImage({
        orgId,
        image: draft.image,
        // `EventMeta` carries the title, the description and the venue as hashes only, so the
        // readable words of all three go into the pinned document — along with the theme and
        // the region — or the discover screens have nothing to show. The region is the code
        // (`KR-11`), the same value `buildEventMeta` hashes into `regionCode` and the discover
        // filter hashes back, never its label; and the theme goes as a number because the
        // reader takes `category` only when `typeof === 'number'` (`shared/envio/ipfs.ts`).
        name: draft.title,
        description: draft.description,
        // Trimmed, because the server trims it before pinning it and `buildEventMeta` hashes
        // the trimmed string — the hash on chain and the pinned words have to be the same venue.
        venue: draft.venue.trim(),
        category: draft.category,
        region: draft.regionCode,
      });
      setPhase('sending');
      const receipt = await ticketOp({
        account: await getStaffAccount(),
        orgId: BigInt(orgId),
        functionName: 'createEvent',
        args: [buildEventMeta(draft, metadataCid), buildTiers(draft)],
      });
      // `createEvent` returns the new id, but a sponsored operation gives back a receipt —
      // so the id comes out of the operation's own `EventCreated` log.
      setEventId(createdEventId(receipt.logs));
      setPhase('published');
      onPublished();
    } catch (cause) {
      // The operation is still on its way; it did not fail. Same rule as the hand-over screen.
      if (cause instanceof OpReverted && cause.revertReason === 'TIMEOUT') {
        // Remember which one, so the next Publish asks after it instead of sending another.
        if (cause.userOpHash) patch({ submittedOpHash: cause.userOpHash });
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
          ? revertMatch(ticketAbi, cause.revertReason as Hex, REVERT_PROBLEMS)
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
      else if (reason === 'BAD_IMAGE_MIME') setProblems(['imageType']);
      else if (code !== '') setProblems(['pinFailed']);
      else setError(copy.wizard.failed);
    }
  }, [copy, draft, onPublished, patch]);

  return { phase, problems, error, eventId, publish };
}
