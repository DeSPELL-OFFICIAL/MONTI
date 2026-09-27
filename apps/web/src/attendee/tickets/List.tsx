import { Link } from 'react-router-dom';
import { Alert, Button, Screen, Skeleton, TicketArt } from '../../shared/ui';
import { useCopy, useLocale } from '../../shared/i18n';
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
  const locale = useLocale();
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
              <Skeleton width={56} height={90} radius={12} />
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
        {tickets.map((ticket) => {
          // The event's own name leads the row now, its day sits under it, and the state rides a
          // chip on the right (visual R1-2). The day is formatted the same way the picture prints
          // it, and a ticket the index gave no start time carries no date line rather than a 1970.
          const day = ticket.startsAt > 0
            ? new Date(ticket.startsAt * 1000).toLocaleDateString(locale, { dateStyle: 'medium' })
            : '';
          return (
            <m.li key={ticket.tokenId} {...item}>
              <MotionLink className="ticket-row" to={`/tickets/${ticket.tokenId}`} {...tap}>
                {/* The picture is hidden from the accessible name: the event, the day and the
                    state it prints are the lines beside it now, so leaving it in the name would
                    read each of them out twice. */}
                <span className="ticket-row__art" aria-hidden="true">
                  <TicketArt {...artPropsOf(ticket)} />
                </span>
                <span className="ticket-row__body">
                  <span className="ticket-row__title">
                    {ticket.title === '' ? copy.tickets.artNoTitle : ticket.title}
                  </span>
                  {day === '' ? null : <span className="ticket-row__date muted">{day}</span>}
                </span>
                <span className="ticket-row__state chip chip--tiny">{labels[ticket.state]}</span>
              </MotionLink>
            </m.li>
          );
        })}
      </m.ul>
    </Screen>
  );
}
