import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { Alert, Button, Field, KycBadge, OpProgress, Screen, Sheet, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { describeFailure } from '../../shared/errors';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { useMyRequest } from '../../shared/envio/claimRequests';
import { ticketOp, resolveSubmittedOp, OpReverted } from '../../shared/chain/ops';
import { MAX_WAIT_TIMEOUT_MS } from '../../shared/chain/sendSponsoredOp';
import { ticketAbi } from '../../shared/chain/abis';
import { revertMatch } from '../../shared/chain/revert';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { useKycLevel } from '../me/useKycLevel';
import { useMyTickets } from '../tickets/useTickets';
import { clearClaimDraft, guardClaim, readClaimDraft, writeClaimDraft } from './claimDraft';

/** Free tiers only in the MVP, so the voucher the contract takes is always empty. */
const NO_VOUCHER = '0x';
/** `wait` gave up before the op landed. Not a failure — it is still on its way. */
const STILL_CONFIRMING = 'TIMEOUT';
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
 * Where a claim is in its determinate 저장 → 확인 → 완료 wait (plan T-SIMP-1 ④), the create path's
 * engine ported onto claim/requestClaim:
 *
 *   - `idle`    — nothing in flight; the button is the claim.
 *   - `saving`  — building and sending the op (저장 중). A transient precheck resend shows here.
 *   - `sent`    — the op is in the mempool, its hash recorded, waiting for the receipt (확인 중).
 *   - `stuck`   — `wait` gave up (still on its way). The recorded hash lets a return resolve it.
 *   - `done`    — a direct claim landed. A real completion, not a silent redirect.
 */
type ClaimPhase = 'idle' | 'saving' | 'sent' | 'stuck' | 'done';

/** How often a resumed, still-pending op is re-checked — the create home banner's own cadence. */
const CLAIM_POLL_MS = 4_000;

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
 * The whole claim experience — tier picker, 저장 → 확인 → 완료 wait, durable-hash resolve-first
 * dedup, auto-resend and completion — as one component both entries render (plan B1). Nothing is
 * copied between the route and the sheet: this is the single place the state machine lives.
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
  // A send-layer resend is under way ("잠시 붐벼요…"). Only meaningful while `saving`.
  const [retrying, setRetrying] = useState(false);
  const [needsKyc, setNeedsKyc] = useState(false);
  const resumed = useRef(false);

  const { data, isLoading, isError, error: loadError, refetch } = useQuery({
    queryKey: ['claim', eventId],
    // `id` is the text primary key, `eventId` the numeric column the tiers hang off.
    queryFn: () => gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId }),
  });
  const { data: myTickets } = useMyTickets();
  // The attendee's own request, for an event that takes requests. Refetched after a request or a
  // cancel lands, since the indexer needs a moment to catch up to the transaction.
  const { request: myRequest, refetch: refetchRequest } = useMyRequest(eventId);

  const event = data?.Event[0];
  const tiers = data?.Tier ?? [];
  const selected = tiers[tier];
  // maxPerWallet is counted per event, not per tier, and a ticket I still hold counts even when
  // it is spent or voided — this mirrors Ticket.balanceOfEvent, which only a transfer decrements.
  const held = (myTickets ?? []).filter((mine) => mine.eventId === eventId && mine.state !== 'transferred').length;
  // Unguarded on purpose: the chain compares the same way, so a tier with maxPerWallet 0 lets
  // nobody claim rather than everybody.
  const perWallet = Number(selected?.maxPerWallet ?? 0);
  const limitReached = selected !== undefined && held >= perWallet;
  const soldOut = selected !== undefined && Number(selected.supply) - Number(selected.minted) <= 0;
  const cancelled = event?.status === CANCELLED;
  const blocked = limitReached || soldOut || cancelled;

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

  // The button is down for every state but the two the person acts from.
  const busy = phase === 'saving' || phase === 'sent';

  // The ApprovalRequired revert is the one an attendee can hit from either call — `claim` on an
  // event that turned on approval after the page loaded — so it is named first, off the Ticket ABI.
  // Everything else goes through describeFailure (offline, indexer, generic); a plain claim keeps
  // its own short sentence, which its tests pin.
  const opFailure = useCallback(
    (cause: unknown): string => {
      if (cause instanceof OpReverted && cause.revertReason && cause.revertReason !== STILL_CONFIRMING) {
        const named = revertMatch(ticketAbi, cause.revertReason as Hex, [
          ['ApprovalRequired', copy.claim.approvalOnly],
        ]);
        if (named !== undefined) return named;
      }
      return approval ? describeFailure(cause, copy) : copy.claim.failed;
    },
    [approval, copy],
  );

  const run = useCallback(async () => {
    if (!event) return;
    // The contract checks this again, so the sheet is here to save a doomed signature, not to secure.
    if (event.requireKyc && kycLevel < VERIFIED_LEVEL) {
      setNeedsKyc(true);
      return;
    }
    const fn = event.approvalRequired === true ? 'requestClaim' : 'claim';
    setPhase('saving');
    setError('');
    setRetrying(false);
    try {
      // Never a blind resend (plan T-SIMP-1 ②): only when an op is already recorded for this event
      // does this ask what became of it first — the same guard the create path is built on. With
      // nothing recorded there is nothing to duplicate, so a fresh claim goes straight to the send.
      const existing = readClaimDraft(eventId);
      if (existing !== null) {
        const step = await guardClaim(existing, resolveSubmittedOp);
        if (step === 'wait') {
          // Still on its way. Keep waiting rather than sending a second ticket.
          setPhase('sent');
          return;
        }
        if (step === 'complete') {
          // The recorded op already landed. The ticket (or request) exists; do not send again.
          clearClaimDraft(eventId);
          if (fn === 'requestClaim') {
            await refetchRequest();
            setPhase('idle');
          } else {
            setPhase('done');
          }
          return;
        }
        // `send`: the recorded op is dead/stuck — drop it and resend with current fees.
        clearClaimDraft(eventId);
      }
      const args = fn === 'requestClaim'
        ? [BigInt(eventId), tier]
        : [BigInt(eventId), tier, NO_VOUCHER];
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: BigInt(event.orgId),
        functionName: fn,
        args,
        // Poll the receipt to the same 45s cap OpProgress shows, so a late inclusion lands on
        // its own instead of dropping to 확인/stuck at 15s while the counter still runs (T-SIMP-7).
        maxTimeoutMs: MAX_WAIT_TIMEOUT_MS,
        // Recorded the moment the bundler accepts it, before the wait, so a page closed mid-wait
        // resolves this op next time instead of claiming twice. This is also what turns 저장 → 확인.
        onSubmitted: (hash) => {
          writeClaimDraft(eventId, { fn, tier, opHash: hash, submittedAt: Date.now() });
          setPhase('sent');
        },
        onSendRetry: () => setRetrying(true),
      });
      // Landed. The ticket exists (claim) or the request is in (requestClaim).
      clearClaimDraft(eventId);
      if (fn === 'requestClaim') {
        // No mint here — the request reserves supply and waits for the organiser. The screen stays
        // put and refetches, so the button becomes the pending state rather than jumping away.
        await refetchRequest();
        setPhase('idle');
      } else {
        // A real completion in place of the old silent navigate('/tickets') (plan T-SIMP-1 ③).
        setPhase('done');
      }
    } catch (cause) {
      if (cause instanceof OpReverted && cause.revertReason === STILL_CONFIRMING) {
        // The op is on its way; its hash was recorded before the wait, so a return resolves it.
        setPhase('stuck');
        return;
      }
      // A real failure — the op will never land, so drop the record and let the button send fresh.
      clearClaimDraft(eventId);
      setError(opFailure(cause));
      setPhase('idle');
    }
  }, [event, kycLevel, eventId, tier, refetchRequest, opFailure]);

  // Takes back a pending request. `cancelRequest` emits the same `ClaimRejected` an organiser's
  // reject does, so after it lands the row reads `Rejected` and the screen offers 신청하기 again.
  const cancel = useCallback(async () => {
    if (!event || myRequest === null) return;
    setPhase('saving');
    setError('');
    setRetrying(false);
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: BigInt(event.orgId),
        functionName: 'cancelRequest',
        args: [BigInt(eventId), BigInt(myRequest.requestId)],
        // Same 45s cap the cancel's OpProgress counts to, so a late inclusion still lands (T-SIMP-7).
        maxTimeoutMs: MAX_WAIT_TIMEOUT_MS,
        onSubmitted: () => setPhase('sent'),
        onSendRetry: () => setRetrying(true),
      });
      await refetchRequest();
      setPhase('idle');
    } catch (cause) {
      if (cause instanceof OpReverted && cause.revertReason === STILL_CONFIRMING) {
        setPhase('stuck');
        return;
      }
      setError(opFailure(cause));
      setPhase('idle');
    }
  }, [event, myRequest, eventId, refetchRequest, opFailure]);

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

  /**
   * A refresh or deep-link return to `/claim/:id` while an op was in flight (plan B1: this route
   * exists for exactly that). The op hash was stored in the claim draft, so `run` re-checks it and
   * routes — pending keeps waiting, landed completes, dead resends — never a blind second claim.
   * Captured once at mount so a hash `run` records mid-flight cannot re-trigger this. Shares the
   * resume latch with the identity-check path, so at most one auto-resume ever fires.
   */
  const [pendingOp] = useState(() => readClaimDraft(eventId));
  useEffect(() => {
    if (resumed.current || pendingOp === null) return;
    if (!event || selected === undefined || hasLiveRequest) return;
    if (kycLoading) return; // wait for the answer rather than flashing the verification sheet
    if (event.requireKyc && kycLevel < VERIFIED_LEVEL) return;
    resumed.current = true;
    void run();
  }, [pendingOp, event, selected, hasLiveRequest, kycLoading, kycLevel, run]);

  // While a resumed op is still confirming, keep asking until it settles — the create home banner's
  // poll, ported. Only runs in the `sent` state a resume produced; a fresh claim's own wait covers
  // the live case. Landed completes it; dead clears the record and hands the button back.
  useEffect(() => {
    if (pendingOp === null || phase !== 'sent') return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const step = await guardClaim(readClaimDraft(eventId), resolveSubmittedOp);
      if (!live) return;
      if (step === 'wait') {
        timer = setTimeout(() => void tick(), CLAIM_POLL_MS);
        return;
      }
      clearClaimDraft(eventId);
      if (step === 'complete') {
        if (approval) {
          await refetchRequest();
          if (live) setPhase('idle');
        } else if (live) {
          setPhase('done');
        }
        return;
      }
      if (live) setPhase('idle'); // the op died: hand the button back for a fresh claim
    };
    timer = setTimeout(() => void tick(), CLAIM_POLL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pendingOp, phase, eventId, approval, refetchRequest]);

  // The one seam between the two entries: the route paints a full 화면, the detail entry a 시트 in
  // place. Everything above this line is identical for both. The sheet also carries an explicit
  // 닫기 for a phone with no fling and a desktop with no gesture at all.
  const reassurance = present.kind === 'sheet' ? copy.common.free : copy.common.montiHandles;
  const frame = (heading: string, body: ReactNode): ReactNode =>
    present.kind === 'sheet' ? (
      <Sheet label={heading} onDismiss={present.onClose}>
        {body}
        <Button variant="ghost" onClick={present.onClose}>{copy.common.close}</Button>
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
    ) : (
      <>
        <Field label={copy.claim.tierLabel}>
          <select value={tier} onChange={(changed) => setTier(Number(changed.target.value))}>
            {tiers.map((entry, index) => (
              <option key={entry.id} value={index}>{entry.name}</option>
            ))}
          </select>
        </Field>
        {status === 'Rejected' ? <Alert tone="warn">{copy.claim.rejected}</Alert> : null}
        {limitReached ? <Alert tone="warn">{copy.claim.limitReached}</Alert> : null}
        {soldOut ? <Alert tone="warn">{copy.claim.soldOut}</Alert> : null}
        {cancelled ? <Alert tone="warn">{copy.discover.cancelled}</Alert> : null}
        {phase === 'stuck' ? (
          <>
            <Alert tone="info">{copy.claim.confirming}</Alert>
            <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
          </>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {needsKyc ? (
          <KycRequiredSheet eventId={eventId} tier={tier} level={kycLevel} onClose={() => setNeedsKyc(false)} />
        ) : null}
        {/* The determinate wait for claim/requestClaim, in place of a bare spinner (plan §2c). */}
        {busy ? (
          <OpProgress
            phase={phase === 'sent' ? 'confirming' : 'saving'}
            note={phase === 'saving' && retrying ? copy.op.busy : undefined}
          />
        ) : null}
        {/* Still confirming counts as busy: the op is already on its way and a second tap would
            claim twice — `held` cannot have caught up yet to stop it. */}
        <Button onClick={() => void run()} disabled={phase !== 'idle' || blocked}>
          {approval
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
    ),
  );
}
