import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Fab, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { useMyTickets } from './useTickets';
import { useStateLabel } from './List';

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
  const { data, isLoading, isError, error, refetch } = useMyTickets();
  const ticket = (data ?? []).find((entry) => entry.tokenId === tokenId);

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

  return (
    <Screen title={`#${ticket.tokenId}`}>
      <p>{labels[ticket.state]}</p>
      <p>{copy.tickets.detailGuide}</p>
      <p className="muted">{copy.tickets.noBarcode}</p>
      <p>
        <Link to={`/events/${ticket.eventId}`}>{copy.discover.title}</Link>
      </p>
      {ticket.state === 'before' ? (
        <>
          <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}/transfer`)}>
            {copy.tickets.transfer}
          </Button>
          <Fab label={copy.tickets.enter} onClick={() => navigate(`/tickets/${tokenId}/enter`)} />
        </>
      ) : null}
    </Screen>
  );
}
