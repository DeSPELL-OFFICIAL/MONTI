import { encodeAbiParameters, keccak256, numberToHex, toEventSelector, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TICKET = `0x${'33'.repeat(20)}` as const;

vi.mock('../../shared/config', () => ({
  getConfig: () => ({ chainId: 10143, addresses: { ticket: TICKET } }),
}));

const stopLogs = vi.fn();
const subscribeLogs = vi.fn();
vi.mock('../../shared/chain/subscribeLogs', () => ({ subscribeLogs }));

const checkInOf = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ checkInOf }) }));

import type { Verdict, WatchFactory } from './machine';

const { checkedInTopics, nonceHashOf, watchCheckedIn } = await import('./verdict');
const { createGateMachine } = await import('./machine');

const NONCE = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_NONCE = `0x${'cd'.repeat(32)}` as Hex;
const TOKEN_ID = 7n;
const TOKEN_TOPIC = numberToHex(TOKEN_ID, { size: 32 });
/** The tap the watch is opened for — exactly the `TapId` the machine holds. */
const TAP = { tokenId: TOKEN_ID, nonce: NONCE };

const CHECKED_IN = toEventSelector('CheckedIn(uint256,uint256,uint256,bytes32,uint64)');
/** 01b's own signature, so a log of the shape the redeploy adds can be fed in today. */
const CHECKED_IN_LATE = toEventSelector('CheckedInLate(uint256,uint256,uint64,uint64)');

