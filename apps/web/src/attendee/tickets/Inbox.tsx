import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Hex } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import { LIST_STAGGER, m, useReducedMotion } from '../../shared/motion';
import { api, type PendingOffer } from '../../shared/api/functions';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { ticketOp } from '../../shared/chain/ops';
import { readIdentity, readTicket } from '../../shared/chain/reads';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { useSession } from '../../shared/session';
import { acceptFailure, isStillConfirming } from '../transfer/offers';

// The one screen whose reader has never seen the event, so it is the one that has to name it.
export { acceptPendingOffers, type OrgIdOf } from '../transfer/offers';

export interface InboxRow {
  offer: PendingOffer;
  /** The event's organisation sponsors the operation that collects the ticket. */
  orgId: bigint;
  /** Empty when the document did not load; the row then falls back to the ticket number. */
  title: string;
  /** The event asks for identity verification and this attendee has not done it, so
   *  `acceptOffer` would revert with `KycRequired`. The row offers the check instead. */
  needsKyc: boolean;
}

/**
 * What is waiting, with the one rule that decides whether it can be collected at all. The
 * verification level comes from `Identity` rather than from the signup record: the contract
 * reads the chain, so the gate that predicts it must too. The title comes from the metadata
 * document the same `eventMeta` call already hands over the CID for, memoised per CID for the
 * session — a document that will not load is not a reason to hide the invite.
 */
async function loadInbox(account: Hex): Promise<InboxRow[]> {
  const offers = await api.pendingOffers();
  if (offers.length === 0) return [];
  const ticket = readTicket();
  const kycLevel = await readIdentity().kycLevelOf(account);
  return Promise.all(
    offers.map(async (offer) => {
      const meta = await ticket.eventMeta(await ticket.eventOf(BigInt(offer.tokenId)));
      const metadata = await fetchEventMetadata(meta.imageCid).catch(() => null);
      return {
        offer,
        orgId: meta.orgId,
        title: metadata?.title ?? '',
        needsKyc: meta.requireKyc && kycLevel < 1,
      };
    }),
  );
}

/** One row's own answer. Keyed by invite id so collecting one says nothing about the others. */
type ByRow = Readonly<Record<string, string>>;

function withRow(current: ByRow, inviteId: string, value: string): ByRow {
  return { ...current, [inviteId]: value };
}

export function Inbox() {
  const copy = useCopy();
  const navigate = useNavigate();
  const session = useSession();
  const queryClient = useQueryClient();
  const account = session.account;
  const [busy, setBusy] = useState<ByRow>({});
  const [message, setMessage] = useState<ByRow>({});
  const [error, setError] = useState<ByRow>({});

  const { data, isLoading } = useQuery({
    queryKey: ['pendingOffers', account ?? ''],
    enabled: Boolean(account),
    queryFn: () => loadInbox(account as Hex),
  });
  const rows = data ?? [];
  const reduce = useReducedMotion();
  // Reduced motion drops the stagger so the rows are all there at once (see LIST_STAGGER).
  const list = reduce ? {} : { variants: LIST_STAGGER.container, initial: 'hidden' as const, animate: 'show' as const };
  const item = reduce ? {} : { variants: LIST_STAGGER.item };

  async function take(row: InboxRow): Promise<void> {
    const key = row.offer.inviteId;
    setBusy((current) => withRow(current, key, key));
    setError((current) => withRow(current, key, ''));
    setMessage((current) => withRow(current, key, ''));
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: row.orgId,
        functionName: 'acceptOffer',
        args: [BigInt(row.offer.tokenId), row.offer.attesterSig],
      });
      setMessage((current) => withRow(current, key, copy.transfer.accepted));
      await queryClient.invalidateQueries({ queryKey: ['pendingOffers'] });
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
    } catch (cause) {
      // Still on its way is not a denial: the ticket may well be here in a moment.
      if (isStillConfirming(cause)) {
        setMessage((current) => withRow(current, key, copy.transfer.confirming));
      } else {
        setError((current) => withRow(current, key, acceptFailure(copy, cause)));
      }
    } finally {
      setBusy((current) => withRow(current, key, ''));
    }
  }

  return (
    <Screen title={copy.tickets.inbox}>
      {isLoading ? <Spinner /> : null}
      {!isLoading && rows.length === 0 ? <p className="muted">{copy.tickets.inboxEmpty}</p> : null}
      {rows.length > 0 ? <p>{fmt(copy.tickets.inboxCount, { count: rows.length })}</p> : null}
      <m.ul className="event-list" {...list}>
        {rows.map((row) => {
          const key = row.offer.inviteId;
          return (
            <m.li key={key} {...item}>
              {/* The number is all there is when the document did not load — better than a
                  blank line, and the person can still see which invite is which. */}
              <span>{row.title === '' ? `#${row.offer.tokenId}` : row.title}</span>
              {message[key] ? <Alert tone="info">{message[key]}</Alert> : null}
              {error[key] ? <Alert tone="error">{error[key]}</Alert> : null}
              {row.needsKyc ? (
                <>
                  <Alert tone="warn">{copy.kyc.offerNeedsKyc}</Alert>
                  <Button variant="ghost" onClick={() => navigate('/me/verify?returnTo=/tickets/inbox')}>
                    {copy.kyc.cta}
                  </Button>
                </>
              ) : (
                <Button onClick={() => void take(row)} disabled={busy[key] === key}>
                  {copy.transfer.accept}
                </Button>
              )}
            </m.li>
          );
        })}
      </m.ul>
    </Screen>
  );
}
