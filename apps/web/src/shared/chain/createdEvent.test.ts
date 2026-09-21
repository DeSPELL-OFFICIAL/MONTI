import { describe, expect, it } from 'vitest';
import { encodeEventTopics, numberToHex } from 'viem';
import { ticketAbi } from './abis';
import { createdEventId } from './createdEvent';

const TICKET = `0x${'33'.repeat(20)}` as const;
const CREATOR = `0x${'ab'.repeat(20)}` as const;

/** `EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator)`. */
function created(eventId: bigint) {
  return {
    address: TICKET,
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
});
