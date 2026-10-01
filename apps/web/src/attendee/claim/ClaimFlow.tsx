import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { encodeFunctionData, type Hex } from 'viem';
import { Alert, Button, Field, KycBadge, OpProgress, Screen, Sheet, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { useMyRequest } from '../../shared/envio/claimRequests';
import { useClaimEventData } from './useClaimEventData';
import { ticketAbi } from '../../shared/chain/abis';
import { sendAction } from '../../shared/relay/sendAction';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { api } from '../../shared/api/functions';
import { getSettlement, watchRelay, type SettlementView } from '../../shared/api/firestore';
import { settlementEnabled } from '../../shared/config';
import { formatUsdCents } from '../../shared/money';
import { PurchaseSheet } from '../purchase/PurchaseSheet';
import { useKycLevel } from '../me/useKycLevel';
import { useMyTickets } from '../tickets/useTickets';
import { buildClaimAuth } from './buildClaimAuth';
import { relayClaimCopy, relayClaimError } from './claimErrors';

/** Level 1 is id + face confirmed; the events that ask for it ask for exactly that. */
const VERIFIED_LEVEL = 1;
/** The indexer's own spelling of a called-off event. */
const CANCELLED = 'Cancelled';
/**
 * What the verification screen sends back in the address: this person was in the middle of
 * getting a ticket, so finish it for them instead of making them find the button again. The
 * return always lands on the `/claim/:id` route — the one entry that survives a round trip
 * through the identity check (plan B1) — whichever entry the claim began from.
 */
const CLAIM_INTENT = 'claim';

/**
 * Shown instead of claiming when the event requires identity verification.
 *
 * The return address is the claim route and not the event page: the event page has no claim in
 * it, so coming back there costs two more taps, and the chosen type would be gone by the time the
 * second one landed. It rides along in the address instead.
 */
export function KycRequiredSheet({
  eventId,
  tier,
  level,
  onClose,
}: {
  eventId: string;
  tier: number;
  level: number;
  onClose: () => void;
}) {
  const copy = useCopy();
  const navigate = useNavigate();
  const resume = `/claim/${eventId}?intent=${CLAIM_INTENT}&tier=${tier}`;
  return (
    <div role="dialog" aria-modal="true">
      <h2>{copy.kyc.requiredTitle}</h2>
      {/* The sheet only exists on an event that asks for the check, and only behind the session
          guard, so both of those are settled before it is drawn. */}
      <KycBadge required level={level} signedIn />
      <p>{copy.kyc.requiredBody}</p>
      <Button onClick={() => navigate(`/me/verify?returnTo=${encodeURIComponent(resume)}`)}>
        {copy.kyc.cta}
      </Button>
      <Button variant="ghost" onClick={onClose}>{copy.common.close}</Button>
    </div>
  );
}

/**
 * Where a claim is in its determinate 저장 → 확인 → 완료 wait (plan T-SIMP-1 ④), the 09-27 engine
 * ported onto the relayed claim/request (design §7): the state is the same, only its source moved
 * from an op handle to the `relays/{id}` doc.
 *
 *   - `idle`    — nothing in flight; the button is the claim.
 *   - `saving`  — building the authorization and calling the relayer (저장 중).
 *   - `sent`    — the relayer accepted it; the relay doc is being followed (확인 중).
 *   - `stuck`   — a cancel op's `wait` gave up (still on its way). Approval mode only.
 *   - `done`    — a direct claim landed. A real completion, not a silent redirect.
 */
type ClaimPhase = 'idle' | 'saving' | 'sent' | 'stuck' | 'done';

/**
 * After a requestClaim lands, how long to wait between checks for its ClaimRequest to appear:
 * 2s, then 5s, then 10s repeating, up to {@link APPEAR_CAP_MS}. The indexer writes a claim's mint
 * in seconds but a ClaimRequest row can lag by minutes, so a single refetch shows nothing and the
 * request looks lost (live run scenario d). Polling pauses while the tab is hidden.
 */
const APPEAR_DELAYS = [2_000, 5_000, 10_000] as const;
const APPEAR_CAP_MS = 5 * 60_000;
/** Once the request is in and still Pending, how often to look for an approve/reject. */
const PENDING_POLL_MS = 15_000;

/** The tab is in the background; a poll pauses rather than spending its budget while nobody looks. */
function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/**
 * How the one claim engine is framed (plan B1: 입구 = 상세 인라인 시트, 엔진 = 통일 상태머신).
 *
 *   - `screen` — the `/claim/:id` route, kept for deep-link and identity-check return only.
 *   - `sheet`  — opened in place on the event detail screen, so 상세 → 티켓 받기 is one tap with
 *                no route hop. `onClose` is the detail screen's own close path.
 */
export type ClaimPresentation =
  | { kind: 'screen' }
  | { kind: 'sheet'; onClose: () => void };

export interface ClaimFlowProps {
  /** The numeric event id the claim is for. Both entries hand this in rather than reading a route. */
  eventId: string;
  present: ClaimPresentation;
}

/**
 * The whole claim experience — tier picker, 저장 → 확인 → 완료 wait over the relayer, completion —
 * as one component both entries render (plan B1). Nothing is copied between the route and the
 * sheet: this is the single place the state machine lives.
 */
export function ClaimFlow({ eventId, present }: ClaimFlowProps) {
  const copy = useCopy();
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const { kycLevel, isLoading: kycLoading } = useKycLevel();
  // The type survives the trip through verification in the address; the picker is the owner of
  // it from the first render on, so the initial read happens once and never again.
  const [tier, setTier] = useState(() => {
    const asked = Number(params.get('tier'));
    return Number.isInteger(asked) && asked >= 0 ? asked : 0;
  });
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<ClaimPhase>('idle');
  // A cancel op's send-layer resend is under way ("잠시 붐벼요…"). Only meaningful while `saving`.
  const [retrying, setRetrying] = useState(false);
  const [needsKyc, setNeedsKyc] = useState(false);
  // A priced event's settlement mirror, loaded once: its per-tier price turns the free 받기 into a
  // 결제하고 받기 $X that opens the purchase sheet (Batch F). A free event leaves this null.
  const [settlement, setSettlement] = useState<SettlementView | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const resumed = useRef(false);
  // The relay doc this claim is following, or null. The subscription effect below drives 확인 → 완료
  // from it; a fresh submission or a retry replaces it.
  const [relayId, setRelayId] = useState<string | null>(null);
  // Approval mode only: a landed requestClaim whose ClaimRequest has not surfaced in the indexer
  // yet. `awaiting` runs the appearance poll below; `awaitTimedOut` is the five-minute cap, after
  // which the person is handed a manual 다시 확인 rather than a poll that never stops.
  const [awaiting, setAwaiting] = useState(false);
  const [awaitTimedOut, setAwaitTimedOut] = useState(false);
  const [appearNonce, setAppearNonce] = useState(0);

  // The event and its ticket kinds from the indexer, or from the chain while the indexer lags, so a
  // published event can be claimed even before its row is indexed (`source === 'direct'` then).
  const {
    event, tiers, source, isLoading, isError, error: loadError, refetch, chainHeld, chainHeldLoading,
  } = useClaimEventData(eventId);
  const { data: myTickets, isLoading: ticketsLoading } = useMyTickets();
  // The attendee's own request, for an event that takes requests. Refetched after a request or a
  // cancel lands, since the indexer needs a moment to catch up to the transaction.
  const { request: myRequest, isLoading: requestLoading, refetch: refetchRequest } = useMyRequest(eventId);
  const refetchRequestRef = useRef(refetchRequest);
  refetchRequestRef.current = refetchRequest;

  const selected = tiers[tier];
  // Approval mode: the event takes requests rather than direct claims, so this screen mirrors the
  // request's state from the indexer. A self-cancel and an organiser's rejection both land on
  // `Rejected` — the contract emits one event for both — so `Rejected` reads "not this time" and
  // still lets the person ask again.
  const approval = event?.approvalRequired === true;
  const status = approval ? myRequest?.status : undefined;
  const pending = status === 'Pending';
  const approved = status === 'Approved';
  // A request already waiting or already granted: nothing new is sent from here, and no auto-resume.
  const hasLiveRequest = pending || approved;

  // maxPerWallet is counted per event, not per tier, and a ticket I still hold counts even when
  // it is spent or voided — this mirrors Ticket.balanceOfEvent, which only a transfer decrements.
  // Counting the held tickets (and a live pending request) is what makes the pre-block below fire
  // before a 받기 the chain would only revert — the count this pre-block had lost (live-run 6 / D5).
  // From the chain (`balanceOfEvent`) when the event came from the chain — the indexer's ticket list
  // is unavailable then too — and from the indexer otherwise. Both count per event, transfers aside.
  const held = source === 'direct'
    ? chainHeld ?? 0
    : (myTickets ?? []).filter((mine) => mine.eventId === eventId && mine.state !== 'transferred').length;
  const pendingSlot = pending ? 1 : 0;
  // Unguarded on purpose: the chain compares the same way, so a tier with maxPerWallet 0 lets
  // nobody claim rather than everybody.
  const perWallet = Number(selected?.maxPerWallet ?? 0);
  const limitReached = selected !== undefined && held + pendingSlot >= perWallet;
  const soldOut = selected !== undefined && Number(selected.supply) - Number(selected.minted) <= 0;
  const cancelled = event?.status === CANCELLED;
  const blocked = limitReached || soldOut || cancelled;

  // The pre-block above only holds a claim back once `held` (and, in approval mode, the pending
  // request) is known. On a cold load — the first paint after login — those queries have not
  // answered yet and `held` reads 0, so a fast tap would send a claim the chain only reverts (live
  // check e). The button waits: disabled with a quiet 확인 중… until both counts have resolved.
  // In the chain-fallback path the held count is the chain read (`chainHeld`), not the indexer's
  // ticket list — which lags with the event row — so the gate waits on that read instead.
  const countsResolved = source === 'direct'
    ? !chainHeldLoading
    : !ticketsLoading && !(approval && requestLoading);

  // The button is down for every state but the two the person acts from.
  const busy = phase === 'saving' || phase === 'sent';

  // The selected tier's settlement price, when this is a priced event. A direct-claim event with a
  // price becomes a purchase (Batch F); approval events and free events keep the free claim path.
  const price = settlementEnabled() ? settlement?.priceUsdCentsByTier?.[String(tier)] : undefined;
  const priced = !approval && price !== undefined && price > 0;

  // A cancel op's real failure sentence. Approval mode is the only place cancel runs, so this is
  // describeFailure (offline, indexer, generic); an unknown outcome is handled before it.
  const opFailure = useCallback(
    (cause: unknown): string => (approval ? describeFailure(cause, copy) : copy.claim.failed),
    [approval, copy],
  );

  // Finishes a confirmed relay: a direct claim shows 완료, a request starts the appearance wait.
  const settleConfirmed = useCallback(
    async (mode: 'claim' | 'request'): Promise<void> => {
      if (mode === 'request') {
        // No mint here — the request reserves supply and waits for the organiser. The row can lag
        // the transaction by minutes, so start the appearance wait rather than showing nothing.
        const row = await refetchRequest();
        setPhase('idle');
        if (row === null) { setAwaitTimedOut(false); setAwaiting(true); }
      } else {
        // A real completion in place of the old silent navigate('/tickets') (plan T-SIMP-1 ③).
        setPhase('done');
      }
    },
    [refetchRequest],
  );

  // One submission through the relayer, with the single BAD_NONCE retry (design §5): if the chain
  // moved the nonce under us (a stale or duplicate authorization) the server reports the current
  // one, so the auth is rebuilt with it and sent once more — never a loop.
  const submitRelay = useCallback(
    async (mode: 'claim' | 'request', account: Hex) => {
      const send = async (nonce?: bigint) => {
        const { auth, deviceSig } = await buildClaimAuth({ eventId, tier, account, nonce });
        return api.relayClaim({ mode, auth, deviceSig });
      };
      try {
        return await send();
      } catch (cause) {
        const { code, nonce } = relayClaimError(cause);
        if (code === 'BAD_NONCE' && nonce !== undefined) return await send(BigInt(nonce));
        throw cause;
      }
    },
    [eventId, tier],
  );

  const run = useCallback(async () => {
    if (!event) return;
    // The contract checks this again, so the sheet is here to save a doomed signature, not to secure.
    if (event.requireKyc && kycLevel < VERIFIED_LEVEL) {
      setNeedsKyc(true);
      return;
    }
    const mode: 'claim' | 'request' = event.approvalRequired === true ? 'request' : 'claim';
    setPhase('saving');
    setError('');
    setRetrying(false);
    setRelayId(null);
    try {
      const account = (await getAttendeeAccount()).address;
      const result = await submitRelay(mode, account);
      // The relayer already saw the receipt: skip the wait and settle straight away.
      if (result.status === 'confirmed') {
        await settleConfirmed(mode);
        return;
      }
      // Still on its way: follow the relay doc and let the subscription below drive 확인 → 완료.
      setRelayId(result.relayId);
      setPhase('sent');
    } catch (cause) {
      // A determinate refusal, mapped to its attendee sentence; an unknown code is the generic retry.
      setError(relayClaimCopy(relayClaimError(cause).code, copy));
      setPhase('idle');
    }
  }, [event, kycLevel, submitRelay, settleConfirmed, copy]);

  // Takes back a pending request. `cancelRequest` emits the same `ClaimRejected` an organiser's
  // reject does, so after it lands the row reads `Rejected` and the screen offers 신청하기 again. It
  // is the attendee's own sponsored op — not relayed — so it keeps the 09-27 op wait as it was.
  const cancel = useCallback(async () => {
    if (!event || myRequest === null) return;
    setPhase('saving');
    setError('');
    setRetrying(false);
    try {
      // `cancelRequest` is relayed now (design §5): the device key signs the ForwardRequest and the
      // relayer submits it. `sendAction` follows the relay doc to a settled answer, so the old op
      // handle's onSubmitted/onSendRetry and 45s cap are gone — the relayer settles authoritatively.
      await sendAction(
        'cancelRequest',
        'ticket',
        encodeFunctionData({
          abi: ticketAbi,
          functionName: 'cancelRequest',
          args: [BigInt(eventId), BigInt(myRequest.requestId)],
        }),
      );
      await refetchRequest();
      setPhase('idle');
    } catch (cause) {
      // An unknown outcome (a dropped relay listener) is not a failure — the cancel may still land,
      // so hand it to 'stuck' rather than say it failed. A determinate refusal gets its sentence.
      if (relayClaimError(cause).code === '') {
        setPhase('stuck');
        return;
      }
      setError(opFailure(cause));
      setPhase('idle');
    }
  }, [event, myRequest, eventId, refetchRequest, opFailure]);

  // Loads the event's settlement mirror once (Batch F), so a priced tier can offer a purchase. A
  // free event (or an unwired build) simply leaves it null and the free claim path stands.
  useEffect(() => {
    if (!settlementEnabled() || eventId === '') return undefined;
    let live = true;
    void getSettlement(eventId).then((loaded) => {
      if (live) setSettlement(loaded);
    });
    return () => {
      live = false;
    };
  }, [eventId]);

  // Follows the relay doc while a claim is confirming. `confirmed` settles it (완료, or the request
  // appearance wait); `failed` shows the code's sentence and hands the button back; pending/sent
  // stay in 확인 중. A dropped listener leaves the wait as it is — the 45s cap and 다시 시도 are the
  // way out, and re-tapping is idempotent by nonce.
  useEffect(() => {
    if (relayId === null || phase !== 'sent') return undefined;
    const mode: 'claim' | 'request' = approval ? 'request' : 'claim';
    return watchRelay(
      relayId,
      (relay) => {
        if (relay === null) return;
        if (relay.status === 'confirmed') {
          setRelayId(null);
          void settleConfirmed(mode);
        } else if (relay.status === 'failed') {
          setRelayId(null);
          setError(relayClaimCopy(relay.error?.code ?? '', copy));
          setPhase('idle');
        }
      },
      () => undefined,
    );
  }, [relayId, phase, approval, settleConfirmed, copy]);

  /**
   * Coming back from the identity check with `intent=claim` finishes the claim the sheet
   * interrupted. Four things keep it honest:
   *
   * - a latch, because StrictMode runs an effect twice on the same fiber and a second claim is
   *   a second ticket;
   * - the address is cleared **before** the claim runs, so a refresh in the middle of one does
   *   not start another;
   * - `useKycLevel` answers 0 while it is still asking, so the wait is part of the condition
   *   rather than a reason to send the person back to the sheet;
   * - nothing fires while a claim is already going, or when the ticket could not be had anyway
   *   — the sentence on the screen is the answer then, not another attempt.
   */
  useEffect(() => {
    if (resumed.current) return;
    if (params.get('intent') !== CLAIM_INTENT) return;
    if (!event || selected === undefined || kycLoading || kycLevel < VERIFIED_LEVEL) return;
    // A live request already covers an approval event, so a resume there would only revert.
    if (phase !== 'idle' || blocked || hasLiveRequest) return;
    resumed.current = true;
    const next = new URLSearchParams(params);
    next.delete('intent');
    next.delete('tier');
    setSearchParams(next, { replace: true });
    void run();
  }, [params, setSearchParams, event, selected, kycLoading, kycLevel, phase, blocked, hasLiveRequest, run]);

  // Approval mode: a landed requestClaim whose ClaimRequest has not surfaced in the indexer yet.
  // Re-poll on a 2s -> 5s -> 10s backoff up to five minutes, pausing while the tab is hidden, until
  // the row appears -- then this stops and the pending poll keeps it live. `appearNonce` restarts it
  // when the cap was hit and the person taps 다시 확인.
  useEffect(() => {
    if (!approval || !awaiting || myRequest !== null || awaitTimedOut) return undefined;
    let live = true;
    let handle: ReturnType<typeof setTimeout> | undefined;
    let index = 1;
    let elapsed = APPEAR_DELAYS[0] as number;
    const tick = async (): Promise<void> => {
      if (!live) return;
      if (tabHidden()) return; // paused; the visibility listener resumes it
      const row = await refetchRequestRef.current();
      if (!live) return;
      if (row !== null) {
        setAwaiting(false);
        return;
      }
      if (elapsed >= APPEAR_CAP_MS) {
        setAwaitTimedOut(true);
        return;
      }
      const delay = APPEAR_DELAYS[Math.min(index, APPEAR_DELAYS.length - 1)] ?? 10_000;
      index += 1;
      elapsed += delay;
      handle = setTimeout(() => void tick(), delay);
    };
    handle = setTimeout(() => void tick(), APPEAR_DELAYS[0]);
    const onVisible = (): void => {
      if (!live || tabHidden()) return;
      if (handle !== undefined) clearTimeout(handle);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      if (handle !== undefined) clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [approval, awaiting, myRequest, awaitTimedOut, appearNonce]);

  // Approval mode: keep a Pending request live, so an approve/reject shows without a reload. Every
  // 15s while Pending, paused while the tab is hidden; it stops the moment the status changes.
  useEffect(() => {
    if (!approval || myRequest?.status !== 'Pending') return undefined;
    let live = true;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (!live) return;
      if (!tabHidden()) await refetchRequestRef.current();
      if (live) handle = setTimeout(() => void tick(), PENDING_POLL_MS);
    };
    handle = setTimeout(() => void tick(), PENDING_POLL_MS);
    const onVisible = (): void => {
      if (!live || tabHidden()) return;
      if (handle !== undefined) clearTimeout(handle);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      if (handle !== undefined) clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [approval, myRequest?.status]);

  // 다시 확인: the appearance cap was hit with nothing showing; restart the poll from the top.
  const recheck = (): void => {
    setAwaitTimedOut(false);
    setAppearNonce((nonce) => nonce + 1);
  };

  // The one seam between the two entries: the route paints a full 화면, the detail entry a 시트 in
  // place. Everything above this line is identical for both. The sheet's own grab bar and its
  // scrim are the way out now, so it no longer stacks a full-width 닫기 under the primary where the
  // two competed for the eye (visual R1-11).
  const reassurance = present.kind === 'sheet' ? copy.common.free : copy.common.montiHandles;
  const frame = (heading: string, body: ReactNode): ReactNode =>
    present.kind === 'sheet' ? (
      <Sheet label={heading} onDismiss={present.onClose}>
        {body}
      </Sheet>
    ) : (
      <Screen title={heading}>{body}</Screen>
    );

  if (isLoading) {
    return frame(copy.claim.cta, <Spinner />);
  }
  if (isError || !event) {
    return frame(
      copy.claim.cta,
      <>
        <Alert tone="error">{describeFailure(loadError, copy)}</Alert>
        <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
      </>,
    );
  }

  return frame(
    approval ? copy.claim.requestCta : copy.claim.cta,
    phase === 'done' ? (
      <>
        {/* A real 완료 state, not a silent redirect (plan T-SIMP-1 ③). */}
        <Alert tone="info">{copy.claim.done}</Alert>
        <Link to="/tickets" className="btn btn--primary btn--link">{copy.claim.approvedCta}</Link>
      </>
    ) : approved ? (
      <>
        <Alert tone="info">{copy.claim.approved}</Alert>
        <Link to="/tickets" className="btn btn--primary btn--link">{copy.claim.approvedCta}</Link>
      </>
    ) : pending ? (
      <>
        <Alert tone="info">{copy.claim.pending}</Alert>
        {phase === 'stuck' ? <Alert tone="info">{copy.claim.confirming}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {/* The determinate wait, in place of a bare spinner (plan §2c). No retry here: cancelling
            is the op, and its confirming line already says to check back. */}
        {busy ? (
          <OpProgress
            phase={phase === 'sent' ? 'confirming' : 'saving'}
            note={phase === 'saving' && retrying ? copy.op.busy : undefined}
          />
        ) : null}
        {/* A cancel is the only op here, so busy is enough to keep a second tap from firing it. */}
        <Button variant="ghost" onClick={() => void cancel()} disabled={phase !== 'idle'}>
          {busy ? copy.claim.cancelling : copy.claim.cancel}
        </Button>
      </>
    ) : approval && awaiting && myRequest === null ? (
      <>
        {/* The request landed on chain but the indexer has not caught up; the poll above keeps
            looking. A real "we have it" in place of a screen showing nothing (live run d). */}
        <Alert tone="info">{copy.claim.received}</Alert>
        {awaitTimedOut ? (
          <Button variant="ghost" onClick={recheck}>{copy.common.retry}</Button>
        ) : null}
        <Link to="/tickets" className="btn btn--primary btn--link">{copy.claim.approvedCta}</Link>
      </>
    ) : (
      <>
        {tiers.length > 1 ? (
          <Field label={copy.claim.tierLabel}>
            <select value={tier} onChange={(changed) => setTier(Number(changed.target.value))}>
              {tiers.map((entry, index) => (
                <option key={entry.id} value={index}>{entry.name}</option>
              ))}
            </select>
          </Field>
        ) : selected !== undefined ? (
          // 티어가 하나뿐이면 드롭다운은 군더더기다: 종류를 그냥 보여준다(visual R1-11).
          <p>{copy.claim.tierLabel}: {selected.name}</p>
        ) : null}
        {status === 'Rejected' ? <Alert tone="warn">{copy.claim.rejected}</Alert> : null}
        {limitReached ? (
          held > 0 ? (
            <>
              {/* Already holds this event's allotment: say so and point at 내 티켓. The 받기 button
                  below stays disabled (blocked) — a tap here only ever hits the chain's revert. */}
              <Alert tone="warn">{copy.claim.alreadyHave}</Alert>
              <Link to="/tickets" className="btn btn--primary btn--link">{copy.claim.approvedCta}</Link>
            </>
          ) : (
            // maxPerWallet 0: a tier nobody may hold — they have received nothing, so no 내 티켓 link.
            <Alert tone="warn">{copy.claim.limitReached}</Alert>
          )
        ) : null}
        {soldOut ? <Alert tone="warn">{copy.claim.soldOut}</Alert> : null}
        {cancelled ? <Alert tone="warn">{copy.discover.cancelled}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {needsKyc ? (
          <KycRequiredSheet eventId={eventId} tier={tier} level={kycLevel} onClose={() => setNeedsKyc(false)} />
        ) : null}
        {/* The determinate wait for claim/requestClaim, in place of a bare spinner (plan §2c). Past
            the 45s cap OpProgress offers 다시 시도; re-running is idempotent by nonce, so a late relay
            cannot be doubled by it. */}
        {busy ? (
          <OpProgress
            phase={phase === 'sent' ? 'confirming' : 'saving'}
            onRetry={phase === 'sent' ? () => void run() : undefined}
          />
        ) : null}
        {/* Still confirming counts as busy: the submission is already on its way and a second tap
            would ask twice — `held` cannot have caught up yet to stop it. */}
        {priced ? (
          <>
            {/* A priced event: 결제하고 받기 $X opens the mock card sheet (Batch F). KYC is checked
                first — the same gate the free claim applies — so a doomed charge is never started. */}
            <Button
              onClick={() => {
                if (event.requireKyc && kycLevel < VERIFIED_LEVEL) {
                  setNeedsKyc(true);
                  return;
                }
                setPurchasing(true);
              }}
              disabled={phase !== 'idle' || blocked || !countsResolved}
            >
              {!countsResolved ? copy.claim.checking : `${copy.purchase.cta} ${formatUsdCents(price ?? 0)}`}
            </Button>
            {purchasing ? (
              <PurchaseSheet
                eventId={eventId}
                tier={tier}
                amountUsdCents={price ?? 0}
                onClose={() => setPurchasing(false)}
              />
            ) : null}
          </>
        ) : (
          <>
            <Button onClick={() => void run()} disabled={phase !== 'idle' || blocked || !countsResolved}>
              {!countsResolved
                ? copy.claim.checking
                : approval
                  ? busy
                    ? copy.claim.requesting
                    : copy.claim.requestCta
                  : busy
                    ? copy.claim.working
                    : copy.claim.cta}
            </Button>
            {/* Reassurance right by the button (plan C 여정 A): free, and MONTI does the hard part.
                The detail sheet says "무료예요 · 돈 안 들어요"; the route keeps the create-path wording. */}
            <p className="muted">{reassurance}</p>
          </>
        )}
      </>
    ),
  );
}
