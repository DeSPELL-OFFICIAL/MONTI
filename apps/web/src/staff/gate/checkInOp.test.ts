import { decodeFunctionData, type AbiFunction } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ticketAbi, type GateCodeWire, type GateResponseWire } from '@monti/shared';

const TICKET = `0x${'33'.repeat(20)}` as const;
const GATE_ACCOUNT = `0x${'aa'.repeat(20)}` as const;

vi.mock('../../shared/config', () => ({
  getConfig: () => ({
    chainId: 10143,
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: TICKET, paymaster: `0x${'44'.repeat(20)}` },
  }),
}));

const sendSponsoredOp = vi.fn(async () => ({
  userOpHash: '0xfeed' as const,
  wait: async () => ({ success: true, blockNumber: 1n, txHash: '0xabc' as const }),
}));
/** Only the send is replaced: `MIN_VERIFICATION_GAS` below is the real constant, so a test
 *  asserting the gate's floor equals it cannot pass against a stub. */
vi.mock('../../shared/chain/sendSponsoredOp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/chain/sendSponsoredOp')>()),
  sendSponsoredOp,
}));

const getGateSmartAccount = vi.fn(async () => ({ address: GATE_ACCOUNT }));
vi.mock('../../shared/chain/gateAccount', () => ({ getGateSmartAccount }));

const { CHECK_IN_GAS_FLOORS, GateNotRegisteredError, encodeCheckInCall, sendCheckIn } = await import(
  './checkInOp'
);
const { MIN_VERIFICATION_GAS } = await import('../../shared/chain/sendSponsoredOp');

const NONCE = `0x${'11'.repeat(32)}` as const;

const code: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '42',
  issuedAt: 1_700_000_000,
  nonce: NONCE,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};

const response: GateResponseWire = {
  v: 2,
  tokenId: '123',
  nonce: NONCE,
  deviceSig: `0x${'22'.repeat(32)}${'33'.repeat(32)}`,
};

beforeEach(() => {
  sendSponsoredOp.mockClear();
  getGateSmartAccount.mockClear();
});

/** The request `sendSponsoredOp` was handed, typed the way this module builds it. */
function request(): {
  orgId: bigint;
  account: { address: string };
  calls: Array<{ to: string; data: string }>;
  gasFloors?: { callGasLimit?: bigint; verificationGasLimit?: bigint; preVerificationGas?: bigint };
} {
  return (sendSponsoredOp.mock.calls[0] as unknown[] | undefined)?.[0] as never;
}

describe('encoding the call', () => {
  it('is checkIn(tokenId, GateCode, deviceSig) with the struct field order from the ABI', () => {
    const { functionName, args } = decodeFunctionData({
      abi: ticketAbi,
      data: encodeCheckInCall({ code, response }),
    });
    expect(functionName).toBe('checkIn');
    expect(args?.[0]).toBe(123n);
    expect(args?.[1]).toEqual({ gateId: 7n, eventId: 42n, issuedAt: 1_700_000_000n, nonce: NONCE });
    expect(args?.[2]).toBe(response.deviceSig);
  });

  /**
   * The chain recomputes the digest from these exact five values, so the struct's declared order
   * in `Ticket.json` is the contract. A field reordered upstream would silently re-hash and every
   * check-in would revert `BadDeviceSignature`.
   */
  it('keeps the four GateCode fields in the order the generated ABI declares', () => {
    const entry = ticketAbi.find(
      (item): item is AbiFunction => item.type === 'function' && item.name === 'checkIn',
    );
    const struct = entry?.inputs[1] as { components?: Array<{ name?: string }> };
    expect(struct.components?.map((component) => component.name)).toEqual([
      'gateId',
      'eventId',
      'issuedAt',
      'nonce',
    ]);
  });

  it('takes the function name as a parameter so checkInLate slots in after the 01b redeploy', () => {
    // `checkIn` is what `USED_ABI` declares today; the type admits `checkInLate` the moment the
    // redeploy adds it, and nothing else in this module has to change.
    expect(encodeCheckInCall({ code, response, functionName: 'checkIn' })).toBe(
      encodeCheckInCall({ code, response }),
    );
  });

  it('refuses to build a call from a code and an answer that are not a pair', () => {
    expect(() =>
      encodeCheckInCall({ code, response: { ...response, nonce: `0x${'ee'.repeat(32)}` } }),
    ).toThrow('CHECK_IN_CODE_MISMATCH');
  });
});

describe('sending it', () => {
  it('sends from the gate account, to Ticket, with the event org as sponsor', async () => {
    await sendCheckIn({ code, response, orgId: 5n });

    const sent = request();
    expect(getGateSmartAccount).toHaveBeenCalledTimes(1);
    expect(sent.account.address).toBe(GATE_ACCOUNT);
    expect(sent.orgId).toBe(5n);
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]?.to.toLowerCase()).toBe(TICKET.toLowerCase());
    expect(sent.calls[0]?.data).toBe(encodeCheckInCall({ code, response }));
  });

  /**
   * Monad bills the limit rather than the usage, so these are the measured numbers with the one
   * shortfall the estimate cannot see, and nothing more. 01b measured `checkIn` at 123,800 and
   * `checkInLate` at 132,607.
   */
  it('passes the two gas floors and leaves preVerificationGas to the bundler', async () => {
    await sendCheckIn({ code, response, orgId: 5n });

    expect(request().gasFloors).toEqual({ callGasLimit: 200_000n, verificationGasLimit: 150_000n });
    expect(CHECK_IN_GAS_FLOORS.callGasLimit).toBe(200_000n);
    expect(CHECK_IN_GAS_FLOORS.verificationGasLimit).toBe(MIN_VERIFICATION_GAS);
    expect(CHECK_IN_GAS_FLOORS.preVerificationGas).toBeUndefined();
  });

  it('returns the handle without waiting — the verdict is the CheckedIn event', async () => {
    const handle = await sendCheckIn({ code, response, orgId: 5n });
    expect(handle.userOpHash).toBe('0xfeed');
    // Nothing in this module waits: a `wait()` that times out is "still confirming" (Task 23),
    // and a module that awaited here could only report it as a failure.
    expect(typeof handle.wait).toBe('function');
  });

  /**
   * `gateOf(account) == 0` — the terminal was never registered for this event. The paymaster
   * refuses the sender, and that is a setup problem, not a verdict about this attendee.
   */
  it('turns the paymaster’s UnknownSender into a typed setup error, never a DENY', async () => {
    sendSponsoredOp.mockRejectedValueOnce(new Error('AA33 reverted: UnknownSender()'));
    const failure = await sendCheckIn({ code, response, orgId: 5n }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GateNotRegisteredError);
    expect((failure as InstanceType<typeof GateNotRegisteredError>).gateAccount).toBe(GATE_ACCOUNT);
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it('lets every other send failure through untouched', async () => {
    const original = new Error('AA23 reverted (or OOG)');
    sendSponsoredOp.mockRejectedValueOnce(original);
    await expect(sendCheckIn({ code, response, orgId: 5n })).rejects.toBe(original);
  });

  it('never sends a call it could not build', async () => {
    await expect(
      sendCheckIn({ code, response: { ...response, nonce: `0x${'ee'.repeat(32)}` }, orgId: 5n }),
    ).rejects.toThrow('CHECK_IN_CODE_MISMATCH');
    expect(sendSponsoredOp).not.toHaveBeenCalled();
  });
});
