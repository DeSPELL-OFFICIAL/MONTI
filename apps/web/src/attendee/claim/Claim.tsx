import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Field, KycBadge, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { describeFailure } from '../../shared/errors';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { ticketOp, OpReverted } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { useKycLevel } from '../me/useKycLevel';
import { useMyTickets } from '../tickets/useTickets';

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
 * getting a ticket, so finish it for them instead of making them find the button again.
 */
const CLAIM_INTENT = 'claim';

/**
 * Shown instead of claiming when the event requires identity verification.
 *
 * The return address is this screen and not the event page: the event page has no claim in it,
 * so coming back there costs two more taps, and the chosen type would be gone by the time the
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

export function Claim() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { eventId = '' } = useParams();
  const [params, setSearchParams] = useSearchParams();
  const { kycLevel, isLoading: kycLoading } = useKycLevel();
  // The type survives the trip through verification in the address; the picker is the owner of
  // it from the first render on, so the initial read happens once and never again.
  const [tier, setTier] = useState(() => {
    const asked = Number(params.get('tier'));
    return Number.isInteger(asked) && asked >= 0 ? asked : 0;
  });
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'working' | 'confirming'>('idle');
  const [needsKyc, setNeedsKyc] = useState(false);
  const resumed = useRef(false);

  const { data, isLoading, isError, error: loadError, refetch } = useQuery({
    queryKey: ['claim', eventId],
    // `id` is the text primary key, `eventId` the numeric column the tiers hang off.
    queryFn: () => gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId }),
  });
  const { data: myTickets } = useMyTickets();

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

  const run = useCallback(async () => {
    if (!event) return;
    // The contract checks this again, so the sheet is here to save a doomed signature, not to secure.
    if (event.requireKyc && kycLevel < VERIFIED_LEVEL) {
      setNeedsKyc(true);
      return;
    }
    setPhase('working');
    setError('');
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: BigInt(event.orgId),
        functionName: 'claim',
        args: [BigInt(eventId), tier, NO_VOUCHER],
      });
      navigate('/tickets');
    } catch (cause) {
      if (cause instanceof OpReverted && cause.revertReason === STILL_CONFIRMING) {
        setPhase('confirming');
        return;
      }
      setError(copy.claim.failed);
      setPhase('idle');
    }
  }, [event, kycLevel, eventId, tier, navigate, copy.claim.failed]);

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
    if (phase !== 'idle' || blocked) return;
    resumed.current = true;
    const next = new URLSearchParams(params);
    next.delete('intent');
    next.delete('tier');
    setSearchParams(next, { replace: true });
    void run();
  }, [params, setSearchParams, event, selected, kycLoading, kycLevel, phase, blocked, run]);

  if (isLoading) {
    return (
      <Screen title={copy.claim.cta}>
        <Spinner />
      </Screen>
    );
  }
  if (isError || !event) {
    return (
      <Screen title={copy.claim.cta}>
        <Alert tone="error">{describeFailure(loadError, copy)}</Alert>
        <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
      </Screen>
    );
  }

  return (
    <Screen title={copy.claim.cta}>
      <Field label={copy.claim.tierLabel}>
        <select value={tier} onChange={(changed) => setTier(Number(changed.target.value))}>
          {tiers.map((entry, index) => (
            <option key={entry.id} value={index}>{entry.name}</option>
          ))}
        </select>
      </Field>
      {limitReached ? <Alert tone="warn">{copy.claim.limitReached}</Alert> : null}
      {soldOut ? <Alert tone="warn">{copy.claim.soldOut}</Alert> : null}
      {cancelled ? <Alert tone="warn">{copy.discover.cancelled}</Alert> : null}
      {phase === 'confirming' ? (
        <>
          <Alert tone="info">{copy.claim.confirming}</Alert>
          <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
        </>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {needsKyc ? (
        <KycRequiredSheet eventId={eventId} tier={tier} level={kycLevel} onClose={() => setNeedsKyc(false)} />
      ) : null}
      {/* Still confirming counts as busy: the op is already on its way and a second tap would
          claim twice — `held` cannot have caught up yet to stop it. */}
      <Button onClick={() => void run()} disabled={phase !== 'idle' || blocked}>
        {phase === 'working' ? copy.claim.working : copy.claim.cta}
      </Button>
    </Screen>
  );
}
