import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Screen, Spinner, StickyBar, TicketArt } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { useTicketArtProps } from './useTicketArt';
import { useTicketDetail } from './useTicketDetail';
import { useStateLabel } from './List';
import { deriveDetailView, splitTicketNumber } from './ticketState';
import { Receipt } from '../purchase/Receipt';

/**
 * A12 — one ticket, its state, and the way in.
 *
 * The failed read and the missing ticket are two different answers and are kept apart: the
 * list this screen reads from is the indexer's, so an indexer that will not answer used to
 * render here as "there is no such ticket" — a person who owns the ticket being told they do
 * not. `isError` is the only thing that tells the two apart, so it is asked for by name.
 */
export function TicketDetail() {
  const copy = useCopy();
  const labels = useStateLabel();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  // The indexer's list first; when it has settled without this ticket (a just-minted deep link
  // and a frozen indexer), the one ticket is read from the chain so the receipt and refund below
  // still mount. `isError`/`!ticket` keep "could not read" and "no such ticket" apart as before.
  const { ticket, isLoading, isError, error, refetch } = useTicketDetail(tokenId);
  // Before the three branches below, because a hook cannot be called after a return — and for
  // this one ticket only, so a deep link into a ticket does not read every event's picture.
  const artPropsOf = useTicketArtProps(ticket ? [ticket] : []);
  // A refund lives on the order the receipt below watches, not on the ticket; it reports it up.
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const [numberCopied, setNumberCopied] = useState(false);

  async function copyNumber(): Promise<void> {
    try {
      await navigator.clipboard.writeText(tokenId);
      setNumberCopied(true);
    } catch {
      // No clipboard on this device: the number is on screen to read out.
    }
  }

  if (isLoading) {
    return (
      <Screen title={copy.tickets.title}>
        <Spinner />
      </Screen>
    );
  }
  // The list never arrived, so nothing can be said about this ticket yet — least of all that
  // it does not exist. The retry is the point of this branch.
  if (isError) {
    return (
      <Screen title={copy.tickets.title}>
        <Alert tone="error">{describeFailure(error, copy)}</Alert>
        <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
        <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
      </Screen>
    );
  }
  // The list arrived and this id is not in it. The way out says where it goes.
  if (!ticket) {
    return (
      <Screen title={copy.tickets.title}>
        <Alert tone="error">{copy.common.error}</Alert>
        <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
      </Screen>
    );
  }

  const props = artPropsOf(ticket);
  // 입장 전 ticket waits at the door: the state word rides in the sticky bar so it reads
  // "입장 전 → [입장하기]", the way in is the bar's one primary action, and 친구에게 주기 sits
  // below the card as the quieter choice (visual R1-1). Every other state keeps the state word
  // in the body, where there is no bar.
  // A refunded order takes both away and says why (deriveDetailView).
  const { canEnter, canTransfer, refunded } = deriveDetailView(ticket.state, orderStatus);
  const number = splitTicketNumber(tokenId);
  return (
    <Screen title={props.titleLoading ? copy.tickets.title : props.title}>
      <div className="ticket-detail-art">
        <TicketArt {...props} animated />
      </div>
      {/* The number staff search by in manual approval; they read back the last four digits. */}
      <p className="ticket-number">
        {copy.tickets.ticketNumber}{' '}
        <span className="ticket-number__digits">
          {number.head}
          <strong>{number.tail}</strong>
        </span>{' '}
        <button type="button" className="ticket-number__copy" onClick={() => void copyNumber()}>
          {numberCopied ? copy.tickets.numberCopied : copy.tickets.copyNumber}
        </button>
      </p>
      {refunded ? <p>{copy.tickets.refundedState}</p> : canEnter ? null : <p>{labels[ticket.state]}</p>}
      {refunded ? null : <p>{copy.tickets.detailGuide}</p>}
      <p className="muted">{copy.tickets.noBarcode}</p>
      {canTransfer ? (
        <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}/transfer`)}>
          {copy.tickets.transfer}
        </Button>
      ) : null}
      <p>
        <Link to={`/events/${ticket.eventId}`}>{copy.discover.title}</Link>
      </p>
      {/* The receipt for a paid ticket (Batch F): amount, status, by-role split and — before the
          event — a refund. Renders nothing for a free ticket (no order recorded on this device). */}
      <Receipt
        tokenId={tokenId}
        eventId={ticket.eventId}
        canRefund={ticket.state === 'before'}
        onStatus={setOrderStatus}
      />
      {canEnter ? (
        <StickyBar status={<span>{labels[ticket.state]}</span>}>
          <Button onClick={() => navigate(`/tickets/${tokenId}/enter`)}>{copy.tickets.enter}</Button>
        </StickyBar>
      ) : null}
    </Screen>
  );
}
