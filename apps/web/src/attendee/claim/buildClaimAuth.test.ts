import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from 'viem';
import { claimAuthDigest, claimAuthPreimage, P256_HALF_ORDER, P256_ORDER, type Hex } from '@monti/shared';

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
const signWithDeviceKey = vi.fn<(message: Hex, options: { alias: string }) => Promise<{ r: Hex; s: Hex }>>();
const deviceKeyCapability = vi.fn<() => 'native' | 'software'>();
vi.mock('../../shared/deviceKey', async (orig) => ({
  ...(await orig<typeof import('../../shared/deviceKey')>()),
  signWithDeviceKey,
  deviceKeyCapability,
}));

const { buildClaimAuth, CLAIM_DEADLINE_SECONDS } = await import('./buildClaimAuth');
const { ATTENDEE_KEY_ALIAS } = await import('../../shared/deviceKey');

/**
 * B1's V2 digest (`task-b1-report.md`), byte-identical to the deployed `Ticket.claimAuthDigest`:
 * chainId 1, ticket 0xf13D…, eventId 42, tier 3, account 0x1111…1111, nonce 7, deadline 1893456000.
 */
const V2_DIGEST = '0x983774083117fa232ce88f01557824f4073b7c5393935b4d7ce7b053376f56b9';
const V2_DEADLINE = 1_893_456_000;

/** A real device key whose sign() hashes its input just like the browser's WebCrypto key. */
async function newDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const fromB64 = (value: string): Hex => {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    return bytesToHex(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  };
  return {
    x: fromB64(jwk.x as string),
    y: fromB64(jwk.y as string),
    // WebCrypto answers with raw r||s and half are high-s; the real signer normalises, so this does too.
    sign: async (message: Hex): Promise<{ r: Hex; s: Hex }> => {
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Uint8Array.from(hexToBytes(message))),
      );
      const r = bytesToHex(raw.slice(0, 32)) as Hex;
      const value = BigInt(bytesToHex(raw.slice(32)));
      const s = value <= P256_HALF_ORDER ? value : P256_ORDER - value;
      return { r, s: `0x${s.toString(16).padStart(64, '0')}` as Hex };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // now + CLAIM_DEADLINE_SECONDS === V2_DEADLINE, so the built auth matches the pinned vector.
  vi.setSystemTime((V2_DEADLINE - CLAIM_DEADLINE_SECONDS) * 1_000);
  readClaimNonce.mockReset().mockResolvedValue(0n);
  signWithDeviceKey.mockReset().mockResolvedValue({ r: LOW_R, s: LOW_S });
  deviceKeyCapability.mockReset().mockReturnValue('software');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildClaimAuth', () => {
  it('hands the WebCrypto signer the preimage, not the digest (software devices)', async () => {
    await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });
    const auth = { eventId: 42n, tier: 3, account: ACCOUNT, nonce: 7n, deadline: BigInt(V2_DEADLINE) };
    const preimage = claimAuthPreimage(BigInt(CHAIN_ID), TICKET, auth);
    // The pinned digest is the SHA-256 of that preimage — B1's vector.
    expect(claimAuthDigest(BigInt(CHAIN_ID), TICKET, auth)).toBe(V2_DIGEST);
    // WebCrypto hashes what it signs; handing it the digest would sign sha256(digest) and the
    // chain rejects it (BadDeviceSignature). So the browser device key gets the preimage.
    expect(signWithDeviceKey).toHaveBeenCalledWith(preimage, { alias: ATTENDEE_KEY_ALIAS });
    expect(signWithDeviceKey).not.toHaveBeenCalledWith(V2_DIGEST, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('hands the native raw signer the 32-byte digest as-is (secure-element devices)', async () => {
    deviceKeyCapability.mockReturnValue('native');
    await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });
    // The secure element does not re-hash, so raw signing the digest is the chain-valid path.
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

  it('returns r‖s that verify as a P-256 signature over the digest (regression: BAD_DEVICE_SIG)', async () => {
    // A real P-256 key whose signer hashes its input exactly as the browser device key does, so
    // this drives the whole path rather than trusting the digest/preimage bookkeeping.
    const device = await newDeviceKey();
    signWithDeviceKey.mockImplementation(async (message: Hex) => device.sign(message));

    const built = await buildClaimAuth({ eventId: '42', tier: 3, account: ACCOUNT, nonce: 7n });

    const auth = { eventId: 42n, tier: 3, account: ACCOUNT, nonce: 7n, deadline: BigInt(V2_DEADLINE) };
    const preimage = claimAuthPreimage(BigInt(CHAIN_ID), TICKET, auth);
    // It is the preimage that gets signed, never the bare 32-byte digest.
    expect(signWithDeviceKey).toHaveBeenCalledWith(preimage, { alias: ATTENDEE_KEY_ALIAS });
    // r‖s must verify over the digest — what Ticket._verifyClaimAuth checks. WebCrypto verify hashes
    // the preimage back to the digest, so a pass here is a pass over the digest; had buildClaimAuth
    // signed the digest, r‖s would be over sha256(digest) and this assertion would fail.
    const rawPub = new Uint8Array(new ArrayBuffer(65));
    rawPub[0] = 0x04;
    rawPub.set(hexToBytes(device.x), 1);
    rawPub.set(hexToBytes(device.y), 33);
    const pub = await crypto.subtle.importKey('raw', rawPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      Uint8Array.from(hexToBytes(built.deviceSig)),
      Uint8Array.from(hexToBytes(preimage)),
    );
    expect(ok).toBe(true);
  });
});
