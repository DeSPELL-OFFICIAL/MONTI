/** The five badges spec §3.1 puts on a ticket, in the order they take precedence. */
export type TicketState = 'before' | 'entered' | 'pendingOffer' | 'transferred' | 'cancelled';

export interface TicketStateInput {
  /** False once the token has moved on: the index shows another address holding it. */
  ownerIsMe: boolean;
  /** Ticket.Revoked — the organiser voided this one ticket. */
  revoked: boolean;
  /** EventStatusChanged put the whole event on Cancelled. Optional: a caller that has not read
   *  the event row leaves it out and the ticket keeps its own state. */
  eventCancelled?: boolean;
  /** The append-only check-in record. Its presence is what "used" means on chain. */
  checkIn: { ts: number } | null;
  /** The handover offer this ticket carries, whatever its status. */
  offer: { expiresAt: number; status: string } | null;
  /** Seconds since the epoch, so an expired offer stops holding the ticket. */
  now: number;
}

/** An offer that is still waiting for its recipient. Cancelled and accepted ones are history. */
const OFFER_OPEN = 'open';

/**
 * One ticket, one word. Order matters: a voided ticket is voided whatever else happened to it,
 * a ticket that left my hands cannot be entered, and a spent ticket cannot be handed over.
 */
export function deriveTicketState(input: TicketStateInput): TicketState {
  if (input.revoked || input.eventCancelled) return 'cancelled';
  if (!input.ownerIsMe) return 'transferred';
  if (input.checkIn) return 'entered';
  if (input.offer && input.offer.status === OFFER_OPEN && input.offer.expiresAt > input.now) return 'pendingOffer';
  return 'before';
}
