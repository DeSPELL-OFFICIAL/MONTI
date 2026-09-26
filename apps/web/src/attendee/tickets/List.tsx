import { Link } from 'react-router-dom';
import { Alert, Button, Screen, Spinner, TicketArt } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { useTicketArtProps } from './useTicketArt';
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
  const { data, isLoading, isError, error, refetch } = useMyTickets();
  const tickets = data ?? [];
  const artPropsOf = useTicketArtProps(tickets);

  return (
    <Screen title={copy.tickets.title}>
      {isLoading ? <Spinner /> : null}
      {isError ? (
        <>
          <Alert tone="error">{describeFailure(error, copy)}</Alert>
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
            <Link className="ticket-row" to={`/tickets/${ticket.tokenId}`}>
              {/* Hidden from the accessible name on purpose. Everything the picture says out
                  loud — the event, the kind, and 사용됨 across a spent ticket — is either
                  already the line beside it or is the state word in that line, so leaving it
                  in would make every row read itself out twice. It is the row's picture, and
                  the picture is the part of a ticket a screen reader has no use for. */}
              <span className="ticket-row__art" aria-hidden="true">
                <TicketArt {...artPropsOf(ticket)} />
              </span>
              {/* The number and the state, and deliberately nothing else: the event's own
                  name is printed inside the picture beside this, and adding it here would
                  make the row's accessible name read the event out twice. */}
              <span className="ticket-row__text">
                #{ticket.tokenId} · {labels[ticket.state]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
