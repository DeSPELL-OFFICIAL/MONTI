import { describe, expect, it, vi } from 'vitest';

const generateKeyNative = vi.fn();
const loadKeyNative = vi.fn();
const signNative = vi.fn();

// Only `DeviceKey` is replaced; DEVICE_KEY_ERROR stays the real one, so these tests fail if the
// plugin ever renames a code rather than silently agreeing with a mock.
vi.mock('@monti/device-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@monti/device-key')>()),
  DeviceKey: { generateKey: generateKeyNative, loadKey: loadKeyNative, sign: signNative },
}));

const { DEVICE_KEY_ERROR } = await import('@monti/device-key');
const { generateKey, loadKey, sign } = await import('./plugin');

const SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE';

/** The shape a Capacitor native rejection arrives in: an Error carrying a `code`. */
function nativeRejection(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('device key plugin adapter', () => {
  it('translates the alias and the auth policy into the plugin wire names', async () => {
    generateKeyNative.mockResolvedValueOnce({ publicKey: SPKI, backing: 'secureEnclave' });
    await expect(generateKey({ alias: 'monti-attendee', requireAuth: true, strongBox: true })).resolves.toEqual({
      publicKey: SPKI,
      backing: 'secureEnclave',
    });
    expect(generateKeyNative).toHaveBeenCalledWith({ tag: 'monti-attendee', accessControl: true, strongBox: true });
  });

  it('passes an unattended key through as accessControl false, never as a default', async () => {
    generateKeyNative.mockResolvedValueOnce({ publicKey: SPKI, backing: 'tee' });
    await generateKey({ alias: 'monti-gate', requireAuth: false, strongBox: false });
    expect(generateKeyNative).toHaveBeenCalledWith({ tag: 'monti-gate', accessControl: false, strongBox: false });
  });

  it('carries the backing through, so a StrongBox downgrade reaches the caller', async () => {
    loadKeyNative.mockResolvedValueOnce({ publicKey: SPKI, backing: 'tee' });
    await expect(loadKey({ alias: 'monti-gate' })).resolves.toEqual({ publicKey: SPKI, backing: 'tee' });
  });

  it('refuses a response with no public key rather than pass an empty one on', async () => {
    generateKeyNative.mockResolvedValueOnce({ backing: 'tee' });
    await expect(generateKey({ alias: 'monti-gate', requireAuth: false, strongBox: true })).rejects.toThrow(
      'no public key',
    );
  });

  it('maps the not-found code to null — the one result that may mint a key', async () => {
    loadKeyNative.mockRejectedValueOnce(nativeRejection(DEVICE_KEY_ERROR.keyNotFound));
    await expect(loadKey({ alias: 'monti-attendee' })).resolves.toBeNull();
  });

  it('rethrows a cancelled prompt instead of reading it as "no key yet"', async () => {
    // Turning this into null would rotate a key that is already registered on chain, which is
    // unrecoverable — so every code but KEY_NOT_FOUND must propagate untouched.
    loadKeyNative.mockRejectedValueOnce(nativeRejection(DEVICE_KEY_ERROR.userCancelled));
    await expect(loadKey({ alias: 'monti-attendee' })).rejects.toMatchObject({
      code: DEVICE_KEY_ERROR.userCancelled,
    });
  });

  it('rethrows a rejection that carries no code at all', async () => {
    loadKeyNative.mockRejectedValueOnce(new Error('bridge died'));
    await expect(loadKey({ alias: 'monti-attendee' })).rejects.toThrow('bridge died');
  });

  it('hands the digest to the plugin byte for byte and returns the signature', async () => {
    signNative.mockResolvedValueOnce({ signature: 'MEUCIQ' });
    await expect(sign({ alias: 'monti-attendee', data: 'q6urqw' })).resolves.toEqual({ signature: 'MEUCIQ' });
    expect(signNative).toHaveBeenCalledWith({ tag: 'monti-attendee', data: 'q6urqw' });
  });

  it('refuses a sign response with no signature', async () => {
    signNative.mockResolvedValueOnce({});
    await expect(sign({ alias: 'monti-attendee', data: 'q6urqw' })).rejects.toThrow('no signature');
  });
});
