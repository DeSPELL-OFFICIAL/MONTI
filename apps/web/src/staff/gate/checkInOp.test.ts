import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateCodeWire, GateResponseWire } from '@monti/shared';

// Only the callable is replaced. `relayCheckIn` (checkInOp) shapes the wire payload and hands it to
// `api.relayCheckIn`, so the mock is what the payload assertions read back.
type RelayWire = {
  tokenId: string;
  code: { gateId: string; eventId: string; issuedAt: string; nonce: string };
  gateSig: string;
  deviceSig: string;
  late: boolean;
};
type RelayResult = { relayId: string; status: 'sent' | 'confirmed'; txHash?: string; usedAt?: number };
const relayCheckIn = vi.fn(
  async (_req: RelayWire): Promise<RelayResult> => ({ relayId: '42:123', status: 'sent' }),
);
vi.mock('../../shared/api/functions', () => ({ relayCheckIn }));

const { relayCheckIn: submitCheckIn } = await import('./checkInOp');

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
  relayCheckIn.mockClear();
  relayCheckIn.mockResolvedValue({ relayId: '42:123', status: 'sent' });
});

/** The request `api.relayCheckIn` was handed. */
function request() {
  return relayCheckIn.mock.calls[0]?.[0] as {
    tokenId: string;
    code: { gateId: string; eventId: string; issuedAt: string; nonce: string };
    gateSig: string;
    deviceSig: string;
    late: boolean;
  };
}

describe('shaping the relay payload', () => {
  it('carries the tap, the gate signature and the attendee signature the contract verifies', async () => {
    await submitCheckIn({ code, response });

    const sent = request();
    expect(sent.tokenId).toBe('123');
    // The four signed code fields, `issuedAt` spelled as the decimal string the wire takes.
    expect(sent.code).toEqual({ gateId: '7', eventId: '42', issuedAt: '1700000000', nonce: NONCE });
    // The gate's own P-256 signature over the code digest — `gateCode.ts`'s `sig`, unchanged.
    expect(sent.gateSig).toBe(code.sig);
    // The attendee's device signature, straight off the response.
    expect(sent.deviceSig).toBe(response.deviceSig);
  });

  it('is an on-time check-in by default, and a late one for the offline queue', async () => {
    await submitCheckIn({ code, response });
    expect(request().late).toBe(false);

    relayCheckIn.mockClear();
    await submitCheckIn({ code, response, late: true });
    expect(request().late).toBe(true);
  });

  it('hands back the relayer’s answer untouched — relayId and status decide the screen', async () => {
    relayCheckIn.mockResolvedValueOnce({ relayId: '42:123', status: 'confirmed', txHash: '0xabc', usedAt: 1_700_000_500 });
    const result = await submitCheckIn({ code, response });
    expect(result).toEqual({ relayId: '42:123', status: 'confirmed', txHash: '0xabc', usedAt: 1_700_000_500 });
  });
});

describe('what it refuses to send', () => {
  it('never submits a code and an answer that are not a pair', async () => {
    await expect(
      submitCheckIn({ code, response: { ...response, nonce: `0x${'ee'.repeat(32)}` } }),
    ).rejects.toThrow('CHECK_IN_CODE_MISMATCH');
    expect(relayCheckIn).not.toHaveBeenCalled();
  });

  it('lets a callable failure through untouched, for the caller to map to a DENY', async () => {
    const failure = Object.assign(new Error('GATE_CLOSED'), {
      code: 'failed-precondition',
      details: { code: 'GATE_CLOSED' },
    });
    relayCheckIn.mockRejectedValueOnce(failure);
    await expect(submitCheckIn({ code, response })).rejects.toBe(failure);
  });
});
