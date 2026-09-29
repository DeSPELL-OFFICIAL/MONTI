import { useCallback, useState } from 'react';
import { encodeFunctionData } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import { api, callableFailure, CallableError } from '../../shared/api/functions';
import { followRelay, sendAction } from '../../shared/relay/sendAction';
import { relayProblem } from '../../shared/relay/relayError';
import type { EventDraft } from '../../shared/api/firestore';
import type { MyOrg } from '../useMyOrgs';
import { buildEventMeta, buildTiers, type ChainDraft } from './buildEventMeta';
import type { OrganizerCopy } from '../copy';
import { saveDraft, type LifecycleProblem } from '../lifecycle';
import { endsAtOf, eventProblems, normalizeTags, saleWindow, tierProblems } from './draftRules';
import { renderAutoPoster } from './autoPoster';
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
  // `pinEventImage`/`pinEventMetadata` refuse the day's 21st pin with `resource-exhausted`
  // (functions/src/functions/organizer.ts). It is not a draft the organiser can fix — the
  // cap lifts tomorrow — so it earns its own sentence rather than the generic failure.
  PIN_QUOTA: 'imageQuota',
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
  // Reachable without the organiser changing anything: the sign-up window is derived as
  // now -> `endsAt`, so a Draft left past its own end date derives one that runs backwards.
  schedule: 'eventPast',
  tiers: 'tiersInvalid',
  failed: 'failed',
};

/**
 * A refusal from the organisation step, carried out of it with the sentence it earned. It is a
 * class rather than a state write so that one `catch` at the end of `publish` owns every
 * failure the path can have, in the order they can happen.
 */
class OrgRefused extends Error {
  constructor(readonly problem: PublishProblem) {
    super('ORG_REFUSED');
  }
}

/** Two values the scene does not ask for, because there is one right answer for each. */
const MAX_TRANSFERS = 3;
const SEATED = false;

export type PublishPhase = 'idle' | 'org' | 'pinning' | 'sending' | 'finishing' | 'confirming';

/** What `createOrganizerForMe` refuses for, against the sentence each deserves. */
const ORG_PROBLEMS: Readonly<Record<string, PublishProblem>> = {
  BAD_NAME: 'orgName',
  ORG_LIMIT: 'orgLimit',
  NOT_ACTIVE: 'orgNotActive',
  NO_SIGNUP: 'orgNotActive',
};

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
  publish: () => Promise<void>;
}

/**
 * The draft as `Ticket.EventMeta` wants it. The hashing lives in `buildEventMeta` and not in
 * this file, so the create path and the update path can never disagree by a byte:
 * `titleHash`, `descHash` and `venueHash` are written once and can never be repaired.
 *
 * Two values are constants here rather than switches on the scene: `seated` has no screen
 * behind it, and `maxTransfers` has no question worth asking yet. `approvalRequired` is no
 * longer among them — the tier card's 받는 방식 control writes it onto the draft, and the
 * option that would set it true is held behind `VITE_APPROVAL_MODES` until the contract that
 * reverts `ApprovalRequiredNotSupported` on a true one is redeployed (plan section A-2).
 *
 * Every readable field is trimmed *here*, so the string that is hashed onto the chain is the
 * same one that is pinned to IPFS. The poster is not among them: its CID travels in the pinned
 * document, and the picture itself was uploaded the moment it was cropped.
 */
