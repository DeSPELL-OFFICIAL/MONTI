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

/** What the ticket detail screen offers. */
export interface DetailView {
  canEnter: boolean;
  canTransfer: boolean;
  /** The paid order behind this ticket was refunded: it can no longer get anyone in. */
  refunded: boolean;
  /** The ticket has been used to get in — by its own check-in record, or by its order's release. */
  entered: boolean;
}

/**
 * The ticket's own state says whether it is still waiting at the door, but a refund lives on the
 * order (`orders/{orderId}.status`), not on the ticket — so a refunded ticket still reads `before`
 * and would keep offering 입장하기 and 친구에게 주기. The order status, when there is one, has the
 * last word. `null` is a free ticket or an order not read yet.
 *
 * Likewise a `released` order means the ticket was admitted (the escrow pays out on check-in) even
 * while the indexer has not caught up with the check-in record — so it reads 입장 완료, with no door
 * guide and no 입장하기. A used ticket cannot be handed over either: `createOffer` reverts
 * `AlreadyCheckedIn` (Ticket.sol), so 친구에게 주기 goes too.
 */
export function deriveDetailView(state: TicketState, orderStatus: string | null): DetailView {
  const refunded = orderStatus === 'refunded';
  const entered = !refunded && (state === 'entered' || (state === 'before' && orderStatus === 'released'));
  const waiting = state === 'before' && !refunded && !entered;
  return { canEnter: waiting, canTransfer: waiting, refunded, entered };
}

/** How many trailing digits the gate staff match a ticket by in manual approval. */
const TICKET_NUMBER_TAIL = 4;

/**
 * The ticket number split for display: the last four digits set apart, since that is what staff
 * read back at the door. Pure string work — the id is a 31-digit number that a JS `number` would
 * round, so it is never parsed.
 */
export function splitTicketNumber(tokenId: string): { head: string; tail: string } {
  const cut = Math.max(0, tokenId.length - TICKET_NUMBER_TAIL);
  return { head: tokenId.slice(0, cut), tail: tokenId.slice(cut) };
}
