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
import { saveDraft, type LifecycleProblem } from '../lifecycle';
import { eventProblems, normalizeTags, saleWindow, tierProblems } from './draftRules';
import {
  followUpPlan, followUpsDone, runFollowUps, type FollowUpPlan, type FollowUpResult,
} from './followUps';

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

/**
 * What `updateEventMeta` can be refused for, in the words `organizer/lifecycle.ts` already
 * gives those reverts. `NotDraft` is the one that matters: the chain closes editing the moment
 * an event is published (`Ticket.sol:235`), so an organiser who published in another tab is
 * told exactly that rather than "that did not work".
 */
const UPDATE_PROBLEMS: Readonly<Record<LifecycleProblem, PublishProblem>> = {
  notDraft: 'notDraft',
  closed: 'notDraft',
  notAllowed: 'notYourOrg',
  failed: 'failed',
};

/** Three values the scene does not ask for, because there is one right answer for each. */
const MAX_TRANSFERS = 3;
const APPROVAL_REQUIRED = false;
const SEATED = false;

export type PublishPhase = 'idle' | 'pinning' | 'sending' | 'finishing' | 'confirming';

/**
 * What the done screen needs, carried across rather than read back: by then the indexer has
 * not seen the event and — when everything landed — the draft is gone.
 *
 * `plan`, `done` and `draftId` are what make the retry on that screen real: the plan is
 * everything the two writes need, `done` says which of them already landed, and `draftId`
 * names the draft that is still being held open until they both do.
 */
