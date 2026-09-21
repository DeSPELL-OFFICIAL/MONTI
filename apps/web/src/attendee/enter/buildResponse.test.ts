import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import {
  P256_HALF_ORDER,
  P256_ORDER,
  decodeGateResponse,
  deviceDigestV2,
  encodeGateResponse,
  splitRs,
  type GateCodeWire,
} from '@monti/shared';
import type { ArmState } from './useArm';

const TICKET = '0x7111111111111111111111111111111111111111' as Hex;
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;

const signWithDeviceKey = vi.fn<(digest: Hex, options: { alias: string }) => Promise<{ r: Hex; s: Hex }>>();
vi.mock('../../shared/deviceKey', async (orig) => ({
  ...(await orig<typeof import('../../shared/deviceKey')>()),
  signWithDeviceKey,
}));

const writeGateResponse = vi.fn<() => Promise<void>>();
vi.mock('../../shared/nfc', async (orig) => ({
  ...(await orig<typeof import('../../shared/nfc')>()),
  writeGateResponse,
}));

const activeDevice = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readIdentity: () => ({ activeDevice }) }));

vi.mock('../../shared/config', () => ({
  getConfig: () => ({ chainId: 31337, addresses: { ticket: TICKET } }),
}));

vi.mock('../../shared/session', () => ({ getSession: () => ({ status: 'signedIn', account: ACCOUNT }) }));

const { buildGateResponse, deviceSigDigest, deviceSigMessage, handOverSignature } = await import('./buildResponse');
const { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, DEVICE_KEY_ERROR } = await import('../../shared/deviceKey');

/**
 * The contracts' own vector, so this file and `contracts/test/` cannot drift:
 * `P256Vectors.SHARED_*` — chainId 31337, ticket 0x7111…, tokenId 7, gateId 3, eventId 11,
 * nonce 0x11×32, issuedAt 1789862400.
 */
const NONCE = `0x${'11'.repeat(32)}` as Hex;
const TOKEN_ID = '7';
const GATE_CODE: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_789_862_400,
  nonce: NONCE,
  kx: `0x${'00'.repeat(32)}`,
  ky: `0x${'00'.repeat(32)}`,
  sig: `0x${'00'.repeat(64)}`,
};

/** The five-field digest the deployed `Ticket.checkIn` recomputes (`P256Vectors.t.sol`). */
const V1_DIGEST = '0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7';
/** The domain-separated one 01b lands (`P256Vectors.SHARED_DIGEST`, commit ba44c63). */
const V2_DIGEST = '0xca378ab2af0962bff66d23c4ebb20198fb1a80fe94957e6520368bacae1ffe66';

/** A real device key, so the local verify is exercised rather than stubbed out. */
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
    // WebCrypto answers with raw r||s, and half of those are high-s; the secure element's
    // wrapper normalises for the same reason, so the test key behaves like the real one.
    sign: async (message: Hex): Promise<{ r: Hex; s: Hex }> => {
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Uint8Array.from(hexToBytes(message))),
      );
      const { r, s } = splitRs(bytesToHex(raw));
      const value = BigInt(s);
      return { r, s: value <= P256_HALF_ORDER ? s : (`0x${(P256_ORDER - value).toString(16).padStart(64, '0')}` as Hex) };
    },
  };
}

let device: Awaited<ReturnType<typeof newDeviceKey>>;

function states(): { setState: (u: (prev: ArmState) => ArmState) => void; seen: ArmState[] } {
  const seen: ArmState[] = [];
  let current: ArmState = { phase: 'verifying', error: '', armedAt: 1 };
  return {
    setState: (update) => {
      current = update(current);
      seen.push(current);
    },
    seen,
  };
}

const live = { armedAt: 1, isCurrent: (armedAt: number) => armedAt === 1 };
const stale = { armedAt: 1, isCurrent: () => false };

beforeEach(async () => {
  device = await newDeviceKey();
  signWithDeviceKey.mockReset().mockImplementation(async () => device.sign(deviceSigMessage({ tokenId: TOKEN_ID, gateCode: GATE_CODE })));
  writeGateResponse.mockReset().mockResolvedValue(undefined);
  activeDevice.mockReset().mockResolvedValue({ x: device.x, y: device.y });
});

describe('deviceSigDigest', () => {
  it('is the five-field digest the deployed Ticket.checkIn recomputes', () => {
    expect(deviceSigDigest({ tokenId: TOKEN_ID, gateCode: GATE_CODE })).toBe(V1_DIGEST);
  });

  it('can produce the domain-separated digest 01b lands, from the same inputs', () => {
    expect(
      deviceDigestV2({
        chainId: 31337n,
        ticket: TICKET,
        tokenId: 7n,
        gateId: 3n,
        eventId: 11n,
        nonce: NONCE,
        issuedAt: 1_789_862_400n,
      }),
    ).toBe(V2_DIGEST);
  });

  it('hands WebCrypto the preimage, since it hashes the message itself', async () => {
    const message = deviceSigMessage({ tokenId: TOKEN_ID, gateCode: GATE_CODE });
    const digest = bytesToHex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(hexToBytes(message)))),
    );
    expect(digest).toBe(deviceSigDigest({ tokenId: TOKEN_ID, gateCode: GATE_CODE }));
  });
});

