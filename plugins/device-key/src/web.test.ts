import { describe, expect, it } from 'vitest';
import { DEVICE_KEY_ERROR, type DeviceKeyPlugin } from './definitions';
import { DeviceKeyWeb } from './web';

/**
 * The browser has no non-syncing hardware key, and a software key that pretends to be one is
 * worse than none: it would be registered on chain in the same field as a Secure Enclave key.
 * So every method rejects with the same typed code and there is no software fallback here.
 * Typing the instance as the interface also asserts the class still satisfies it.
 */
describe('DeviceKeyWeb', () => {
  const plugin: DeviceKeyPlugin = new DeviceKeyWeb();

  it('rejects generateKey with the unavailable code', async () => {
    await expect(plugin.generateKey({ tag: 't', accessControl: true, strongBox: true })).rejects.toMatchObject({
      code: DEVICE_KEY_ERROR.unavailable,
    });
  });

  it('rejects loadKey with the unavailable code, never with the not-found code', async () => {
    // KEY_NOT_FOUND means "mint one", and the web must never lead the caller there.
    await expect(plugin.loadKey({ tag: 't' })).rejects.toMatchObject({ code: DEVICE_KEY_ERROR.unavailable });
  });

  it('rejects sign with the unavailable code', async () => {
    await expect(plugin.sign({ tag: 't', data: 'AAAA' })).rejects.toMatchObject({
      code: DEVICE_KEY_ERROR.unavailable,
    });
  });

  it('carries the code as the message too, so an unhandled rejection still names it', async () => {
    await expect(plugin.sign({ tag: 't', data: 'AAAA' })).rejects.toThrow(DEVICE_KEY_ERROR.unavailable);
  });
});
