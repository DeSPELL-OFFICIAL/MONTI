import { describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, numberToHex } from 'viem';
import { ticketAbi } from './abis';

const TICKET = `0x${'33'.repeat(20)}` as const;
const CREATOR = `0x${'ab'.repeat(20)}` as const;

// Pinned rather than read from `.env.local`: which contract emitted the log is the whole point
// of the address filter below, and it must not depend on a developer's local addresses.
vi.mock('../config', () => ({
  getConfig: () => ({ addresses: { ticket: TICKET.toUpperCase() } }),
}));

const { createdEventId } = await import('./createdEvent');

/** `EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator)`. */
function created(eventId: bigint, address: `0x${string}` = TICKET) {
  return {
    address,
    topics: [
      encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated' })[0],
      numberToHex(eventId, { size: 32 }),
      numberToHex(9n, { size: 32 }),
      `0x${'00'.repeat(12)}${CREATOR.slice(2)}`,
    ],
    data: '0x',
  } as const;
}

describe('createdEventId', () => {
  /**
   * `createEvent` returns the id, but a sponsored operation hands back a receipt rather than a
   * return value — so the log is the only answer that does not mean waiting for the indexer.
   */
  it('reads the new event id out of the operation\'s own EventCreated log', () => {
    expect(createdEventId([created(12n)])).toBe('12');
  });

  it('finds it among the other logs the same operation emitted', () => {
    const other = {
      address: TICKET,
      topics: [encodeEventTopics({ abi: ticketAbi, eventName: 'EventStatusChanged' })[0], numberToHex(12n, { size: 32 })],
      data: numberToHex(0, { size: 32 }),
    } as const;
    expect(createdEventId([other, created(12n)])).toBe('12');
  });

  /** A `wait` that gave up carries no logs at all. That is a state, not a failure. */
  it('answers with nothing rather than throwing when there is no such log', () => {
    expect(createdEventId([])).toBe('');
    expect(createdEventId([{ address: TICKET, topics: ['0xdeadbeef'], data: '0x' }])).toBe('');
  });

  it('answers with nothing for a log this ABI cannot decode', () => {
    expect(createdEventId([{ address: TICKET, topics: [], data: '0xnothex' }])).toBe('');
  });

  /**
   * `EventCreated`'s topic0 is a signature, not a deployment — any contract may emit a log
   * with it, and a batched operation carries every call's logs together. The address is what
   * says the log is the Ticket contract's, and the compare is case-insensitive because the
   * bundler and the config need not agree on EIP-55.
   */
  it('ignores a matching log emitted by some other contract', () => {
    expect(createdEventId([created(12n, `0x${'99'.repeat(20)}`)])).toBe('');
  });

  it('takes the Ticket contract\'s log from among another contract\'s', () => {
    expect(createdEventId([created(77n, `0x${'99'.repeat(20)}`), created(12n)])).toBe('12');
  });

  it('compares the address without caring about its casing', () => {
    expect(createdEventId([created(12n, TICKET.toUpperCase() as `0x${string}`)])).toBe('12');
  });
});