export interface CreatedEvent {
  eventId: string;
  posterCid: string;
  title: string;
  /** The event exists, but `saveEventArt` or `setEventPrivate` did not land. */
  followUpFailed: boolean;
  draftId: string;
  plan: FollowUpPlan;
  done: FollowUpResult;
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
  draftId: string;
  patch: (next: Partial<EventDraft>) => void;
  /** Forces the pending write out now, so a fact recorded here is durable before anything else runs. */
  save: () => Promise<void>;
  /** Throws the draft away. Only ever once the event exists **and** both follow-ups landed. */
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
export function usePublish(
  { draft, draftId, patch, save, discard, onCreated }: PublishOptions,
): PublishState {
  const [phase, setPhase] = useState<PublishPhase>('idle');
  const [problem, setProblem] = useState<PublishProblem | ''>('');
  const [unsponsored, setUnsponsored] = useState(false);

  const finish = useCallback(
    async (eventId: string): Promise<void> => {
      // The receipt landed but no `EventCreated` came out of its logs. The event exists and
      // nothing here can address it, so the draft — the only place its venue and its pictures
      // still are — stays, and the screen goes to `confirming`, not `idle`: from that state
      // the button asks `resolveSubmittedOp` what the operation produced, and there is no
      // path from it that sends a second `createEvent`.
      if (eventId === '') {
        setPhase('confirming');
        setProblem('noEventId');
        return;
      }
      setPhase('finishing');
      const plan = followUpPlan(draft, eventId);
      const done = await runFollowUps(plan);
      const complete = followUpsDone(plan, done);
      // The one condition the draft may be deleted on. A venue that was never written is a
      // venue nowhere else: the public document has no `venue` key, and `updateEventMeta`
      // refuses anything past Draft, so losing the draft loses it for good.
      if (complete) await discard();
      onCreated({
        eventId,
        posterCid: draft.posterCid,
        title: draft.title.trim(),
        followUpFailed: !complete,
        draftId,
        plan,
        done,
      });
    },
    [discard, draft, draftId, onCreated],
  );

  /**
   * The same two writes as {@link finish}, for an event that already existed. The difference
   * is what happens when one of them does not land: there is no done screen to carry a retry
   * to, and pressing 저장 again is safe for every step of an update — the pin, the chain write
   * and both callables all replace rather than add — so the draft is kept and the button is
   * the retry.
   */
  const finishUpdate = useCallback(
    async (eventId: string): Promise<void> => {
      setPhase('finishing');
      const plan = followUpPlan(draft, eventId);
      const done = await runFollowUps(plan);
      if (!followUpsDone(plan, done)) {
        setPhase('idle');
        setProblem('followUpFailed');
        return;
      }
      await discard();
      onCreated({
        eventId,
        posterCid: draft.posterCid,
        title: draft.title.trim(),
        followUpFailed: false,
        draftId,
        plan,
        done,
      });
    },
    [discard, draft, draftId, onCreated],
  );

  /**
   * `저장` on an event that already exists — the same scene, the same rules, and
   * `updateEventMeta` in place of `createEvent` (T-EV-W12). The chain refuses it once the
   * event is published, which is why the entry point is only offered while it is a Draft.
   *
   * Nothing here needs the duplicate-send guards the create path is built around: sending the
   * same update twice writes the same `EventMeta` twice, where sending `createEvent` twice
   * makes two events.
   */
  const update = useCallback(
    async (eventId: string): Promise<void> => {
      if (eventProblems(draft).length > 0 || tierProblems(draft).length > 0) {
        setPhase('idle');
        return;
      }
      setProblem('');
      setUnsponsored(false);
      setPhase('pinning');
      try {
        const orgId = draft.orgId.trim();
        // A fresh document every time: the chain's `imageCid` is the CID of *this* JSON, and
        // the hashes beside it are of the strings in it, so the two are written together.
        const { metadataCid } = await api.pinEventMetadata({ orgId, meta: toPinnedMeta(draft) });
        setPhase('sending');
        const chainDraft = toChainDraft(draft, Math.floor(Date.now() / 1_000));
        const result = await saveDraft(
          BigInt(eventId),
          BigInt(orgId),
          buildEventMeta(chainDraft, metadataCid),
          buildTiers(chainDraft),
        );
        if (result.state === 'unsponsored') {
          setPhase('idle');
          setUnsponsored(true);
          return;
        }
        // Still on its way. The button stays pressable, and pressing it sends the same update
        // again — which is the whole difference from a `createEvent` that timed out.
        if (result.state === 'confirming') {
          setPhase('confirming');
          return;
        }
        if (result.state === 'refused') {
          setPhase('idle');
          setProblem(UPDATE_PROBLEMS[result.problem]);
          return;
        }
        await finishUpdate(eventId);
      } catch (cause) {
        setPhase('idle');
        const { code, reason } = callableFailure(cause);
        if (PIN_PROBLEMS[reason]) setProblem(PIN_PROBLEMS[reason]);
        else if (code === 'permission-denied') setProblem('notYourOrg');
        else if (code !== '') setProblem('pinFailed');
        else setProblem('failed');
      }
    },
    [draft, finishUpdate],
  );

  const publish = useCallback(async (): Promise<void> => {
    // A draft opened from an event that already exists goes the other way entirely: no id to
    // read out of a log, no duplicate to guard against, and `updateEventMeta` at the end.
    if (draft.editingEventId !== '') {
      await update(draft.editingEventId);
      return;
    }

    // The event this draft already made. Recorded before anything that can fail, so from here
    // on there is no path that sends a second `createEvent` — pressing the button again only
    // tries the two writes that are still missing.
    if (draft.createdEventId !== '') {
      setProblem('');
      setUnsponsored(false);
      await finish(draft.createdEventId);
      return;
    }

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
        // It did land after all. Same rule as below: the id is recorded before anything else.
        // An empty one leaves `submittedOpHash` in place, so the next press asks again rather
        // than falling through to a fresh `createEvent`.
        const landed = createdEventId(submitted.logs);
        if (landed !== '') {
          patch({ createdEventId: landed });
          await save().catch(() => undefined);
        }
        await finish(landed);
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
      const eventId = createdEventId(receipt.logs);
      // **The first thing written, before anything that could still fail.** One of the two is
      // always recorded here, so from this line on every route back into `publish()` goes
      // either to the follow-ups (`createdEventId`) or to `resolveSubmittedOp`
      // (`submittedOpHash`) — and never to a second `createEvent`.
      //
      // The empty-id case is the one this exists for: the operation landed, the event is on
      // chain, and the only way to find out which one is to ask the bundler again by hash.
      patch(eventId === ''
        ? { submittedOpHash: receipt.userOpHash }
        : { createdEventId: eventId });
      await save().catch(() => undefined);
      await finish(eventId);
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
  }, [draft, finish, patch, save, update]);

  // Sentences are the scene's business: this hook hands back the *name* of the rule, so the
  // same failure reads the same whichever screen ends up showing it.
  return { phase, problem, unsponsored, publish };
}
