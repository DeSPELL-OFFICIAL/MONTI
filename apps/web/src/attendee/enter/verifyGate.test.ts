import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { CLOCK_SKEW_SECONDS, CODE_WINDOW_SECONDS, gateCodePreimage, type GateCodeWire } from '@monti/shared';

const gateInfo = vi.fn();
const eventOf = vi.fn();
vi.mock('../../shared/chain/reads', () => ({
  readOrganizers: () => ({ gateInfo }),
  readTicket: () => ({ eventOf }),
}));

const { cacheGate, gateCodeDigest, isGateCodeFresh, verifyGate, verifyGateRegistered, verifyGateSignature } =
  await import('./verifyGate');

/**
 * The gate's real signing key never leaves its secure element, so a test key is minted here the
 * same way a verifier meets one: as a raw (x, y) point. WebCrypto is used on both sides on
 * purpose — an implementation that quietly re-hashed or mis-ordered the preimage would still
 * pass if the test built the signature with the same wrong rule by hand.
 */
async function newGateKey(): Promise<{ kx: Hex; ky: Hex; sign: (wire: GateCodeWire) => Promise<Hex> }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const fromB64 = (value: string): Hex => {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    return bytesToHex(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  };
  return {
    kx: fromB64(jwk.x as string),
    ky: fromB64(jwk.y as string),
    sign: async (wire) => {
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        // Copied into a plain ArrayBuffer view: viem's ByteArray is not WebCrypto's BufferSource.
        Uint8Array.from(
          hexToBytes(
            gateCodePreimage({
              gateId: BigInt(wire.gateId),
              eventId: BigInt(wire.eventId),
              issuedAt: BigInt(wire.issuedAt),
              nonce: wire.nonce,
            }),
          ),
        ),
      );
      return bytesToHex(new Uint8Array(signature));
    },
  };
}

const NONCE = `0x${'5a'.repeat(32)}` as Hex;
const TOKEN_ID = '7';
const NOW = 1_790_000_000;

const unsigned: Omit<GateCodeWire, 'sig'> = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: NOW,
  nonce: NONCE,
  kx: `0x${'00'.repeat(32)}`,
  ky: `0x${'00'.repeat(32)}`,
};

/** `gateInfo`'s six outputs, already named by `reads.ts`. */
function onChainGate(key: { kx: Hex; ky: Hex }, overrides: Record<string, unknown> = {}) {
  return {
    eventId: 11n,
    account: `0x${'bb'.repeat(20)}` as Hex,
    kx: key.kx,
    ky: key.ky,
    open: true,
    revoked: false,
    ...overrides,
  };
}

async function signedBy(key: Awaited<ReturnType<typeof newGateKey>>, over: Partial<GateCodeWire> = {}) {
  const wire: GateCodeWire = { ...unsigned, ...over, kx: key.kx, ky: key.ky, sig: `0x${'00'.repeat(64)}` };
  return { ...wire, sig: await key.sign(wire) };
}

beforeEach(() => {
  localStorage.clear();
  gateInfo.mockReset();
  eventOf.mockReset();
  eventOf.mockResolvedValue(11n);
});

describe('gateCodeDigest', () => {
  it('is byte-for-byte the vector @monti/shared pins for the gate signature', () => {
    // packages/shared/src/encoding.hash.test.ts — gateId 3, eventId 11, issuedAt 1789862400,
    // nonce 0x11*32. The staff device signs this exact digest, so drifting from it is a gate
    // that reads every code as a forgery.
    expect(
      gateCodeDigest({
        ...unsigned,
        gateId: '3',
        eventId: '11',
        issuedAt: 1_789_862_400,
        nonce: `0x${'11'.repeat(32)}`,
        sig: `0x${'00'.repeat(64)}`,
      }),
    ).toBe('0xb284e28bf3727ec6a13b3fd1b195cadd348b187d2e904c4013961c068cbe121d');
  });
});

describe('verifyGateSignature', () => {
  it('accepts a signature made by the key the chain reports', async () => {
    const key = await newGateKey();
    await expect(verifyGateSignature(await signedBy(key), key)).resolves.toBe(true);
  });

  it('rejects the same signature under a different on-chain key', async () => {
    const key = await newGateKey();
    const other = await newGateKey();
    await expect(verifyGateSignature(await signedBy(key), other)).resolves.toBe(false);
  });

  it('never trusts the key carried in the code itself', async () => {
    const real = await newGateKey();
    const forger = await newGateKey();
    // A fake gate signs its own code and puts its own public key in the payload: consistent
    // with itself, and worthless. Threat T14 — only the chain says which key belongs there.
    const forged = await signedBy(forger);
    expect(forged.kx).toBe(forger.kx);
    await expect(verifyGateSignature(forged, real)).resolves.toBe(false);
  });

  it('rejects a tampered field', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    await expect(verifyGateSignature({ ...wire, issuedAt: wire.issuedAt + 1 }, key)).resolves.toBe(false);
    await expect(verifyGateSignature({ ...wire, gateId: '4' }, key)).resolves.toBe(false);
    await expect(verifyGateSignature({ ...wire, eventId: '12' }, key)).resolves.toBe(false);
    await expect(verifyGateSignature({ ...wire, nonce: `0x${'5b'.repeat(32)}` }, key)).resolves.toBe(false);
  });

  it('rejects a forged signature instead of throwing', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    await expect(verifyGateSignature({ ...wire, sig: `0x${'11'.repeat(64)}` }, key)).resolves.toBe(false);
    await expect(verifyGateSignature({ ...wire, sig: '0x' as Hex }, key)).resolves.toBe(false);
  });

  it('rejects a key that is not a point on P-256 instead of throwing', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    await expect(
      verifyGateSignature(wire, { kx: `0x${'ff'.repeat(32)}`, ky: `0x${'ff'.repeat(32)}` }),
    ).resolves.toBe(false);
  });
});

