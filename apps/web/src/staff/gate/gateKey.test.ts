import { describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from 'viem';

const nativeGenerateKey = vi.fn();
const nativeLoadKey = vi.fn();
const nativeSign = vi.fn();

/**
 * Only the native bridge is replaced; everything above it is the real code. Mocking
 * `../../shared/deviceKey` instead — as the plan sketched — would prove the alias and nothing
 * else, and the three properties this key lives or dies by all sit below that seam: the
 * `accessControl: false` the Kotlin `generateKey` turns into `setUserAuthenticationRequired(false)`,
 * the SPKI → (x, y) decode whose output is written to chain, and the raw digest the chip signs.
 */
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
}));
vi.mock('@monti/device-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@monti/device-key')>()),
  DeviceKey: { generateKey: nativeGenerateKey, loadKey: nativeLoadKey, sign: nativeSign },
}));

import { base64UrlEncode, gateCodeHash, gateCodePreimage, joinRs, rsToDer } from '@monti/shared';
import type { GateCodeDigestInput, Hex } from '@monti/shared';

const { DEVICE_KEY_ERROR } = await import('@monti/device-key');
const { ensureGateKey, gateKeyCoordinates, gatePublicKeyUncompressed, signGateCode, signWithGateKey } = await import(
  './gateKey'
);

/**
 * A real P-256 key pair stands in for the StrongBox one. The chip is not here, but every byte
 * that crosses the bridge is the real shape, so the WebCrypto checks below are meaningful:
 * a wrong coordinate order or a re-hashed digest fails them exactly as it would at a door.
 */
const CHIP = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const CHIP_SPKI = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('spki', CHIP.publicKey)));
const CHIP_RAW = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', CHIP.publicKey)));

/**
 * viem hands back `Uint8Array<ArrayBufferLike>`, and WebCrypto's `BufferSource` will not take a
 * view that might sit on a SharedArrayBuffer. The copy is the whole fix.
 */
function bytes(hex: Hex): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(hex));
}

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** The gate code the fixed vectors in @monti/shared's hash tests use. */
const CODE: GateCodeDigestInput = {
  gateId: 3n,
  eventId: 11n,
  issuedAt: 1_789_862_400n,
  nonce: `0x${'11'.repeat(32)}`,
};

function keyNotFound(): Error {
  return Object.assign(new Error(DEVICE_KEY_ERROR.keyNotFound), { code: DEVICE_KEY_ERROR.keyNotFound });
}

/** First boot: nothing under the alias, so the chip mints the key. */
async function freshKey() {
  nativeLoadKey.mockRejectedValueOnce(keyNotFound());
  nativeGenerateKey.mockResolvedValueOnce({ publicKey: CHIP_SPKI, backing: 'strongBox' });
  return ensureGateKey();
}

describe('gate device key', () => {
  it('mints a StrongBox key that never asks for a fingerprint', async () => {
    const key = await freshKey();
    // `accessControl: false` is the whole ruling: the gate signs every 3 s with nobody at the
    // terminal, and a key that prompts would stop the door rather than slow it down.
    expect(nativeGenerateKey).toHaveBeenCalledWith({ tag: 'monti-gate', accessControl: false, strongBox: true });
    // Reported, never assumed — a TEE downgrade has to reach whoever registers the key.
    expect(key.backing).toBe('strongBox');
  });

  it('creates the key once and finds it again on the next app start', async () => {
    const first = await freshKey();
    // Second boot: the alias resolves, so nothing is minted. Rotating a key already registered
    // through Organizers.registerGate cannot be undone.
    nativeLoadKey.mockResolvedValueOnce({ publicKey: CHIP_SPKI, backing: 'strongBox' });
    await expect(ensureGateKey()).resolves.toEqual(first);
    expect(nativeGenerateKey).toHaveBeenCalledTimes(1);
  });

  it('exports 64 bytes — x‖y with no 0x04 — that are a point on P-256', async () => {
    const key = await freshKey();
    const uncompressed = gatePublicKeyUncompressed(key);

    expect(uncompressed).toBe(`0x${key.x.slice(2)}${key.y.slice(2)}`);
    expect(uncompressed.length).toBe(2 + 128);
    // WebCrypto's `raw` EC format is the SEC1 point, so the 0x04 tag goes back on here and only
    // here. importKey rejects anything off the curve, which is the curve-point check.
    const point = bytes(`0x04${uncompressed.slice(2)}`);
    expect(bytesToHex(point)).toBe(CHIP_RAW);
    await expect(crypto.subtle.importKey('raw', point, P256, true, ['verify'])).resolves.toBeDefined();
  });

  it('hands registerGate two bytes32 in the order the contract stores them', async () => {
    const key = await freshKey();
    // Organizers.registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky).
    // kx and ky are indistinguishable at the call site, and swapping them is unrecoverable.
    expect(gateKeyCoordinates(key)).toEqual({ kx: key.x, ky: key.y });
    expect(gateKeyCoordinates(key).kx.length).toBe(66);
    expect(gateKeyCoordinates(key).ky.length).toBe(66);
  });

  it('signs the gate code so the attendee WebCrypto verify over the preimage agrees', async () => {
    const key = await freshKey();
    const preimage = gateCodePreimage(CODE);

    nativeSign.mockImplementation(async ({ tag, data }: { tag: string; data: string }) => {
      expect(tag).toBe('monti-gate');
      // The bridge must be handed the digest itself. The Kotlin side signs with NONEwithECDSA,
      // so anything else here becomes a signature over the wrong message.
      expect(data).toBe(base64UrlEncode(hexToBytes(gateCodeHash(CODE))));
      // WebCrypto signs the preimage and hashes it internally — the attendee's side of the deal.
      const raw = new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, CHIP.privateKey, bytes(preimage)));
      return { signature: base64UrlEncode(hexToBytes(rsToDer(bytesToHex(raw)))) };
    });

    const { r, s } = await signGateCode(CODE);

    const registered = await crypto.subtle.importKey(
      'raw',
      bytes(`0x04${gatePublicKeyUncompressed(key).slice(2)}`),
      P256,
      true,
      ['verify'],
    );
    // This is the assertion the whole task exists for: the gate signed a digest, the attendee
    // verifies over the message, and they agree only because both come from gateCodePreimage.
    await expect(
      crypto.subtle.verify(ECDSA_SHA256, registered, bytes(joinRs(r, s)), bytes(preimage)),
    ).resolves.toBe(true);
  });

  it('normalises a high-s signature down before it leaves the device', async () => {
    // P-256 group order n minus one: the largest producible `s`, firmly in the high half.
    const nMinusOne = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550';
    const r = `0x${'00'.repeat(31)}07` as Hex;
    nativeSign.mockResolvedValueOnce({
      signature: base64UrlEncode(hexToBytes(rsToDer(joinRs(r, `0x${nMinusOne}`)))),
    });
    await expect(signWithGateKey(`0x${'ab'.repeat(32)}`)).resolves.toEqual({ r, s: `0x${'00'.repeat(31)}01` });
  });

  it('signs a bare digest on the gate alias, never the attendee one', async () => {
    const digest: Hex = `0x${'cc'.repeat(32)}`;
    const der = rsToDer(joinRs(`0x${'07'.repeat(32)}`, `0x${'11'.repeat(32)}`));
    nativeSign.mockResolvedValueOnce({ signature: base64UrlEncode(hexToBytes(der)) });
    await signWithGateKey(digest);
    expect(nativeSign).toHaveBeenCalledWith({ tag: 'monti-gate', data: base64UrlEncode(hexToBytes(digest)) });
  });
});
