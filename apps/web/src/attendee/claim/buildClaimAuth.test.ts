import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAuthDigest, type Hex } from '@monti/shared';

// The chain and deployment the signature is bound to. These are B1's V2 vector
// (`task-b1-report.md`): chainId 1, ticket 0xf13D…, so a fixed deadline reproduces its digest.
const CHAIN_ID = 1;
const TICKET = '0xf13D09eD3cbdD1C930d4de74808de1f33B6b3D4f' as Hex;
const ACCOUNT = `0x${'11'.repeat(20)}` as Hex;

vi.mock('../../shared/config', () => ({
  getConfig: () => ({ chainId: CHAIN_ID, addresses: { ticket: TICKET } }),
}));

const readClaimNonce = vi.fn<(eventId: bigint, account: Hex) => Promise<bigint>>();
vi.mock('../../shared/chain/reads', () => ({ readClaimNonce }));

// A low-s signature by default; the alias export stays real so the call is pinned against it.
const LOW_R = `0x${'aa'.repeat(32)}` as Hex;
const LOW_S = `0x${'01'.repeat(32)}` as Hex;
const signWithDeviceKey = vi.fn<(digest: Hex, options: { alias: string }) => Promise<{ r: Hex; s: Hex }>>();
vi.mock('../../shared/deviceKey', async (orig) => ({
  ...(await orig<typeof import('../../shared/deviceKey')>()),
  signWithDeviceKey,
}));

const { buildClaimAuth, CLAIM_DEADLINE_SECONDS } = await import('./buildClaimAuth');
const { ATTENDEE_KEY_ALIAS } = await import('../../shared/deviceKey');
const { P256_ORDER } = await import('@monti/shared');

/**
 * B1's V2 digest (`task-b1-report.md`), byte-identical to the deployed `Ticket.claimAuthDigest`:
 * chainId 1, ticket 0xf13D…, eventId 42, tier 3, account 0x1111…1111, nonce 7, deadline 1893456000.
 */
const V2_DIGEST = '0x983774083117fa232ce88f01557824f4073b7c5393935b4d7ce7b053376f56b9';
const V2_DEADLINE = 1_893_456_000;

beforeEach(() => {
  vi.useFakeTimers();
  // now + CLAIM_DEADLINE_SECONDS === V2_DEADLINE, so the built auth matches the pinned vector.
  vi.setSystemTime((V2_DEADLINE - CLAIM_DEADLINE_SECONDS) * 1_000);
  readClaimNonce.mockReset().mockResolvedValue(0n);
  signWithDeviceKey.mockReset().mockResolvedValue({ r: LOW_R, s: LOW_S });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildClaimAuth', () => {
  it('signs the exact claimAuthDigest with the attendee device key, raw', async () => {
    await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });
    const auth = { eventId: 42n, tier: 3, account: ACCOUNT, nonce: 7n, deadline: BigInt(V2_DEADLINE) };
    const expected = claimAuthDigest(BigInt(CHAIN_ID), TICKET, auth);
    // The digest is B1's vector, and it is what the device key was handed — raw, no re-hashing.
    expect(expected).toBe(V2_DIGEST);
    expect(signWithDeviceKey).toHaveBeenCalledWith(V2_DIGEST, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('returns the wire auth and a 64-byte r‖s signature', async () => {
    const built = await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });
    expect(built.auth).toEqual({ eventId: '42', tier: 3, account: ACCOUNT, nonce: '7', deadline: String(V2_DEADLINE) });
    // 0x + 128 hex, exactly r‖s.
    expect(built.deviceSig).toBe(`${LOW_R}${LOW_S.slice(2)}`);
    expect(built.deviceSig).toHaveLength(2 + 128);
  });

  it('sets the deadline to now + ten minutes', async () => {
    const built = await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });
    expect(Number(built.auth.deadline)).toBe(Math.floor(Date.now() / 1000) + CLAIM_DEADLINE_SECONDS);
  });

  it('reads the claim nonce from the chain when none is supplied', async () => {
    readClaimNonce.mockResolvedValue(5n);
    const built = await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT });
    expect(readClaimNonce).toHaveBeenCalledWith(42n, ACCOUNT);
    expect(built.auth.nonce).toBe('5');
  });

  it('never reads the chain when a nonce is handed in (the BAD_NONCE retry)', async () => {
    await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 9n });
    expect(readClaimNonce).not.toHaveBeenCalled();
  });

  it('refuses a high-s signature the on-chain verifier would reject', async () => {
    signWithDeviceKey.mockResolvedValue({ r: LOW_R, s: `0x${(P256_ORDER - 1n).toString(16).padStart(64, '0')}` as Hex });
    await expect(buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n })).rejects.toThrow('HIGH_S');
  });
});
