import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { watchOrder, type OrderView } from '../../shared/api/firestore';
import { orderIdForEvent, orderIdForToken } from '../purchase/orderStore';
import { useStateLabel } from './List';
import { deriveDetailView } from './ticketState';
import { useTicketDetail } from './useTicketDetail';

type OrderStatus = OrderView['status'] | null;

/**
 * The status of the paid order behind a ticket, read the way the receipt reads it (the order id
 * this device remembered). `settled` is false only while a remembered order's first answer is
 * still on its way; a free ticket (no order) settles at once with `null`.
 */
function useOrderStatus(tokenId: string, eventId: string | undefined): { status: OrderStatus; settled: boolean } {
  const orderId = eventId === undefined ? null : (orderIdForToken(tokenId) ?? orderIdForEvent(eventId));
  const [answer, setAnswer] = useState<{ orderId: string; status: OrderStatus } | null>(null);

  useEffect(() => {
    if (orderId === null) return undefined;
    return watchOrder(
      orderId,
      (order) => setAnswer({ orderId, status: order?.status ?? null }),
      // An order that cannot be read says nothing about the ticket; the door decides then.
      () => setAnswer({ orderId, status: null }),
    );
  }, [orderId]);

  if (orderId === null) return { status: null, settled: eventId !== undefined };
  return answer?.orderId === orderId ? { status: answer.status, settled: true } : { status: null, settled: false };
}

/**
 * The ticket detail takes 입장하기 and 친구에게 주기 away from a ticket that can no longer use
 * them (refunded, used, cancelled, handed over — `deriveDetailView`). The routes behind those
 * buttons are reachable on their own (a deep link, the back button, a bookmark), so they ask the
 * same question here before rendering the step, and answer with the same sentence the detail
 * shows plus the way back to the ticket.
 *
 * Only a *known* no closes the door: a ticket the indexer and the chain cannot produce right now
 * falls through to the step, whose own check (the gate, the backend) still refuses a dead ticket.
 */
export function TicketGate({ need, children }: { need: 'enter' | 'transfer'; children: ReactNode }) {
  const copy = useCopy();
  const labels = useStateLabel();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const { ticket, isLoading } = useTicketDetail(tokenId);
  const order = useOrderStatus(tokenId, ticket?.eventId);

  if (isLoading || (ticket !== undefined && !order.settled)) {
    return (
      <Screen title={copy.tickets.title}>
        <Spinner />
      </Screen>
    );
  }
  if (ticket === undefined) return <>{children}</>;

  const view = deriveDetailView(ticket.state, order.status);
  if (need === 'enter' ? view.canEnter : view.canTransfer) return <>{children}</>;

  const sentence = view.refunded ? copy.tickets.refundedState : view.entered ? labels.entered : labels[ticket.state];
  return (
    <Screen title={copy.tickets.title}>
      <p>{sentence}</p>
      <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}`)}>
        {copy.tickets.backToTicket}
      </Button>
    </Screen>
  );
}
