import { useCallback, useState } from 'react';
import type { Hex } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import { getStaffAccount } from '../../shared/chain/accounts';
import { createdEventId } from '../../shared/chain/createdEvent';
import { OpReverted, resolveSubmittedOp, ticketOp } from '../../shared/chain/ops';
import { revertMatch } from '../../shared/chain/revert';
import { isUnsponsored } from '../../shared/chain/unsponsored';
import { api, callableFailure } from '../../shared/api/functions';
import type { EventDraft } from '../../shared/api/firestore';
import { buildEventMeta, buildTiers, type WizardDraft } from '../wizard/buildEventMeta';
import type { OrganizerCopy } from '../copy';
import { eventProblems, normalizeTags, saleWindow, tierArt, tierProblems } from './draftRules';

/** Every sentence `copy.scene.publishProblems` owns. */
export type PublishProblem = keyof OrganizerCopy['scene']['publishProblems'];

/**
 * What `Ticket.createEvent` can revert with, against the sentence that names the same rule.
 * The scene blocks all three before the operation is sent, so reaching one of these means the
 * draft changed underneath the check — worth saying precisely rather than under one sentence.
 */
const REVERT_PROBLEMS: ReadonlyArray<readonly [string, PublishProblem]> = [
  ['Unauthorized', 'notYourOrg'],
  ['InvalidSchedule', 'schedule'],
  ['InvalidTiers', 'tiersEmpty'],
];

/** The server's reason codes against the sentence each deserves (task-ev-b report §3.2). */
const PIN_PROBLEMS: Readonly<Record<string, PublishProblem>> = {
  BAD_META: 'badMeta',
  BAD_TAGS: 'badTags',
  BAD_IMAGE_CID: 'badPoster',
  NOT_ORGANIZER: 'notYourOrg',
  PINATA_UPLOAD_FAILED: 'pinFailed',
  BAD_PINATA_CID: 'pinFailed',
};

/** Three values the scene does not ask for, because there is one right answer for each. */
const MAX_TRANSFERS = 3;
const APPROVAL_REQUIRED = false;
const SEATED = false;

export type PublishPhase = 'idle' | 'pinning' | 'sending' | 'finishing' | 'confirming';

/** What the done screen needs, carried across rather than read back: the draft is gone by then. */
export interface CreatedEvent {
  /** `''` when the operation landed but its logs carried no `EventCreated` this side could read. */
  eventId: string;
  posterCid: string;
  title: string;
  /** The event exists, but `saveEventArt` or `setEventPrivate` did not land. */
  followUpFailed: boolean;
}

export interface PublishState {
  phase: PublishPhase;
  /** One named rule the organiser can go back and fix, or `''`. */
  problem: PublishProblem | '';
  /** True when nothing agreed to pay for the operation — the organiser banner, not a field. */
  unsponsored: boolean;
  publish: () => Promise<void>;
}

/**
 * The draft as `Ticket.EventMeta` wants it. It goes through the wizard's own `buildEventMeta`
 * rather than a second copy of the hashing: the two must agree byte for byte, because
 * `titleHash`, `descHash` and `venueHash` are written once and can never be repaired.
 *
 * Three values are constants here rather than switches on the scene. `approvalRequired` must
 * be false — `Ticket.claim` reverts `ApprovalRequiredNotSupported` on a true one, so the
 * switch the old wizard offered built events nobody could ever get a ticket for. `seated` has
 * no screen behind it, and `maxTransfers` has no question worth asking yet.
 *
 * Every readable field is trimmed *here*, so the string that is hashed onto the chain is the
 * same one that is pinned to IPFS. `image` is never read by `buildEventMeta`; the poster's CID
 * travels in the pinned document, and the poster itself was uploaded when it was cropped.
 */
function toChainDraft(draft: EventDraft, now: number): WizardDraft {
  const { saleStart, saleEnd } = saleWindow(draft, now);
  return {
    orgId: draft.orgId.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    image: null,
    venue: draft.venue.trim(),
    regionCode: draft.regionCode,
    category: draft.category,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    saleStart,
    saleEnd,
    transferable: draft.transferable,
    transferCutoffHours: draft.transferCutoffHours,
    maxTransfers: MAX_TRANSFERS,
    approvalRequired: APPROVAL_REQUIRED,
    requireKyc: draft.requireKyc,
    tiers: draft.tiers.map((tier) => ({
      name: tier.name.trim(),
      supply: tier.supply,
      maxPerWallet: tier.maxPerWallet,
      seated: SEATED,
    })),
    gates: [],
    submittedOpHash: draft.submittedOpHash,
  };
}

/**
 * The readable half, as `pinEventMetadata` takes it. A hidden venue is left out of the
 * argument entirely — the server would drop it anyway, but the words then never leave the
 * browser at all — while `venueHash` on chain is still the hash of the *real* venue, so the
 * claim an organiser makes at creation stays provable.
 */
function toPinnedMeta(draft: EventDraft) {
  const tags = normalizeTags(draft.tags);
  return {
    name: draft.title.trim(),
    description: draft.description.trim(),
    imageCid: draft.posterCid,
    category: draft.category,
    region: draft.regionCode,
    ...(draft.venueHidden ? {} : { venue: draft.venue.trim() }),
    ...(tags.length > 0 ? { tags } : {}),
    venueHidden: draft.venueHidden,
    timeHidden: draft.timeHidden,
  };
}

