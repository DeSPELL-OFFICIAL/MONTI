import { p256 } from '@noble/curves/p256';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Only the native bridge is replaced, the same seam `gateKey.test.ts` cuts at. Mocking
 * `./gateKey` instead would prove that `buildGateCode` calls something — but the three
 * properties a gate code lives or dies by all sit below that seam: the digest the chip is
 * handed, the low-s normalisation on the way back, and the (x, y) the wire carries. Here the
 * real gate-key module does all three and the test only stands in for the chip.
 */
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
}));

const nativeGenerateKey = vi.fn();
const nativeLoadKey = vi.fn();
const nativeSign = vi.fn();
vi.mock('@monti/device-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@monti/device-key')>()),
  DeviceKey: { generateKey: nativeGenerateKey, loadKey: nativeLoadKey, sign: nativeSign },
}));

import {
  CLOCK_SKEW_SECONDS,
  CODE_WINDOW_SECONDS,
  base64UrlDecode,
  base64UrlEncode,
  gateCodePreimage,
  isGateCodeWire,
  joinRs,
  rsToDer,
  splitRs,
} from '@monti/shared';

const { ensureGateKey, gateKeyCoordinates } = await import('./gateKey');
const { buildGateCode, gateCodeDigest, isGateCodeFresh } = await import('./gateCode');

/** One fixed key stands in for StrongBox. noble's ECDSA is RFC-6979 deterministic. */
const PRIV = hexToBytes(`0x${'42'.repeat(32)}`);
const PUB = p256.getPublicKey(PRIV, false);
const X = bytesToHex(PUB.slice(1, 33));
const Y = bytesToHex(PUB.slice(33, 65));
const N = p256.CURVE.n;
/** RFC 5280 SubjectPublicKeyInfo for P-256, the shape the Keystore exports. */
const SPKI = base64UrlEncode(
  hexToBytes(`0x3059301306072a8648ce3d020106082a8648ce3d030107034200${bytesToHex(PUB).slice(2)}`),
);

const toWord = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;
/** WebCrypto's `BufferSource` will not take a view that might sit on a SharedArrayBuffer. */
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const P256_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

function der(r: bigint, s: bigint): { signature: string } {
  return { signature: base64UrlEncode(hexToBytes(rsToDer(joinRs(toWord(r), toWord(s))))) };
}

/** The chip signs the 32 bytes it is handed, raw — `NONEwithECDSA`, no second hash. */
function chipSigns(raise: (s: bigint) => bigint = (s) => s): void {
  nativeSign.mockImplementation(async ({ data }: { tag: string; data: string }) => {
    const signature = p256.sign(base64UrlDecode(data), PRIV, { prehash: false });
    return der(signature.r, raise(signature.s));
  });
}

beforeEach(() => {
  nativeLoadKey.mockResolvedValue({ publicKey: SPKI, backing: 'strongBox' });
  chipSigns();
});

/** The attendee's side of the deal, run for real: WebCrypto over the preimage. */
async function attendeeVerifies(wire: Awaited<ReturnType<typeof buildGateCode>>): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    copy(hexToBytes(`0x04${wire.kx.slice(2)}${wire.ky.slice(2)}`)),
    P256_KEY,
    true,
    ['verify'],
  );
  const preimage = gateCodePreimage({
    gateId: BigInt(wire.gateId),
    eventId: BigInt(wire.eventId),
    issuedAt: BigInt(wire.issuedAt),
    nonce: wire.nonce,
  });
  return crypto.subtle.verify(ECDSA_SHA256, key, copy(hexToBytes(wire.sig)), copy(hexToBytes(preimage)));
}

describe('gateCodeDigest', () => {
  const VECTOR = {
    gateId: '3',
    eventId: '11',
    issuedAt: 1_789_862_400,
    nonce: `0x${'11'.repeat(32)}` as Hex,
  };

  /**
   * The same vector `packages/shared/src/encoding.hash.test.ts` pins and the attendee's
   * `verifyGate.test.ts` pins again. Three copies of one number is the point: the gate signs
   * this digest and the phone recomputes it, so a drift on either side is every tap failing at
   * the door with a signature that "does not verify" and no way to see why.
   */
  it('is byte-for-byte the vector @monti/shared pins for the gate signature', () => {
    expect(gateCodeDigest(VECTOR)).toBe(
      '0xb284e28bf3727ec6a13b3fd1b195cadd348b187d2e904c4013961c068cbe121d',
    );
  });

  it('covers all four signed fields, so none of them can be swapped in flight', () => {
    const base = gateCodeDigest(VECTOR);
    expect(gateCodeDigest({ ...VECTOR, gateId: '4' })).not.toBe(base);
    expect(gateCodeDigest({ ...VECTOR, eventId: '12' })).not.toBe(base);
    expect(gateCodeDigest({ ...VECTOR, issuedAt: VECTOR.issuedAt + 1 })).not.toBe(base);
    expect(gateCodeDigest({ ...VECTOR, nonce: `0x${'12'.repeat(32)}` })).not.toBe(base);
  });
});