describe('buildGateResponse', () => {
  it('signs the digest with the attendee alias', async () => {
    await buildGateResponse(TOKEN_ID, GATE_CODE);
    expect(signWithDeviceKey).toHaveBeenCalledWith(V1_DIGEST, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('puts r and s on the wire as two 32-byte words', async () => {
    const wire = await buildGateResponse(TOKEN_ID, GATE_CODE);
    const { r, s } = await signWithDeviceKey.mock.results[0]?.value;
    expect(wire).toEqual({ v: 1, tokenId: TOKEN_ID, deviceSig: `${r}${s.slice(2)}` });
    expect(wire.deviceSig).toHaveLength(2 + 128);
  });

  it('round-trips through the shared codec', async () => {
    const wire = await buildGateResponse(TOKEN_ID, GATE_CODE);
    expect(decodeGateResponse(encodeGateResponse(wire))).toEqual(wire);
  });

  it('refuses a high-s signature, which Solady rejects on chain', async () => {
    signWithDeviceKey.mockImplementation(async () => {
      const { r, s } = await device.sign(deviceSigMessage({ tokenId: TOKEN_ID, gateCode: GATE_CODE }));
      return { r, s: `0x${(P256_ORDER - BigInt(s)).toString(16).padStart(64, '0')}` as Hex };
    });
    await expect(buildGateResponse(TOKEN_ID, GATE_CODE)).rejects.toMatchObject({ reason: 'signFailed' });
  });

  it('refuses a signature the registered device key does not verify', async () => {
    const other = await newDeviceKey();
    activeDevice.mockResolvedValue({ x: other.x, y: other.y });
    await expect(buildGateResponse(TOKEN_ID, GATE_CODE)).rejects.toMatchObject({ reason: 'deviceMismatch' });
  });

  it('still answers when the chain cannot be reached — the chain is the real check', async () => {
    activeDevice.mockRejectedValue(new Error('offline'));
    await expect(buildGateResponse(TOKEN_ID, GATE_CODE)).resolves.toMatchObject({ tokenId: TOKEN_ID });
  });
});

describe('handOverSignature', () => {
  it('signs, then writes, then waits — in that order', async () => {
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(seen.map((state) => state.phase)).toEqual(['signing', 'writing', 'waiting']);
    expect(signWithDeviceKey.mock.invocationCallOrder[0] as number).toBeLessThan(
      writeGateResponse.mock.invocationCallOrder[0] as number,
    );
    // ECDSA is randomised, so the wire is compared against THIS run's signature, not a rebuilt one.
    const { r, s } = await signWithDeviceKey.mock.results[0]?.value;
    expect(writeGateResponse).toHaveBeenCalledWith({ v: 1, tokenId: TOKEN_ID, deviceSig: `${r}${s.slice(2)}` });
  });

  it('writes nothing when the signature does not match the registered device', async () => {
    const other = await newDeviceKey();
    activeDevice.mockResolvedValue({ x: other.x, y: other.y });
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(writeGateResponse).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ phase: 'failed', error: 'deviceMismatch' });
  });

  it('falls back to the code after one failed write', async () => {
    writeGateResponse.mockRejectedValue(new Error('no tag'));
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(writeGateResponse).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toMatchObject({ phase: 'qr', error: 'writeFailed' });
  });

  it('sends a lapsed arm window back to the start, and never re-arms', async () => {
    signWithDeviceKey.mockRejectedValue(Object.assign(new Error('x'), { code: DEVICE_KEY_ERROR.userCancelled }));
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(seen.at(-1)).toMatchObject({ phase: 'idle', error: 'expired', armedAt: 0 });
    expect(writeGateResponse).not.toHaveBeenCalled();
  });

  it('names a key the chip destroyed rather than calling it a failed tap', async () => {
    signWithDeviceKey.mockRejectedValue(Object.assign(new Error('x'), { code: DEVICE_KEY_ERROR.keyInvalidated }));
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(seen.at(-1)).toMatchObject({ phase: 'failed', error: 'keyInvalidated' });
  });

  it('offers the code when this phone has no hardware key', async () => {
    signWithDeviceKey.mockRejectedValue(new DeviceKeyUnavailable());
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(seen.at(-1)).toMatchObject({ phase: 'qr', error: 'deviceUnavailable' });
  });

  it('reports anything else as a failed signature', async () => {
    signWithDeviceKey.mockRejectedValue(new Error('bridge died'));
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...live });
    expect(seen.at(-1)).toMatchObject({ phase: 'failed', error: 'signFailed' });
  });

  it('writes nothing once the arm window has closed under it', async () => {
    const { setState, seen } = states();
    await handOverSignature({ tokenId: TOKEN_ID, gateCode: GATE_CODE, setState, ...stale });
    expect(writeGateResponse).not.toHaveBeenCalled();
    expect(seen.map((state) => state.phase)).toEqual(['signing']);
  });

  it('does not move to waiting when the window closed during the write', async () => {
    let open = true;
    const { setState, seen } = states();
    writeGateResponse.mockImplementation(async () => {
      open = false;
    });
    await handOverSignature({
      tokenId: TOKEN_ID,
      gateCode: GATE_CODE,
      setState,
      armedAt: 1,
      isCurrent: () => open,
    });
    expect(seen.map((state) => state.phase)).toEqual(['signing', 'writing']);
  });
});
