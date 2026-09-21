import { describe, expect, it, vi } from 'vitest';

const generateKey = vi.fn();
const sign = vi.fn();
/** `null` is the plugin adapter's typed "no key under this alias yet". */
const loadKey = vi.fn<() => Promise<{ publicKey: string; backing?: string } | null>>(async () => null);
vi.mock('./plugin', () => ({
  generateKey,
  sign,
  loadKey,
  PLUGIN_SUPPORTS_ACCESS_CONTROL: true,
  PLUGIN_SIGNS_DIGEST_RAW: true,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

import { base64UrlEncode } from '@monti/shared';

const { ensureDeviceKey, signWithDeviceKey, armDeviceKey, ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, GATE_KEY_ALIAS } =
  await import('./index');

const hex = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SPKI_B64 = b64(hex(`3059301306072a8648ce3d020106082a8648ce3d03010703420004${'11'.repeat(32)}${'22'.repeat(32)}`));

/**
 * P-256 group order n minus one: the largest producible `s`, and firmly in the high half.
 * Solady's P256.verifySignature rejects `s > n/2`, so the wrapper must return n - s = 1.
 */
const N_MINUS_1 = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550';
/** DER SEQUENCE { INTEGER 0x07, INTEGER n-1 } — the 0x00 pad is DER's sign bit rule. */
const DER_HIGH_S = b64(hex(`3026020107022100${N_MINUS_1}`));
/** DER SEQUENCE { INTEGER 0x07, INTEGER 0x1111…11 } — already low-s, must pass through. */
const DER_LOW_S = b64(hex(`30250201070220${'11'.repeat(32)}`));

const R_SEVEN = `0x${'00'.repeat(31)}07`;

describe('device key', () => {
  it('creates the attendee key with auth required and returns x, y', async () => {
    generateKey.mockResolvedValueOnce({ publicKey: SPKI_B64 });
    await expect(ensureDeviceKey({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true })).resolves.toEqual({
      x: `0x${'11'.repeat(32)}`,
      y: `0x${'22'.repeat(32)}`,
    });
    expect(generateKey).toHaveBeenCalledWith({ alias: 'monti-attendee', requireAuth: true, strongBox: true });
  });

  it('creates the gate key without an auth requirement', async () => {
    generateKey.mockResolvedValueOnce({ publicKey: SPKI_B64 });
    await ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true });
    expect(generateKey).toHaveBeenCalledWith({ alias: 'monti-gate', requireAuth: false, strongBox: true });
  });

  it('reports the secure hardware the backend actually used, so a TEE downgrade is visible', async () => {
    generateKey.mockResolvedValueOnce({ publicKey: SPKI_B64, backing: 'tee' });
    await expect(ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true })).resolves.toEqual({
      x: `0x${'11'.repeat(32)}`,
      y: `0x${'22'.repeat(32)}`,
      backing: 'tee',
    });
  });

  it('returns the existing key instead of minting a second one', async () => {
    loadKey.mockResolvedValueOnce({ publicKey: SPKI_B64 });
    await expect(ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true })).resolves.toEqual({
      x: `0x${'11'.repeat(32)}`,
      y: `0x${'22'.repeat(32)}`,
    });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('rethrows a loadKey failure rather than rotating a key that may be registered on chain', async () => {
    loadKey.mockRejectedValueOnce(new Error('user cancelled Face ID'));
    await expect(ensureDeviceKey({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true })).rejects.toThrow(
      'user cancelled Face ID',
    );
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('signs the digest raw — the exact 32 bytes, never re-hashed — and normalises s low', async () => {
    sign.mockResolvedValueOnce({ signature: DER_HIGH_S });
    const digestBytes = new Uint8Array(32).fill(0xab);
    const digest = `0x${'ab'.repeat(32)}` as const;
    await expect(signWithDeviceKey(digest, { alias: ATTENDEE_KEY_ALIAS })).resolves.toEqual({
      r: R_SEVEN,
      // n - (n - 1) = 1. Solady's P256.verifySignature rejects the high-s original.
      s: `0x${'00'.repeat(31)}01`,
    });
    const sent = sign.mock.calls[0]![0] as { alias: string; data: string };
    expect(sent.alias).toBe('monti-attendee');
    // This is the safety-critical invariant: Ticket.checkIn verifies P256 over this digest.
    expect(sent.data).toBe(base64UrlEncode(digestBytes));
  });

  it('leaves a signature that is already low-s untouched', async () => {
    sign.mockResolvedValueOnce({ signature: DER_LOW_S });
    await expect(signWithDeviceKey(`0x${'ab'.repeat(32)}`, { alias: GATE_KEY_ALIAS })).resolves.toEqual({
      r: R_SEVEN,
      s: `0x${'11'.repeat(32)}`,
    });
  });

  it('refuses to mint a biometric key on a backend that cannot enforce it', async () => {
    const { ensureDeviceKeyNative } = await import('./native');
    vi.doMock('./plugin', () => ({
      generateKey,
      sign,
      loadKey,
      PLUGIN_SUPPORTS_ACCESS_CONTROL: false,
      PLUGIN_SIGNS_DIGEST_RAW: true,
    }));
    vi.resetModules();
    const { ensureDeviceKeyNative: guarded } = await import('./native');
    await expect(guarded({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true })).rejects.toThrow(
      'DeviceKeyPolicyUnsupported: backend cannot enforce biometric access control',
    );
    expect(ensureDeviceKeyNative).toBeTypeOf('function');
    vi.doUnmock('./plugin');
    vi.resetModules();
  });

  it('refuses to mint even the gate key on a backend that re-hashes the digest', async () => {
    vi.doMock('./plugin', () => ({
      generateKey,
      sign,
      loadKey,
      PLUGIN_SUPPORTS_ACCESS_CONTROL: true,
      PLUGIN_SIGNS_DIGEST_RAW: false,
    }));
    vi.resetModules();
    const { ensureDeviceKey: guarded } = await import('./index');
    await expect(guarded({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true })).rejects.toThrow(
      'DeviceKeyPolicyUnsupported: backend re-hashes the digest',
    );
    expect(generateKey).not.toHaveBeenCalled();
    vi.doUnmock('./plugin');
    vi.resetModules();
  });

  it('arms by signing a throwaway digest so the biometric context is retained for 60s', async () => {
    sign.mockResolvedValueOnce({ signature: DER_LOW_S });
    await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
    expect(sign).toHaveBeenCalled();
    expect(ARM_WINDOW_SECONDS).toBe(60);
  });
});
