import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Hex } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import { api, type PendingOffer } from '../../shared/api/functions';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { ticketOp } from '../../shared/chain/ops';
import { readIdentity, readTicket } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';
import { acceptFailure, isStillConfirming, orgIdOfTicket } from '../transfer/offers';

export interface InboxRow {
  offer: PendingOffer;
  /** The event's organisation sponsors the operation that collects the ticket. */
  orgId: bigint;
  /** The event asks for identity verification and this attendee has not done it, so
   *  `acceptOffer` would revert with `KycRequired`. The row offers the check instead. */
  needsKyc: boolean;
}

/**
 * What is waiting, with the one rule that decides whether it can be collected at all. The
 * verification level comes from `Identity` rather than from the signup record: the contract
 * reads the chain, and so must the gate that predicts it.
 */
async function loadInbox(account: Hex): Promise<InboxRow[]> {
  const offers = await api.pendingOffers();
  if (offers.length === 0) return [];
  const ticket = readTicket();
  const kycLevel = await readIdentity().kycLevelOf(account);
  return Promise.all(
    offers.map(async (offer) => {
      const meta = await ticket.eventMeta(await ticket.eventOf(BigInt(offer.tokenId)));
      return { offer, orgId: meta.orgId, needsKyc: meta.requireKyc && kycLevel < 1 };
    }),
  );
}

export type OrgIdOf = (tokenId: bigint) => Promise<bigint>;

/**
 * Called the moment signup finishes, so somebody who arrived from a text finds the ticket
 * already theirs. Rows go one at a time on purpose: a single refusal — a verification not
 * done, an invite that expired, one already collected — must not abort the rest of the inbox.
 * Returns how many were really collected.
 */
export async function acceptPendingOffers(orgIdOf: OrgIdOf = orgIdOfTicket): Promise<number> {
  const offers = await api.pendingOffers();
  if (offers.length === 0) return 0;
  const account = await getAttendeeAccount();
  let accepted = 0;
  for (const offer of offers) {
    const tokenId = BigInt(offer.tokenId);
    try {
      await ticketOp({
        account,
        orgId: await orgIdOf(tokenId),
        functionName: 'acceptOffer',
        args: [tokenId, offer.attesterSig],
      });
      accepted += 1;
    } catch {
      /* leave it in the inbox; the screen below says why when the person opens it */
    }
  }
  return accepted;
}

export function Inbox() {
  const copy = useCopy();
  const navigate = useNavigate();
  const session = useSession();
  const queryClient = useQueryClient();
  const account = session.account;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['pendingOffers', account ?? ''],
    enabled: Boolean(account),
    queryFn: () => loadInbox(account as Hex),
  });
  const rows = data ?? [];

  async function take(row: InboxRow): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: row.orgId,
        functionName: 'acceptOffer',
        args: [BigInt(row.offer.tokenId), row.offer.attesterSig],
      });
      setMessage(copy.transfer.accepted);
      await queryClient.invalidateQueries({ queryKey: ['pendingOffers'] });
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
    } catch (cause) {
      // Still on its way is not a denial: the ticket may well be here in a moment.
      if (isStillConfirming(cause)) setMessage(copy.transfer.confirming);
      else setError(acceptFailure(copy, cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.tickets.inbox}>
      {isLoading ? <Spinner /> : null}
      {!isLoading && rows.length === 0 ? <p className="muted">{copy.tickets.inboxEmpty}</p> : null}
      {rows.length > 0 ? <p>{fmt(copy.tickets.inboxCount, { count: rows.length })}</p> : null}
      {message ? <Alert tone="info">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="event-list">
        {rows.map((row) => (
          <li key={row.offer.inviteId}>
            <span>#{row.offer.tokenId}</span>
            {row.needsKyc ? (
              <>
                <Alert tone="warn">{copy.kyc.offerNeedsKyc}</Alert>
                <Button variant="ghost" onClick={() => navigate('/me/verify?returnTo=/tickets/inbox')}>
                  {copy.kyc.cta}
                </Button>
              </>
            ) : (
              <Button onClick={() => void take(row)} disabled={busy}>
                {copy.transfer.accept}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Screen>
  );
}