function toChainDraft(draft: EventDraft, now: number): ChainDraft {
  const { saleStart, saleEnd } = saleWindow(draft, now);
  return {
    orgId: draft.orgId.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    venue: draft.venue.trim(),
    regionCode: draft.regionCode,
    category: draft.category,
    startsAt: draft.startsAt,
    // The derived end when the organiser never opened `더 설정하기`; theirs when they did.
    endsAt: endsAtOf(draft),
    saleStart,
    saleEnd,
    transferable: draft.transferable,
    transferCutoffHours: draft.transferCutoffHours,
    maxTransfers: MAX_TRANSFERS,
    approvalRequired: draft.approvalRequired,
    requireKyc: draft.requireKyc,
    tiers: draft.tiers.map((tier) => ({
      name: tier.name.trim(),
      supply: tier.supply,
      maxPerWallet: tier.maxPerWallet,
      seated: SEATED,
    })),
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
  /**
   * The organisations the indexer listed for this person, and a way to ask it again. The
   * publish path needs both: the first is usually the whole answer, and the second is the
   * only way to find out what a previous attempt left behind (plan section B-5).
   */
  myOrgs: { orgs: readonly MyOrg[]; refetch: () => Promise<MyOrg[]> };
  /** What to call a new organisation — the one line the scene shows somebody with none. */
  orgName: string;
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
 *   2. `createEvent` as one relayed `MontiForwarder.execute` (via `sendAction`), and the new id
 *      out of the settled relay document's `result.eventId`.
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
  { draft, draftId, myOrgs, orgName, patch, save, discard, onCreated }: PublishOptions,
): PublishState {
  const [phase, setPhase] = useState<PublishPhase>('idle');
  const [problem, setProblem] = useState<PublishProblem | ''>('');

  /**
   * Which organisation this event belongs to, making one if this person has none — four steps,
   * in this order, because `createOrganizerForMe` is **not idempotent** and takes two to five
   * seconds (rarely past ten) to answer (plan section B-5):
   *
   *   1. the draft already names one;
   *   2. the indexer already listed one this person may create events for;
   *   3. a previous attempt got as far as writing the name down — so the indexer is asked
   *      again before anything is sent, because the organisation may well exist by now;
   *   4. otherwise one is made, with the name recorded on the draft **before** the call.
   *
   * Step 3 is what keeps the damage at one stray organisation: a run that dies between the
   * write and the answer leaves a name behind, and the next attempt picks up what it made
   * rather than making a second. The chain's own cap of three is the backstop.
   *
   * The phase is claimed on the **first line**, before anything is awaited, because 만들기 is
   * pressable for exactly as long as it says `idle`. Step 3 awaits the indexer, so a phase
   * claimed any later than this left the button live across that round trip: two fast presses
   * on a re-entered draft both came back empty-handed and both called `createOrganizerForMe`
   * — two organisations out of one draft, against a cap of three.
   */
  const resolveOrg = useCallback(async (): Promise<string> => {
    setPhase('org');
    const known = draft.orgId.trim();
    if (known !== '') return known;

    const listed = myOrgs.orgs.find((org) => org.canCreateEvent);
    if (listed !== undefined) {
      patch({ orgId: listed.orgId });
      await save().catch(() => undefined);
      return listed.orgId;
    }

    if (draft.orgPendingName !== '') {
      const fresh = await myOrgs.refetch().catch(() => [] as MyOrg[]);
      const made = fresh.find((org) => org.canCreateEvent);
      if (made !== undefined) {
        patch({ orgId: made.orgId, orgPendingName: '' });
        await save().catch(() => undefined);
        return made.orgId;
      }
    }

    const name = (draft.orgPendingName || orgName).trim();
    // The scene refuses to send without one; this is the guard for a draft that changed
    // underneath it, and it answers `''` rather than creating an organisation called nothing.
    if (name === '') return '';
    // Written first, and forced out: from here on a run that dies is a run the step above
    // can pick up. `save()` swallows its own failures, so the callable still goes either way
    // — a name that did not persist is a smaller loss than an event that never got made.
    patch({ orgPendingName: name });
    await save().catch(() => undefined);
    const { orgId } = await api.createOrganizerForMe({ name });
    patch({ orgId, orgPendingName: '' });
    await save().catch(() => undefined);
    return orgId;
  }, [draft.orgId, draft.orgPendingName, myOrgs, orgName, patch, save]);

  const finish = useCallback(
    async (eventId: string, posterCid: string = draft.posterCid): Promise<void> => {
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
        posterCid,
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
      setPhase('pinning');
      try {
        const orgId = draft.orgId.trim();
        // A fresh document every time: the chain's `imageCid` is the CID of *this* JSON, and
        // the hashes beside it are of the strings in it, so the two are written together.
        const { metadataCid } = await api.pinEventMetadata({ orgId, meta: toPinnedMeta(draft) });
        setPhase('sending');
        const chainDraft = toChainDraft(draft, Math.floor(Date.now() / 1_000));
        // A relayed `updateEventMeta` (via `sendAction` inside `saveDraft`) that follows the relay
        // document to a settled answer, so a success is always `done` — no timed-out receipt to
        // resend around, and sending the same update twice only writes the same `EventMeta` twice.
        const result = await saveDraft(
          BigInt(eventId),
          BigInt(orgId),
          buildEventMeta(chainDraft, metadataCid),
          buildTiers(chainDraft),
        );
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
        else if (code === 'resource-exhausted') setProblem('imageQuota');
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
      await finish(draft.createdEventId);
      return;
    }

    // A `createEvent` this draft already broadcast but has not seen settle: the relayer answered
    // `sent`, the relay id was written to the draft, and then the page closed (or the wait dropped).
    // The first question is always what became of that submission — never "send it again", because
    // a second `createEvent` is a second event. Following the relay document is the whole of it.
    if (draft.submittedRelayId !== '') {
      setProblem('');
      setPhase('confirming');
      try {
        const result = await followRelay(draft.submittedRelayId);
        const eventId = result?.eventId ?? '';
        patch({ createdEventId: eventId, submittedRelayId: '' });
        await save().catch(() => undefined);
        if (eventId === '') {
          setPhase('idle');
          setProblem('failed');
          return;
        }
        await finish(eventId);
      } catch (cause) {
        // The relayer settled it as `failed` — `followRelay` rejects with a `CallableError`
        // carrying the forwarder code or the bubbled `Ticket` error name. The submission is spent,
        // so drop the record and surface the rule, letting a fresh 만들기 send again.
        if (cause instanceof CallableError) {
          setPhase('idle');
          setProblem(relayProblem(cause, REVERT_PROBLEMS) ?? 'failed');
          patch({ submittedRelayId: '' });
          await save().catch(() => undefined);
          return;
        }
        // A dropped Firestore listener: the relay may still land, so the record and the confirming
        // wait both stay. Re-pressing follows the same document again — it never re-sends.
        setPhase('confirming');
      }
      return;
    }

    // The scene says which field; this is the guard that stops a draft that changed underneath.
    if (eventProblems(draft).length > 0 || tierProblems(draft).length > 0) {
      setPhase('idle');
      return;
    }

    setProblem('');
    try {
      // Before the pin, because `pinEventMetadata` checks on chain that this person organises
      // for the organisation it is given (`functions/src/lib/auth.ts`) — and the callable
      // waits for finality, so there is no indexer lag to retry around.
      const orgId = await resolveOrg().catch((cause) => {
        const { reason } = callableFailure(cause);
        throw new OrgRefused(ORG_PROBLEMS[reason] ?? 'orgFailed');
      });
      if (orgId === '') {
        setPhase('idle');
        setProblem('orgName');
        return;
      }
      setPhase('pinning');
      // The poster is optional (plan B-2): an event created without one gets a default A4 poster
      // synthesised from its title and theme backdrop, pinned through the same `pinEventImage`
      // path an uploaded one takes — so `imageCid` is never empty. The CID is recorded on the
      // draft too, so any re-entry after this line reuses it rather than making a second poster.
      let posterCid = draft.posterCid.trim();
      if (posterCid === '') {
        const bytesBase64 = await renderAutoPoster(draft);
        const pinned = await api.pinEventImage({ bytesBase64, kind: 'poster' });
        posterCid = pinned.cid;
        patch({ posterCid });
        await save().catch(() => undefined);
      }
      const { metadataCid } = await api.pinEventMetadata({ orgId, meta: toPinnedMeta({ ...draft, posterCid }) });
      setPhase('sending');
      const chainDraft = toChainDraft({ ...draft, orgId }, Math.floor(Date.now() / 1_000));
      // `createEvent` as one relayed `MontiForwarder.execute`. `sendAction` follows the relay
      // document to a settled answer and hands back `result.eventId`. `onSent` fires the moment the
      // relayer broadcasts (`sent`) but has not yet mined: the relay id is written to the draft
      // **before** the wait, so a page that closes here reopens onto `followRelay` rather than a
      // second `createEvent`, and the confirming wait is shown meanwhile.
      const result = await sendAction(
        'createEvent',
        'ticket',
        encodeFunctionData({
          abi: ticketAbi,
          functionName: 'createEvent',
          args: [buildEventMeta(chainDraft, metadataCid), buildTiers(chainDraft)],
        }),
        (relayId) => {
          patch({ submittedRelayId: relayId });
          void save().catch(() => undefined);
          setPhase('confirming');
        },
      );
      const eventId = result?.eventId ?? '';
      // The id is recorded before anything that could still fail, and the in-flight relay id is
      // cleared with it: from here every route back into `publish()` goes to the follow-ups
      // (`createdEventId`) and never to a second `createEvent`.
      patch({ createdEventId: eventId, submittedRelayId: '' });
      await save().catch(() => undefined);
      if (eventId === '') {
        // A confirmed relay that named no event id is a backend fault (C2 fills `result.eventId`),
        // not a draft the organiser can fix — so it reads as the generic failure, and the retry
        // sends fresh because the record was cleared above.
        setPhase('idle');
        setProblem('failed');
        return;
      }
      await finish(eventId, posterCid);
    } catch (cause) {
      if (cause instanceof OrgRefused) {
        setPhase('idle');
        setProblem(cause.problem);
        return;
      }
      setPhase('idle');
      // A relayed `createEvent` refusal — the forwarder code or the bubbled `Ticket` error name,
      // read off `details.code` and matched against the same rules the sponsored path decoded from
      // a four-byte selector.
      const named = relayProblem(cause, REVERT_PROBLEMS);
      if (named !== undefined) {
        setProblem(named);
        return;
      }
      const { code, reason } = callableFailure(cause);
      if (PIN_PROBLEMS[reason]) setProblem(PIN_PROBLEMS[reason]);
      // The daily pin quota. `ORG_LIMIT` is `resource-exhausted` too, but it is raised inside
      // `resolveOrg` and thrown as `OrgRefused` above — so anything reaching here with this code
      // came from `pinEventImage` or `pinEventMetadata`, which is the image quota.
      else if (code === 'resource-exhausted') setProblem('imageQuota');
      else if (code === 'permission-denied') setProblem('notYourOrg');
      else if (code !== '') setProblem('pinFailed');
      else setProblem('failed');
    }
  }, [draft, finish, patch, resolveOrg, save, update]);

  // Sentences are the scene's business: this hook hands back the *name* of the rule, so the
  // same failure reads the same whichever screen ends up showing it.
  return { phase, problem, publish };
}
