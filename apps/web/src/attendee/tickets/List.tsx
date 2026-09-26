import { Link } from 'react-router-dom';
import { Alert, Button, Screen, Skeleton, TicketArt } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { LIST_STAGGER, m, SPRING, useReducedMotion } from '../../shared/motion';
import { useTicketArtProps } from './useTicketArt';
import { useMyTickets } from './useTickets';
import type { TicketState } from './ticketState';

/** The whole row is the tap target, so the row is what presses — as a link, not a button. */
const MotionLink = m.create(Link);

/** How many placeholder rows the loading state shows before the real ones arrive. */
const SKELETON_ROWS = 3;

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
  const reduce = useReducedMotion();
  const tap = reduce ? undefined : { whileTap: { scale: 0.97 }, transition: SPRING.snappy };
  // Reduced motion drops the stagger so the rows are all there at once, rather than dealt in with
  // only the movement stripped out (see LIST_STAGGER).
  const list = reduce ? {} : { variants: LIST_STAGGER.container, initial: 'hidden' as const, animate: 'show' as const };
  const item = reduce ? {} : { variants: LIST_STAGGER.item };

  return (
    <Screen title={copy.tickets.title}>
      {isLoading ? (
        <ul className="event-list" aria-busy="true">
          {Array.from({ length: SKELETON_ROWS }, (_, row) => (
            <li key={row} className="ticket-row">
              <Skeleton width={76} height={120} radius={16} />
              <Skeleton width="55%" height={16} />
            </li>
          ))}
        </ul>
      ) : null}
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
      <m.ul className="event-list" {...list}>
        {tickets.map((ticket) => (
          <m.li key={ticket.tokenId} {...item}>
            <MotionLink className="ticket-row" to={`/tickets/${ticket.tokenId}`} {...tap}>
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
            </MotionLink>
          </m.li>
        ))}
      </m.ul>
    </Screen>
  );
}
