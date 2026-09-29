import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from 'viem';
import {
  encodeForwardRequestStruct,
  forwardDigest,
  forwardPreimage,
  P256_HALF_ORDER,
  P256_ORDER,
  type ForwardRequest,
  type Hex,
} from '@monti/shared';

const CHAIN_ID = 1;
const FORWARDER = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as Hex;
const TICKET = `0x${'33'.repeat(20)}` as Hex;
const ORGANIZERS = `0x${'22'.repeat(20)}` as Hex;
const IDENTITY = `0x${'11'.repeat(20)}` as Hex;
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;
const DATA = '0xdeadbeef' as Hex;

vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: CHAIN_ID,
    addresses: { ticket: TICKET, organizers: ORGANIZERS, identity: IDENTITY, forwarder: FORWARDER },
  }),
}));

vi.mock('../chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));

const readContract = vi.fn<(args: unknown) => Promise<bigint>>();
vi.mock('../chain/client', () => ({ getPublicClient: () => ({ readContract }) }));

const LOW_R = `0x${'aa'.repeat(32)}` as Hex;
const LOW_S = `0x${'01'.repeat(32)}` as Hex;
const signWithDeviceKey = vi.fn<(message: Hex, options: { alias: string }) => Promise<{ r: Hex; s: Hex }>>();
const deviceKeyCapability = vi.fn<() => 'native' | 'software'>();
vi.mock('../deviceKey', async (orig) => ({
  ...(await orig<typeof import('../deviceKey')>()),
  signWithDeviceKey,
  deviceKeyCapability,
}));

const { buildForwardRequest, FORWARD_DEADLINE_SECONDS } = await import('./buildForwardRequest');
const { ATTENDEE_KEY_ALIAS } = await import('../deviceKey');

const DEADLINE = 1_893_456_000;

function reqFor(to: Hex, nonce: bigint): ForwardRequest {
  return { from: ACCOUNT, to, nonce, deadline: BigInt(DEADLINE), data: DATA };
}

/** A real P-256 key whose sign() hashes its input just like the browser's WebCrypto key. */
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
  vi.setSystemTime((DEADLINE - FORWARD_DEADLINE_SECONDS) * 1_000);
  readContract.mockReset().mockResolvedValue(0n);
  signWithDeviceKey.mockReset().mockResolvedValue({ r: LOW_R, s: LOW_S });
  deviceKeyCapability.mockReset().mockReturnValue('software');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildForwardRequest', () => {
  it('hands the WebCrypto signer the preimage, not the digest (software devices)', async () => {
    await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'createEvent', nonce: 7n });
    const preimage = forwardPreimage(BigInt(CHAIN_ID), FORWARDER, reqFor(TICKET, 7n));
    const digest = forwardDigest(BigInt(CHAIN_ID), FORWARDER, reqFor(TICKET, 7n));
    expect(signWithDeviceKey).toHaveBeenCalledWith(preimage, { alias: ATTENDEE_KEY_ALIAS });
    expect(signWithDeviceKey).not.toHaveBeenCalledWith(digest, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('hands the native raw signer the 32-byte digest as-is (secure-element devices)', async () => {
    deviceKeyCapability.mockReturnValue('native');
    await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'createEvent', nonce: 7n });
    const digest = forwardDigest(BigInt(CHAIN_ID), FORWARDER, reqFor(TICKET, 7n));
    expect(signWithDeviceKey).toHaveBeenCalledWith(digest, { alias: ATTENDEE_KEY_ALIAS });
  });

  it('returns the wire req, a 64-byte r‖s signature, and the kind', async () => {
    const built = await buildForwardRequest({ to: 'organizers', data: DATA, kind: 'registerGate', nonce: 3n });
    expect(built.req).toEqual(encodeForwardRequestStruct(reqFor(ORGANIZERS, 3n)));
    expect(built.deviceSig).toBe(`${LOW_R}${LOW_S.slice(2)}`);
    expect(built.deviceSig).toHaveLength(2 + 128);
    expect(built.kind).toBe('registerGate');
  });

  it('resolves the target address from config per `to`', async () => {
    const built = await buildForwardRequest({ to: 'identity', data: DATA, kind: 'setNickname', nonce: 1n });
    expect(built.req.to).toBe(IDENTITY);
  });

  it('sets the deadline to now + ten minutes', async () => {
    const built = await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'publishEvent', nonce: 1n });
    expect(Number(built.req.deadline)).toBe(Math.floor(Date.now() / 1000) + FORWARD_DEADLINE_SECONDS);
  });

  it('reads the forwarder nonce for the sender when none is supplied', async () => {
    readContract.mockResolvedValue(5n);
    const built = await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'cancelEvent' });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: FORWARDER, functionName: 'nonces', args: [ACCOUNT] }),
    );
    expect(built.req.nonce).toBe('5');
  });

  it('never reads the chain when a nonce is handed in (the BAD_NONCE retry)', async () => {
    await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'cancelEvent', nonce: 9n });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('refuses a high-s signature the on-chain verifier would reject', async () => {
    signWithDeviceKey.mockResolvedValue({ r: LOW_R, s: `0x${(P256_ORDER - 1n).toString(16).padStart(64, '0')}` as Hex });
    await expect(buildForwardRequest({ to: 'ticket', data: DATA, kind: 'createEvent', nonce: 7n })).rejects.toThrow('HIGH_S');
  });

  it('returns r‖s that verify as a P-256 signature over the digest (regression: BAD_DEVICE_SIG)', async () => {
    const device = await newDeviceKey();
    signWithDeviceKey.mockImplementation(async (message: Hex) => device.sign(message));
    const built = await buildForwardRequest({ to: 'ticket', data: DATA, kind: 'createEvent', nonce: 7n });
    const preimage = forwardPreimage(BigInt(CHAIN_ID), FORWARDER, reqFor(TICKET, 7n));
    expect(signWithDeviceKey).toHaveBeenCalledWith(preimage, { alias: ATTENDEE_KEY_ALIAS });
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