describe('buildGateCode', () => {
  it('builds a wire object @monti/shared itself accepts', async () => {
    const code = await buildGateCode({ gateId: 7n, eventId: 42n, now: 1_700_000_000_500 });

    expect(isGateCodeWire(code)).toBe(true);
    expect(code.v).toBe(1);
    expect(code.gateId).toBe('7');
    expect(code.eventId).toBe('42');
    expect(code.issuedAt).toBe(1_700_000_000);
    expect(code.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(code.sig.length).toBe(2 + 128);
  });

  it('carries the key the chain registered, in the order registerGate stores it', async () => {
    const code = await buildGateCode({ gateId: 7n, eventId: 42n });
    expect({ kx: code.kx, ky: code.ky }).toEqual(gateKeyCoordinates(await ensureGateKey()));
    expect(code.kx).toBe(X);
    expect(code.ky).toBe(Y);
  });

  /** The whole task in one assertion: the gate signs a digest, the phone verifies a message. */
  it('produces a signature the attendee verifies with WebCrypto over the preimage', async () => {
    await expect(attendeeVerifies(await buildGateCode({ gateId: 7n, eventId: 42n }))).resolves.toBe(true);
  });

  it('hands the chip the gate-code digest and nothing else', async () => {
    const code = await buildGateCode({ gateId: 7n, eventId: 42n });
    expect(nativeSign).toHaveBeenCalledWith({
      tag: 'monti-gate',
      data: base64UrlEncode(hexToBytes(gateCodeDigest(code))),
    });
  });

  it('never leaves a high-s signature on the wire, which Solady refuses on chain', async () => {
    // A chip is free to answer in either half; `P256.verifySignature` takes only the low one,
    // and a code the chain cannot verify is an attendee refused entry with a valid ticket.
    chipSigns((s) => N - s);
    const code = await buildGateCode({ gateId: 7n, eventId: 42n });

    expect(BigInt(splitRs(code.sig).s)).toBeLessThanOrEqual(N / 2n);
    // (r, n - s) verifies for the same message, so normalising costs the attendee nothing.
    await expect(attendeeVerifies(code)).resolves.toBe(true);
  });

  it('takes all thirty-two nonce bytes from the CSPRNG and never repeats one', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const first = await buildGateCode({ gateId: 1n, eventId: 1n, now: 1_700_000_000_000 });
    const second = await buildGateCode({ gateId: 1n, eventId: 1n, now: 1_700_000_000_000 });

    expect(first.nonce).not.toBe(second.nonce);
    // `Ticket.checkIn` burns `keccak256(abi.encode(nonce))`, so a repeat is a code that can
    // only ever admit one person — the second tap reverts as a replay.
    expect(random).toHaveBeenCalledTimes(2);
    expect((random.mock.calls[0]?.[0] as Uint8Array).length).toBe(32);
    random.mockRestore();
  });

  it('reuses a key the caller already resolved instead of crossing the bridge every 3 s', async () => {
    const key = await ensureGateKey();
    nativeLoadKey.mockClear();
    const code = await buildGateCode({ gateId: 1n, eventId: 1n, key });

    expect(nativeLoadKey).not.toHaveBeenCalled();
    expect(code.kx).toBe(key.x);
  });

  it('stamps issuedAt in whole seconds, inside the skew the chain allows', async () => {
    const now = 1_700_000_000_999;
    const code = await buildGateCode({ gateId: 1n, eventId: 1n, now });

    expect(code.issuedAt).toBe(1_700_000_000);
    expect(code.issuedAt).toBeLessThanOrEqual(Math.floor(now / 1000) + CLOCK_SKEW_SECONDS);
    expect(isGateCodeFresh(code, Math.floor(now / 1000))).toBe(true);
  });
});

describe('isGateCodeFresh', () => {
  // `Ticket.checkIn`: a stamp more than CLOCK_SKEW ahead of chain time is a forgery, one
  // CODE_WINDOW behind it a replay. The gate's own clock may sit anywhere inside that same
  // skew, so the lower edge is relaxed by it too — dropping a code the chain would still take
  // loses a real attendee's entry. Exactly the rule the attendee's `isGateCodeFresh` applies.
  const NOW = 1_790_000_000;
  const fresh = (delta: number) => isGateCodeFresh({ issuedAt: NOW + delta }, NOW);

  it('rejects a code older than the window plus the skew', () => {
    expect(fresh(-(CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS))).toBe(false);
    expect(fresh(-(CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) + 1)).toBe(true);
  });

  it('accepts the whole chain window', () => {
    expect(fresh(-CODE_WINDOW_SECONDS)).toBe(true);
    expect(fresh(0)).toBe(true);
  });

  it('allows the clock to run ahead by the skew and no further', () => {
    expect(fresh(CLOCK_SKEW_SECONDS)).toBe(true);
    expect(fresh(CLOCK_SKEW_SECONDS + 1)).toBe(false);
  });
});
