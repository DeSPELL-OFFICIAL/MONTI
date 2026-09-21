import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Field, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { ticketOp, OpReverted } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { useKycLevel } from '../me/useKycLevel';
import { useMyTickets } from '../tickets/useTickets';

/** Free tiers only in the MVP, so the voucher the contract takes is always empty. */
const NO_VOUCHER = '0x';
/** `wait` gave up before the op landed. Not a failure — it is still on its way. */
const STILL_CONFIRMING = 'TIMEOUT';

/** Shown instead of claiming when the event requires identity verification. */
export function KycRequiredSheet({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const copy = useCopy();
  const navigate = useNavigate();
  return (
    <div role="dialog" aria-modal="true">
      <h2>{copy.kyc.requiredTitle}</h2>
      <p>{copy.kyc.requiredBody}</p>
      <Button onClick={() => navigate(`/me/verify?returnTo=/events/${eventId}`)}>{copy.kyc.cta}</Button>
      <Button variant="ghost" onClick={onClose}>{copy.common.close}</Button>
    </div>
  );
}

export function Claim() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { eventId = '' } = useParams();
  const { kycLevel } = useKycLevel();
  const [tier, setTier] = useState(0);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'working' | 'confirming'>('idle');
  const [needsKyc, setNeedsKyc] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
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

  async function run() {
    if (!event) return;
    // The contract checks this again, so the sheet is here to save a doomed signature, not to secure.
    if (event.requireKyc && kycLevel < 1) {
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
  }

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
        <Alert tone="error">{copy.common.error}</Alert>
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
      {phase === 'confirming' ? (
        <>
          <Alert tone="info">{copy.claim.confirming}</Alert>
          <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
        </>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {needsKyc ? <KycRequiredSheet eventId={eventId} onClose={() => setNeedsKyc(false)} /> : null}
      {/* Still confirming counts as busy: the op is already on its way and a second tap would
          claim twice — `held` cannot have caught up yet to stop it. */}
      <Button onClick={() => void run()} disabled={phase !== 'idle' || limitReached}>
        {phase === 'working' ? copy.claim.working : copy.claim.cta}
      </Button>
    </Screen>
  );
}
