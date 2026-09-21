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

const verifyGate = vi.fn<() => Promise<{ ok: boolean; reason?: string }>>();
vi.mock('./verifyGate', async (orig) => ({
  ...(await orig<typeof import('./verifyGate')>()),
  verifyGate,
}));

const activeDevice = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readIdentity: () => ({ activeDevice }) }));

vi.mock('../../shared/config', () => ({
  getConfig: () => ({ chainId: 31337, addresses: { ticket: TICKET } }),
}));

vi.mock('../../shared/session', () => ({ getSession: () => ({ status: 'signedIn', account: ACCOUNT }) }));

const { GateRefused, buildGateResponse, deviceSigDigest, deviceSigMessage, tapFailure, tapSigner } = await import(
  './buildResponse'
);
const { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, DEVICE_KEY_ERROR } = await import('../../shared/deviceKey');
const { NFC_ERROR, NfcError } = await import('../../shared/nfc');

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

function session(over: Partial<{ armedAt: number; isCurrent: (armedAt: number) => boolean }> = {}) {
  const seen: ArmState[] = [];
  let current: ArmState = { phase: 'reading', error: '', armedAt: 1 };
  const codes: GateCodeWire[] = [];
  const sign = tapSigner({
    tokenId: TOKEN_ID,
    setState: (update) => {
      current = update(current);
      seen.push(current);
    },
    armedAt: 1,
    isCurrent: (armedAt: number) => armedAt === 1,
    onGateCode: (code) => codes.push(code),
    ...over,
  });
  return { sign, seen, codes };
}

beforeEach(async () => {
  device = await newDeviceKey();
  signWithDeviceKey.mockReset().mockImplementation(async () => device.sign(deviceSigMessage({ tokenId: TOKEN_ID, gateCode: GATE_CODE })));
  verifyGate.mockReset().mockResolvedValue({ ok: true });
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

describe('tapSigner — the body of the one NFC session', () => {
  it('verifies, signs and hands the bytes back, in that order', async () => {
    const { sign, seen, codes } = session();
    const wire = await sign(GATE_CODE);
    expect(codes).toEqual([GATE_CODE]);
    expect(seen.map((state) => state.phase)).toEqual(['verifying', 'signing', 'writing']);
    expect(verifyGate.mock.invocationCallOrder[0] as number).toBeLessThan(
      signWithDeviceKey.mock.invocationCallOrder[0] as number,
    );
    const { r, s: low } = await signWithDeviceKey.mock.results[0]?.value;
    expect(wire).toEqual({ v: 1, tokenId: TOKEN_ID, deviceSig: `${r}${low.slice(2)}` });
    // The primitive writes exactly these bytes to the tag it read.
    expect(decodeGateResponse(encodeGateResponse(wire))).toEqual(wire);
  });

  it('never prompts inside the session — it only signs with the key already armed', async () => {
    const { sign } = session();
    await sign(GATE_CODE);
    expect(signWithDeviceKey).toHaveBeenCalledWith(V1_DIGEST, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('tears the session down without signing when the gate is refused', async () => {
    verifyGate.mockResolvedValue({ ok: false, reason: 'gateClosed' });
    const { sign, seen } = session();
    await expect(sign(GATE_CODE)).rejects.toMatchObject({ reason: 'gateClosed' });
    expect(signWithDeviceKey).not.toHaveBeenCalled();
    expect(seen.map((state) => state.phase)).toEqual(['verifying']);
  });

  it('hands nothing back once the arm window has closed under it', async () => {
    const { sign, seen, codes } = session({ isCurrent: () => false });
    await expect(sign(GATE_CODE)).rejects.toBeInstanceOf(NfcError);
    expect(verifyGate).not.toHaveBeenCalled();
    expect(signWithDeviceKey).not.toHaveBeenCalled();
    expect(codes).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('hands nothing back when the window closes between the signature and the write', async () => {
    let open = true;
    signWithDeviceKey.mockImplementation(async () => {
      open = false;
      return device.sign(deviceSigMessage({ tokenId: TOKEN_ID, gateCode: GATE_CODE }));
    });
    const { sign, seen } = session({ isCurrent: () => open });
    await expect(sign(GATE_CODE)).rejects.toBeInstanceOf(NfcError);
    expect(seen.map((state) => state.phase)).toEqual(['verifying', 'signing']);
  });

  it('refuses to hand back a signature the registered device key does not verify', async () => {
    const other = await newDeviceKey();
    activeDevice.mockResolvedValue({ x: other.x, y: other.y });
    const { sign } = session();
    await expect(sign(GATE_CODE)).rejects.toMatchObject({ reason: 'deviceMismatch' });
  });
});

describe('tapFailure — the QR is a fallback, never the default', () => {
  it('offers the code when a session that had read one died before the write', () => {
    expect(tapFailure(new NfcError(NFC_ERROR.cancelled), true)).toEqual({ phase: 'qr', error: 'writeFailed' });
    expect(tapFailure(new NfcError(NFC_ERROR.timeout), true)).toEqual({ phase: 'qr', error: 'writeFailed' });
    expect(tapFailure(new NfcError(NFC_ERROR.readFailed), true)).toEqual({ phase: 'qr', error: 'writeFailed' });
  });

  it('keeps the sentence and the button when the session died before any code arrived', () => {
    expect(tapFailure(new NfcError(NFC_ERROR.cancelled), false)).toEqual({ phase: 'failed', error: 'tapCancelled' });
    expect(tapFailure(new NfcError(NFC_ERROR.timeout), false)).toEqual({ phase: 'failed', error: 'tapTimeout' });
    expect(tapFailure(new NfcError(NFC_ERROR.noGateRecord), false)).toEqual({ phase: 'failed', error: 'tapFailed' });
  });

  it('offers the code to a phone that cannot tap at all', () => {
    expect(tapFailure(new NfcError(NFC_ERROR.unavailable), false)).toEqual({
      phase: 'qr',
      error: 'deviceUnavailable',
    });
  });

  it('sends a lapsed arm window back to the start, and never re-arms', () => {
    const lapsed = Object.assign(new Error('x'), { code: DEVICE_KEY_ERROR.userCancelled });
    expect(tapFailure(lapsed, true)).toEqual({ phase: 'idle', error: 'expired' });
  });

  it('names a key the chip destroyed rather than calling it a failed tap', () => {
    const gone = Object.assign(new Error('x'), { code: DEVICE_KEY_ERROR.keyInvalidated });
    expect(tapFailure(gone, true)).toEqual({ phase: 'failed', error: 'keyInvalidated' });
  });

  it('offers the code when this phone has no hardware key', () => {
    expect(tapFailure(new DeviceKeyUnavailable(), false)).toEqual({ phase: 'qr', error: 'deviceUnavailable' });
  });

  it('keeps a gate refusal as its own sentence', () => {
    expect(tapFailure(new GateRefused('wrongEvent'), true)).toEqual({ phase: 'failed', error: 'wrongEvent' });
  });
});
