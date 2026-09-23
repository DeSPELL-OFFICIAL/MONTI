import { bytesToHex, hexToBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { DEVICE_DIGEST_FORM, deviceDigestV2, deviceSigHash } from '@monti/shared';

import type { GateCodeWire, GateResponseWire, Hex } from '../types';
import {
  checkInDigest,
  checkInMessage,
  verifyDeviceSignatureOffline,
  type DeviceDigestDomain,
} from './offlineVerify';

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** WebCrypto wants its own buffers; a subarray view of a pooled buffer is not one. */
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

/**
 * The cross-plan row every branch pins: the same chain, deployment, token, gate, event, nonce
 * and stamp the contracts' `P256Vectors` and the attendee app's `encoding.hash.test.ts` use.
 * Two vectors over one input is how a drift between the two forms stays visible.
 */
const DOMAIN: DeviceDigestDomain = {
  chainId: 31337n,
  ticket: '0x7111111111111111111111111111111111111111',
};

const VECTOR_CODE: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_789_862_400,
  nonce: `0x${'11'.repeat(32)}`,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};

const V1_VECTOR = '0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7';
const V2_VECTOR = '0xca378ab2af0962bff66d23c4ebb20198fb1a80fe94957e6520368bacae1ffe66';

const VECTOR_FIELDS = {
  tokenId: 7n,
  gateId: 3n,
  eventId: 11n,
  nonce: VECTOR_CODE.nonce,
  issuedAt: 1_789_862_400n,
};

interface TestKey {
  pair: CryptoKeyPair;
  x: Hex;
  y: Hex;
}

async function makeDeviceKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { pair, x: bytesToHex(raw.slice(1, 33)), y: bytesToHex(raw.slice(33, 65)) };
}

/** The attendee's phone, run for real: WebCrypto over the preimage, `r ‖ s` on the wire. */
async function signAs(key: TestKey, message: Hex): Promise<Hex> {
  const sig = await crypto.subtle.sign(ECDSA_SHA256, key.pair.privateKey, copy(hexToBytes(message)));
  return bytesToHex(new Uint8Array(sig));
}

function responseFor(deviceSig: Hex, tokenId = '7'): GateResponseWire {
  return { v: 2, tokenId, nonce: VECTOR_CODE.nonce, deviceSig };
}

describe('the digest the gate recomputes', () => {
  it('is the five-field vector the deployed Ticket.checkIn hashes', () => {
    expect(deviceSigHash(VECTOR_FIELDS)).toBe(V1_VECTOR);
  });

  it('is the seven-field domain-separated vector the 01b Ticket._deviceDigest hashes', () => {
    expect(deviceDigestV2({ ...DOMAIN, ...VECTOR_FIELDS })).toBe(V2_VECTOR);
  });

  it('follows DEVICE_DIGEST_FORM and nothing else — one switch moves both phones', () => {
    expect(checkInDigest({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN })).toBe(
      DEVICE_DIGEST_FORM === 'v2-domainSeparated' ? V2_VECTOR : V1_VECTOR,
    );
  });

  it('is the domain-separated form, because that is what is deployed today', () => {
    // Pinned to the deployment, not to a plan: 01b went out on 2026-09-23 (chain 10143, Ticket
    // 0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367) and its `_deviceDigest` is the seven-word
    // form. The attendee app flipped the same day — the two halves of a tap have to agree on
    // the digest form or every check-in is refused `BadDeviceSignature`. This line moves again
    // only when a redeploy moves the contract.
    expect(DEVICE_DIGEST_FORM).toBe('v2-domainSeparated');
    expect(checkInDigest({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN })).toBe(V2_VECTOR);
  });

  it('hashes the message WebCrypto is handed — the verifier hashes it itself', async () => {
    const message = checkInMessage({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN });
    const hashed = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', copy(hexToBytes(message)))));
    expect(hashed).toBe(checkInDigest({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }));
  });

  it('reads the token from the response and the rest from the code the gate served', () => {
    const other = checkInDigest({ tokenId: '8', code: VECTOR_CODE, domain: DOMAIN });
    expect(other).not.toBe(V1_VECTOR);
    expect(checkInDigest({ tokenId: '7', code: { ...VECTOR_CODE, gateId: '4' }, domain: DOMAIN })).not.toBe(V1_VECTOR);
  });
});

describe('offline device-signature verification', () => {
  it('accepts a real signature by the key the snapshot holds for this ticket', async () => {
    const key = await makeDeviceKey();
    const deviceSig = await signAs(key, checkInMessage({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }));
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: key.x, y: key.y },
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(true);
  });

  it('rejects it against a different device key — the terminal cannot forge one (T15)', async () => {
    const key = await makeDeviceKey();
    const other = await makeDeviceKey();
    const deviceSig = await signAs(key, checkInMessage({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }));
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: other.x, y: other.y },
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a signature over the other digest form', async () => {
    const key = await makeDeviceKey();
    const otherForm =
      DEVICE_DIGEST_FORM === 'v2-domainSeparated'
        ? // v1 preimage: the five words, without the domain in front.
          `0x${'07'.padStart(64, '0')}${'03'.padStart(64, '0')}${'0b'.padStart(64, '0')}${'11'.repeat(32)}${(1_789_862_400).toString(16).padStart(64, '0')}`
        : `0x${(31337).toString(16).padStart(64, '0')}${'7111111111111111111111111111111111111111'.padStart(64, '0')}${'07'.padStart(64, '0')}${'03'.padStart(64, '0')}${'0b'.padStart(64, '0')}${'11'.repeat(32)}${(1_789_862_400).toString(16).padStart(64, '0')}`;
    const deviceSig = await signAs(key, otherForm as Hex);
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: key.x, y: key.y },
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a signature over another code, however valid it is on its own', async () => {
    const key = await makeDeviceKey();
    const elsewhere = { ...VECTOR_CODE, nonce: `0x${'22'.repeat(32)}` as Hex };
    const deviceSig = await signAs(key, checkInMessage({ tokenId: '7', code: elsewhere, domain: DOMAIN }));
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: key.x, y: key.y },
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });

  it('refuses a ticket whose device key the snapshot has cleared, rather than verifying against zeros', async () => {
    const key = await makeDeviceKey();
    const deviceSig = await signAs(key, checkInMessage({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }));
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: undefined,
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });

  it('answers false rather than throwing on a signature that is not 64 bytes', async () => {
    const key = await makeDeviceKey();
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: key.x, y: key.y },
        code: VECTOR_CODE,
        response: responseFor('0xdead'),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });

  it('answers false rather than throwing on a key that is not on the curve', async () => {
    const key = await makeDeviceKey();
    const deviceSig = await signAs(key, checkInMessage({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }));
    await expect(
      verifyDeviceSignatureOffline({
        deviceKey: { x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` },
        code: VECTOR_CODE,
        response: responseFor(deviceSig),
        domain: DOMAIN,
      }),
    ).resolves.toBe(false);
  });
});
