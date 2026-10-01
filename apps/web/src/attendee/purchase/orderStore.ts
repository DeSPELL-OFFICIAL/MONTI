/**
 * A per-device map from a ticket (or its event) to the order that paid for it, kept in
 * `localStorage`. The order id is `claimRelayId(account, eventId, nonce)` — deterministic at
 * purchase time but not recomputable later once the claim nonce has moved on — so the purchase
 * flow remembers it here, and the ticket detail reads it back to show the receipt. It is a
 * convenience cache only: the authority is `orders/{orderId}` on the server, and a cleared store
 * just means the receipt is not shown on this device, never a lost order. Every access is wrapped
 * because storage can throw (private window, blocked site data).
 */

const KEY = 'monti.orders';

interface Store {
  byToken: Record<string, string>;
  byEvent: Record<string, string>;
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { byToken: {}, byEvent: {} };
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { byToken: parsed.byToken ?? {}, byEvent: parsed.byEvent ?? {} };
  } catch {
    return { byToken: {}, byEvent: {} };
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable — the receipt simply will not surface on this device.
  }
}

/** Record that `orderId` bought a ticket for `eventId` (and, once minted, for `tokenId`). */
export function rememberOrder(orderId: string, where: { eventId: string; tokenId?: string }): void {
  const store = read();
  store.byEvent[where.eventId] = orderId;
  if (where.tokenId !== undefined) store.byToken[where.tokenId] = orderId;
  write(store);
}

/** The order id behind a minted ticket, or `null` when this device never recorded it. */
export function orderIdForToken(tokenId: string): string | null {
  return read().byToken[tokenId] ?? null;
}

/** The last order recorded for an event, used before the ticket's own id is known. */
export function orderIdForEvent(eventId: string): string | null {
  return read().byEvent[eventId] ?? null;
}