const ZERO_CHECK_IN = { gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}` as Hex, manual: false };

/** A `CheckedIn` exactly as `monadLogs` reports it: quantities as hex strings, not bigints. */
function checkedInLog(nonceHash: Hex, over: Record<string, unknown> = {}) {
  return {
    address: TICKET,
    topics: [CHECKED_IN, TOKEN_TOPIC, numberToHex(42n, { size: 32 }), numberToHex(3n, { size: 32 })],
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [nonceHash, 1_790_000_000n]),
    blockNumber: '0x63',
    stage: 'speculative',
    ...over,
  };
}

/** The `onLog` the subscription handed to `subscribeLogs`. */
function feed(log: unknown): void {
  (subscribeLogs.mock.calls[0]?.[0] as { onLog: (l: unknown) => void }).onLog(log);
}

/** Lets the one-shot `checkInOf` promise chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stopLogs.mockReset();
  subscribeLogs.mockReset().mockReturnValue(stopLogs);
  checkInOf.mockReset().mockResolvedValue(ZERO_CHECK_IN);
});

describe('nonceHashOf', () => {
  /**
   * `Ticket.sol:360` — `bytes32 nonceHash = keccak256(abi.encode(g.nonce))`. For a `bytes32`
   * `abi.encode` is the 32 bytes themselves, so both spellings are the same value; both are
   * pinned because getting this wrong is a gate that never turns green for anyone.
   */
  it('is keccak256 of the nonce, which is what the contract writes', () => {
    expect(nonceHashOf(NONCE)).toBe(keccak256(NONCE));
    expect(nonceHashOf(NONCE)).toBe(keccak256(encodeAbiParameters([{ type: 'bytes32' }], [NONCE])));
    expect(nonceHashOf(NONCE)).not.toBe(nonceHashOf(OTHER_NONCE));
  });

  it('refuses a nonce that is not 32 bytes rather than hashing a shorter string', () => {
    expect(() => nonceHashOf(`0x${'ab'.repeat(16)}` as Hex)).toThrow('BAD_NONCE');
  });
});

describe('checkedInTopics', () => {
  it('filters on the CheckedIn signature and this ticket in topic 1', () => {
    const [signatures, token] = checkedInTopics(TOKEN_ID) ?? [];
    expect(signatures).toEqual([CHECKED_IN]);
    expect(token).toBe(TOKEN_TOPIC);
  });

  /**
   * The pending-event guard from the consumer's side. `CheckedInLate` is declared in
   * `USED_EVENTS` and listed in `PENDING_EVENTS`, so the filter carries one signature today
   * and two the day the 01b ABI lands — with nothing in this file changing.
   */
  it('carries one signature while CheckedInLate is still pending', () => {
    const [signatures] = checkedInTopics(TOKEN_ID) ?? [];
    expect(signatures).toHaveLength(1);
    expect(signatures).not.toContain(CHECKED_IN_LATE);
  });
});

describe('the chain verdict', () => {
  /** The machine hands this function into its `watch` slot and owns the handle it gets back.
   *  A drift in either signature is a type error here rather than a gate that never listens. */
  it('is the WatchFactory the machine holds', () => {
    const factory: WatchFactory = watchCheckedIn;
    expect(factory).toBe(watchCheckedIn);
  });

  it('subscribes to the Ticket contract for this ticket alone', () => {
    watchCheckedIn(TAP, () => {});
    const args = subscribeLogs.mock.calls[0]?.[0] as { address: Hex; topics: unknown[] };
    expect(args.address).toBe(TICKET);
    expect(args.topics).toEqual([[CHECKED_IN], TOKEN_TOPIC]);
  });

  it('turns a speculative log into an unfinalized admit and the finalized repeat into a final one', () => {
    const seen: Array<[string, boolean | undefined, Hex]> = [];
    watchCheckedIn(TAP, (verdict) =>
        seen.push([verdict.kind, verdict.kind === 'admit' ? verdict.finalized : undefined, verdict.nonce]));
    feed(checkedInLog(nonceHashOf(NONCE)));
    feed(checkedInLog(nonceHashOf(NONCE), { stage: 'finalized' }));
    // The verdict names the tap by its nonce, not by the hash: that is the identity the machine
    // matches on, and the chain-side hash is derivable from it.
    expect(seen).toEqual([
      ['admit', false, NONCE],
      ['admit', true, NONCE],
    ]);
  });

  /**
   * The reason the match is on the nonce and never on the ticket. Two taps of the same ticket
   * inside one code window produce two `CheckedIn` topic-1 matches; letting either confirm the
   * other is a gate that turns green for a check-in that is not the one in front of it.
   */
  it('ignores a CheckedIn for this ticket that answers a different code', () => {
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    feed(checkedInLog(nonceHashOf(OTHER_NONCE)));
    expect(onVerdict).not.toHaveBeenCalled();
  });

  /** A manual override writes `bytes32(0)` (`Ticket.sol:420`) — it answers no code at all. */
  it('ignores a manual check-in, whose nonceHash is zero', () => {
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    feed(checkedInLog(`0x${'00'.repeat(32)}` as Hex));
    expect(onVerdict).not.toHaveBeenCalled();
  });

  /**
   * 01b's `CheckedInLate` carries no `nonceHash`, so it can never name a tap. It is in the
   * filter because it is emitted *alongside* `CheckedIn`, which does carry one — and decoding
   * its `(uint64,uint64)` body as a hash must not be mistaken for a match.
   */
  it('never admits on a CheckedInLate, which carries no nonceHash', () => {
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    feed({
      topics: [CHECKED_IN_LATE, TOKEN_TOPIC, numberToHex(3n, { size: 32 })],
      data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint64' }], [1_790_000_000n, 1_790_000_100n]),
      blockNumber: '0x63',
      stage: 'finalized',
    });
    expect(onVerdict).not.toHaveBeenCalled();
  });

  /**
   * `subscribeLogs` forwards the raw JSON-RPC object, where `blockNumber` is a quantity hex
   * string — viem's formatter never runs on it. The staff screen prints this number.
   */
  it('reads the block number whether it arrives as a hex quantity or a bigint', () => {
    const blocks: Array<bigint | undefined> = [];
    watchCheckedIn(TAP, (verdict) => blocks.push(verdict.kind === 'admit' ? verdict.blockNumber : undefined));
    feed(checkedInLog(nonceHashOf(NONCE)));
    feed(checkedInLog(nonceHashOf(NONCE), { blockNumber: 100n }));
    feed(checkedInLog(nonceHashOf(NONCE), { blockNumber: null }));
    expect(blocks).toEqual([99n, 100n, undefined]);
  });

  it('stops the log subscription and answers nothing more once it is stopped', () => {
    const onVerdict = vi.fn();
    const stop = watchCheckedIn(TAP, onVerdict);
    stop();
    expect(stopLogs).toHaveBeenCalledTimes(1);
    feed(checkedInLog(nonceHashOf(NONCE)));
    expect(onVerdict).not.toHaveBeenCalled();
  });
});

describe('the one-shot checkInOf read, for a subscription that opened late', () => {
  it('reads this ticket exactly once when the watch opens', async () => {
    watchCheckedIn(TAP, () => {});
    await flush();
    expect(checkInOf).toHaveBeenCalledTimes(1);
    expect(checkInOf).toHaveBeenCalledWith(TOKEN_ID);
  });

  /**
   * The log already went past before the socket was open. A check-in sitting in storage is a
   * recorded fact rather than something on its way, so it lands settled — and with no block
   * number, because a storage read cannot name the block it happened in.
   */
  it('admits from storage when the stored check-in answers this code', async () => {
    checkInOf.mockResolvedValue({ gateId: 3n, ts: 1_790_000_000n, nonceHash: nonceHashOf(NONCE), manual: false });
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    await flush();
    expect(onVerdict).toHaveBeenCalledWith({
      kind: 'admit', nonce: NONCE, blockNumber: undefined, finalized: true,
    });
  });

  /** `AlreadyCheckedIn` territory: the ticket was used, but not by the tap in front of us. */
  it('does not admit a stored check-in that answers someone else’s code', async () => {
    checkInOf.mockResolvedValue({
      gateId: 3n, ts: 1_790_000_000n, nonceHash: nonceHashOf(OTHER_NONCE), manual: false,
    });
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    await flush();
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it('does not admit the zero struct an unchecked ticket reads back as', async () => {
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict);
    await flush();
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it('swallows a failed read — the gate is offline, not refused', async () => {
    checkInOf.mockRejectedValue(new Error('ECONNREFUSED'));
    const onVerdict = vi.fn();
    expect(() => watchCheckedIn(TAP, onVerdict)).not.toThrow();
    await flush();
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it('says nothing once the watch has been stopped, even if the read was already in flight', async () => {
    checkInOf.mockResolvedValue({ gateId: 3n, ts: 1_790_000_000n, nonceHash: nonceHashOf(NONCE), manual: false });
    const onVerdict = vi.fn();
    watchCheckedIn(TAP, onVerdict)();
    await flush();
    expect(onVerdict).not.toHaveBeenCalled();
  });
});

describe('what the verdict does to the gate machine (Task 23)', () => {
  /**
   * Spec §7.3 and Task 21 ruling 3: a `'TIMEOUT'` receipt means `wait()` stopped watching, not
   * that the operation died. The machine stays in `confirming` and this log — arriving after
   * the re-tap hint is already up — is still what turns the tap green.
   */
  it('turns a machine that already timed out green', () => {
    const machine = createGateMachine({ gateId: 3n, eventId: 42n, orgId: 1n });
    machine.onReady();
    machine.onResponse(TAP);
    machine.onSent({ ...TAP, userOpHash: `0x${'fe'.repeat(32)}` });
    machine.onTimeout(NONCE);
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().retapHint).toBe(true);

    watchCheckedIn(TAP, (verdict) => machine.onVerdict(verdict));
    feed(checkedInLog(nonceHashOf(NONCE), { stage: 'finalized' }));

    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(true);
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('hands over a Verdict the machine already accepts, unchanged', () => {
    const verdicts: Verdict[] = [];
    watchCheckedIn(TAP, (verdict) => verdicts.push(verdict));
    feed(checkedInLog(nonceHashOf(NONCE)));
    expect(verdicts).toEqual([{ kind: 'admit', nonce: NONCE, blockNumber: 99n, finalized: false }]);
  });
});

/**
 * Two sources answer this watch and they can land in either order: the storage read resolves in
 * one round trip while the subscription's first log is still `speculative`. Task 24 review V4 —
 * the read cannot be skipped, so it must at least not undo what the log already said.
 */
describe('the two sources never step backwards', () => {
  it('does not take a finalized admit back to speculative', async () => {
    checkInOf.mockResolvedValue({ gateId: 3n, ts: 1_790_000_000n, nonceHash: nonceHashOf(NONCE), manual: false });
    const seen: boolean[] = [];
    watchCheckedIn(TAP, (verdict) => {
      if (verdict.kind === 'admit') seen.push(verdict.finalized);
    });
    await flush();
    // The storage read has answered `finalized`; the subscription's speculative log is late.
    feed(checkedInLog(nonceHashOf(NONCE)));
    expect(seen).toEqual([true]);
  });

  it('still upgrades speculative to finalized, which is the direction that matters', () => {
    const seen: boolean[] = [];
    watchCheckedIn(TAP, (verdict) => {
      if (verdict.kind === 'admit') seen.push(verdict.finalized);
    });
    feed(checkedInLog(nonceHashOf(NONCE)));
    feed(checkedInLog(nonceHashOf(NONCE), { stage: 'finalized' }));
    feed(checkedInLog(nonceHashOf(NONCE)));
    expect(seen).toEqual([false, true]);
  });
});
