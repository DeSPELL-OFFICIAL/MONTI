import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Fab, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useMyTickets } from './useTickets';
import { useStateLabel } from './List';

export function TicketDetail() {
  const copy = useCopy();
  const labels = useStateLabel();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const { data, isLoading } = useMyTickets();
  const ticket = (data ?? []).find((entry) => entry.tokenId === tokenId);

  if (isLoading) {
    return (
      <Screen title={copy.tickets.title}>
        <Spinner />
      </Screen>
    );
  }
  if (!ticket) {
    return (
      <Screen title={copy.tickets.title}>
        <Alert tone="error">{copy.common.error}</Alert>
        <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.common.back}</Button>
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
