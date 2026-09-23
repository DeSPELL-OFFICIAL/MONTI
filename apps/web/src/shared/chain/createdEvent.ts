import { parseEventLogs, type Log } from 'viem';
import { getConfig } from '../config';
import { ticketAbi } from './abis';
import type { SponsoredOpLog } from './sendSponsoredOp';

/**
 * The id of the event a `createEvent` operation just made, read out of its own `EventCreated`
 * log, or `''` when the operation's logs do not carry one.
 *
 * `Ticket.createEvent` returns the id, but a sponsored operation hands back a receipt rather
 * than a return value, so the log is the only immediate answer — the indexer has it a moment
 * later, which is a moment too late for the screen that is about to navigate. The logs read
 * here are the operation's own (`eth_getUserOperationReceipt.logs`), not the bundle's, so a
 * neighbouring operation's `EventCreated` cannot be mistaken for this one's.
 *
 * `''` is a real answer and not an error: a `wait` that gave up has no logs at all, and the
 * organiser is then offered the event number by hand instead.
 */
export function createdEventId(logs: readonly SponsoredOpLog[]): string {
  if (logs.length === 0) return '';
  try {
    // Only the Ticket contract's own logs. `EventCreated`'s signature is not unique to this
    // deployment — any contract may emit a log with the same topic0 — and a batched operation
    // carries every call's logs together, so the address is what says this one is ours.
    const ticket = getConfig().addresses.ticket.toLowerCase();
    const mine = logs.filter((log) => log.address?.toLowerCase() === ticket);
    if (mine.length === 0) return '';

    const [created] = parseEventLogs({
      abi: ticketAbi,
      eventName: 'EventCreated',
      // The bundler sends the three fields a decode needs; the block and index fields viem's
      // `Log` also carries are irrelevant here and are not invented.
      logs: mine as unknown as Log[],
    });
    const eventId = (created as { args?: { eventId?: bigint } } | undefined)?.args?.eventId;
    return typeof eventId === 'bigint' ? eventId.toString() : '';
  } catch {
    // A log this ABI cannot decode is not a failure to publish. The manual field still works.
    return '';
  }
}
