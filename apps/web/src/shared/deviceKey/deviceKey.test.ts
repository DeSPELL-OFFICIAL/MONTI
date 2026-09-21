import { describe, expect, it, vi } from 'vitest';

const generateKey = vi.fn();
const sign = vi.fn();
const loadKey = vi.fn(async () => {
  throw new Error('missing');
});
vi.mock('./plugin', () => ({ generateKey, sign, loadKey, PLUGIN_SUPPORTS_ACCESS_CONTROL: true }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

import { base64UrlEncode } from '@monti/shared';

const { ensureDeviceKey, signWithDeviceKey, armDeviceKey, ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, GATE_KEY_ALIAS } =
  await import('./index');

const hex = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SPKI_B64 = b64(hex(`3059301306072a8648ce3d020106082a8648ce3d03010703420004${'11'.repeat(32)}${'22'.repeat(32)}`));
const DER_B64 = b64(hex(`3026020107022100${'ff'.repeat(32)}`));

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

  it('signs the digest raw — the exact 32 bytes, never re-hashed', async () => {
    sign.mockResolvedValueOnce({ signature: DER_B64 });
    const digestBytes = new Uint8Array(32).fill(0xab);
    const digest = `0x${'ab'.repeat(32)}` as const;
    await expect(signWithDeviceKey(digest, { alias: ATTENDEE_KEY_ALIAS })).resolves.toEqual({
      r: `0x${'00'.repeat(31)}07`,
      s: `0x${'ff'.repeat(32)}`,
    });
    const sent = sign.mock.calls[0]![0] as { alias: string; data: string };
    expect(sent.alias).toBe('monti-attendee');
    // This is the safety-critical invariant: Ticket.checkIn verifies P256 over this digest.
    expect(sent.data).toBe(base64UrlEncode(digestBytes));
  });

  it('refuses to mint a biometric key on a backend that cannot enforce it', async () => {
    const { ensureDeviceKeyNative } = await import('./native');
    vi.doMock('./plugin', () => ({ generateKey, sign, loadKey, PLUGIN_SUPPORTS_ACCESS_CONTROL: false }));
    vi.resetModules();
    const { ensureDeviceKeyNative: guarded } = await import('./native');
    await expect(guarded({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true })).rejects.toThrow(
      'DeviceKeyPolicyUnsupported',
    );
    expect(ensureDeviceKeyNative).toBeTypeOf('function');
    vi.doUnmock('./plugin');
    vi.resetModules();
  });

  it('arms by signing a throwaway digest so the biometric context is retained for 60s', async () => {
    sign.mockResolvedValueOnce({ signature: DER_B64 });
    await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
    expect(sign).toHaveBeenCalled();
    expect(ARM_WINDOW_SECONDS).toBe(60);
  });
});