describe('isGateCodeFresh', () => {
  // Ticket.sol: a stamp more than CLOCK_SKEW ahead is a forgery, one CODE_WINDOW behind a
  // replay. The phone allows CLOCK_SKEW at the bottom too, so it does not refuse a code the
  // chain would still take; the window's own edge (now - 65) stays out.
  const fresh = (delta: number) => isGateCodeFresh({ ...unsigned, issuedAt: NOW + delta, sig: '0x' as Hex }, NOW);

  it('rejects a code older than the window plus the skew', () => {
    expect(fresh(-(CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS))).toBe(false);
    expect(fresh(-(CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) + 1)).toBe(true);
  });

  it('accepts the whole chain window', () => {
    expect(fresh(-CODE_WINDOW_SECONDS)).toBe(true);
    expect(fresh(0)).toBe(true);
  });

  it('allows the gate clock to run ahead by the skew and no further', () => {
    expect(fresh(CLOCK_SKEW_SECONDS)).toBe(true);
    expect(fresh(CLOCK_SKEW_SECONDS + 1)).toBe(false);
  });
});

describe('verifyGateRegistered', () => {
  it('hands back the on-chain key for a gate that is open, unrevoked and for this event', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key));
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: true, key: { kx: key.kx, ky: key.ky } });
    expect(gateInfo).toHaveBeenCalledWith(3n);
    expect(eventOf).toHaveBeenCalledWith(7n);
  });

  it('calls a gateId the chain does not know unknown, not closed', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    // An unregistered gate answers with the zero struct, which is also `open: false`.
    gateInfo.mockResolvedValueOnce({
      eventId: 0n, account: `0x${'00'.repeat(20)}`, kx: `0x${'00'.repeat(32)}`,
      ky: `0x${'00'.repeat(32)}`, open: false, revoked: false,
    });
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: false, reason: 'unknownGate' });
  });

  it('refuses a revoked gate', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key, { revoked: true }));
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: false, reason: 'unknownGate' });
  });

  it('refuses a gate that is registered but closed', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key, { open: false }));
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: false, reason: 'gateClosed' });
  });

  it("refuses a gate whose event is not the code's", async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key, { eventId: 9n }));
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: false, reason: 'wrongEvent' });
  });

  it('refuses a gate for an event this ticket does not belong to', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key));
    eventOf.mockResolvedValueOnce(12n);
    await expect(verifyGateRegistered(wire, TOKEN_ID)).resolves.toEqual({ ok: false, reason: 'wrongEvent' });
  });
});

describe('verifyGate', () => {
  it('passes a fresh code from a registered gate and remembers the chain key', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key));
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({ ok: true });
    expect(localStorage.getItem('monti.gate.3')).toContain(key.kx);
  });

  it('refuses a stale code before it touches the chain', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key, { issuedAt: NOW - 200 });
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({
      ok: false,
      reason: 'codeExpired',
    });
    expect(gateInfo).not.toHaveBeenCalled();
  });

  it('refuses a good registration whose signature does not hold', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockResolvedValueOnce(onChainGate(key));
    await expect(
      verifyGate({ ...wire, sig: `0x${'11'.repeat(64)}` }, { tokenId: TOKEN_ID, nowSeconds: NOW }),
    ).resolves.toEqual({ ok: false, reason: 'badSignature' });
    expect(localStorage.getItem('monti.gate.3')).toBeNull();
  });

  it('falls back to the last cached GateRegistered value when the chain is unreachable', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    cacheGate(wire, TOKEN_ID, { kx: key.kx, ky: key.ky });
    gateInfo.mockRejectedValueOnce(new Error('offline'));
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({ ok: true });
  });

  it('still checks the signature against the cached chain key, not the code', async () => {
    const real = await newGateKey();
    const forger = await newGateKey();
    const forged = await signedBy(forger);
    cacheGate(forged, TOKEN_ID, { kx: real.kx, ky: real.ky });
    gateInfo.mockRejectedValueOnce(new Error('offline'));
    await expect(verifyGate(forged, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({
      ok: false,
      reason: 'badSignature',
    });
  });

  it('refuses an unreachable chain with nothing cached for this gate and ticket', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    gateInfo.mockRejectedValue(new Error('offline'));
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({
      ok: false,
      reason: 'unknownGate',
    });
    cacheGate(wire, '8', { kx: key.kx, ky: key.ky });
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({
      ok: false,
      reason: 'unknownGate',
    });
  });

  it('does not reuse a cache entry when the chain answers', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    cacheGate(wire, TOKEN_ID, { kx: key.kx, ky: key.ky });
    gateInfo.mockResolvedValueOnce(onChainGate(key, { revoked: true }));
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({
      ok: false,
      reason: 'unknownGate',
    });
  });

  it('survives a browser with no usable localStorage', async () => {
    const key = await newGateKey();
    const wire = await signedBy(key);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    gateInfo.mockResolvedValueOnce(onChainGate(key));
    await expect(verifyGate(wire, { tokenId: TOKEN_ID, nowSeconds: NOW })).resolves.toEqual({ ok: true });
    setItem.mockRestore();
  });
});

