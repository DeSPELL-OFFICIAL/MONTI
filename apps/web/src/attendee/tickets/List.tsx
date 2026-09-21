import { Link } from 'react-router-dom';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useMyTickets } from './useTickets';
import type { TicketState } from './ticketState';

/** The one place a derived state turns into a word, shared with the detail screen. */
export function useStateLabel(): Record<TicketState, string> {
  const copy = useCopy();
  return {
    before: copy.tickets.stateBefore,
    entered: copy.tickets.stateEntered,
    pendingOffer: copy.tickets.statePending,
    transferred: copy.tickets.stateTransferred,
    cancelled: copy.tickets.stateCancelled,
  };
}

export function TicketList() {
  const copy = useCopy();
  const labels = useStateLabel();
  const { data, isLoading, isError, refetch } = useMyTickets();
  const tickets = data ?? [];

  return (
    <Screen title={copy.tickets.title}>
      {isLoading ? <Spinner /> : null}
      {isError ? (
        <>
          <Alert tone="error">{copy.common.error}</Alert>
          <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
        </>
      ) : null}
      <p>
        <Link to="/tickets/inbox">{copy.tickets.inbox}</Link>
      </p>
      {!isLoading && !isError && tickets.length === 0 ? <p className="muted">{copy.tickets.empty}</p> : null}
      <ul className="event-list">
        {tickets.map((ticket) => (
          <li key={ticket.tokenId}>
            <Link to={`/tickets/${ticket.tokenId}`}>
              #{ticket.tokenId} · {labels[ticket.state]}
            </Link>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