export interface PublishOptions {
  draft: EventDraft;
  patch: (next: Partial<EventDraft>) => void;
  /** Throws the draft away once the event exists. Never before. */
  discard: () => Promise<void>;
  onCreated: (created: CreatedEvent) => void;
}

/**
 * `행사 만들기`: the whole of it, in the order plan section E lays out.
 *
 *   1. `pinEventMetadata` — the readable half, with the tags and the two visibility flags.
 *   2. `createEvent` as one sponsored operation, and the new id out of its own log.
 *   3. `saveEventArt` — the ticket pictures, which the chain has no room for.
 *   4. `setEventPrivate` — the real venue, when it is hidden.
 *   5. the draft goes.
 *
 * Steps 3 and 4 come **after** the id is known, because neither can be addressed without it.
 * If either fails the event still exists, so the organiser is carried on to the done screen
 * with one line saying what did not save — not left on a screen that would send a second
 * `createEvent` if they pressed the button again.
 */
export function usePublish({ draft, patch, discard, onCreated }: PublishOptions): PublishState {
  const [phase, setPhase] = useState<PublishPhase>('idle');
  const [problem, setProblem] = useState<PublishProblem | ''>('');
  const [unsponsored, setUnsponsored] = useState(false);

  const finish = useCallback(
    async (eventId: string): Promise<void> => {
      setPhase('finishing');
      let followUpFailed = false;
      if (eventId !== '') {
        try {
          await api.saveEventArt({ eventId, tiers: draft.tiers.map(tierArt) });
          if (draft.venueHidden) {
            // The call does not merge: leaving `venue` out would erase it, so it always goes.
            await api.setEventPrivate({ eventId, venue: draft.venue.trim() });
          }
        } catch {
          followUpFailed = true;
        }
      }
      // The event is on chain; a draft that outlived it is a second event waiting to happen.
      await discard();
      onCreated({ eventId, posterCid: draft.posterCid, title: draft.title.trim(), followUpFailed });
    },
    [discard, draft, onCreated],
  );

  const publish = useCallback(async (): Promise<void> => {
    // One `createEvent` per draft. A previous attempt whose `wait` gave up may still be in
    // flight and the draft outlives the page, so the first question is always what became of
    // that one — never "send it again". A bundler we cannot reach answers `pending`, because
    // the safe reply to "did my event get created?" is never a second event.
    if (draft.submittedOpHash !== '') {
      setProblem('');
      setUnsponsored(false);
      setPhase('confirming');
      const submitted = await resolveSubmittedOp(draft.submittedOpHash as Hex).catch(
        () => ({ state: 'pending', logs: [] }) as const,
      );
      if (submitted.state === 'pending') return;
      if (submitted.state === 'landed') {
        await finish(createdEventId(submitted.logs));
        return;
      }
      // It reverted. The same draft may be sent again, so the hash goes away first.
      patch({ submittedOpHash: '' });
    }

    // The scene says which field; this is the guard that stops a draft that changed underneath.
    if (eventProblems(draft).length > 0 || tierProblems(draft).length > 0) {
      setPhase('idle');
      return;
    }

    setProblem('');
    setUnsponsored(false);
    setPhase('pinning');
    try {
      const orgId = draft.orgId.trim();
      const { metadataCid } = await api.pinEventMetadata({ orgId, meta: toPinnedMeta(draft) });
      setPhase('sending');
      const chainDraft = toChainDraft(draft, Math.floor(Date.now() / 1_000));
      const receipt = await ticketOp({
        account: await getStaffAccount(),
        orgId: BigInt(orgId),
        functionName: 'createEvent',
        args: [buildEventMeta(chainDraft, metadataCid), buildTiers(chainDraft)],
      });
      // `createEvent` returns the new id, but a sponsored operation gives back a receipt — so
      // the id comes out of the operation's own `EventCreated` log.
      await finish(createdEventId(receipt.logs));
    } catch (cause) {
      // The operation is still on its way; it did not fail. Same rule as the hand-over screen.
      if (cause instanceof OpReverted && cause.revertReason === 'TIMEOUT') {
        // Remember which one, so the next press asks after it instead of sending another.
        if (cause.userOpHash) patch({ submittedOpHash: cause.userOpHash });
        setPhase('confirming');
        return;
      }
      setPhase('idle');
      if (cause instanceof OpReverted) {
        const named = cause.revertReason
          ? revertMatch(ticketAbi, cause.revertReason as Hex, REVERT_PROBLEMS)
          : undefined;
        setProblem(named ?? 'failed');
        return;
      }
      if (isUnsponsored(cause)) {
        setUnsponsored(true);
        return;
      }
      const { code, reason } = callableFailure(cause);
      if (PIN_PROBLEMS[reason]) setProblem(PIN_PROBLEMS[reason]);
      else if (code === 'permission-denied') setProblem('notYourOrg');
      else if (code !== '') setProblem('pinFailed');
      else setProblem('failed');
    }
  }, [draft, finish, patch]);

  // Sentences are the scene's business: this hook hands back the *name* of the rule, so the
  // same failure reads the same whichever screen ends up showing it.
  return { phase, problem, unsponsored, publish };
}
