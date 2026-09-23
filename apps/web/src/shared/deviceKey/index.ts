import { Capacitor } from '@capacitor/core';
import type { Hex } from '@monti/shared';
import { armDeviceKeyNative, ensureDeviceKeyNative, signWithDeviceKeyNative } from './native';
import type { DeviceKeyOptions, DeviceKeyPublic } from './types';
import { armDeviceKeyWeb, ensureDeviceKeyWeb, signWithDeviceKeyWeb } from './web';

export * from './types';
export { DEVICE_KEY_ERROR, deviceKeyErrorCode, type DeviceKeyErrorCode } from './plugin';

/**
 * Where the private key lives. `software` is a browser's WebCrypto key: non-extractable, but
 * not hardware-bound and not proof of a device — enough to register an identity, never enough
 * to open a gate. Callers that need the entry guarantee check for `native`.
 */
export function deviceKeyCapability(): 'native' | 'software' {
  return Capacitor.isNativePlatform() ? 'native' : 'software';
}

export async function ensureDeviceKey(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  return deviceKeyCapability() === 'native' ? ensureDeviceKeyNative(options) : ensureDeviceKeyWeb(options);
}

export async function armDeviceKey(options: { alias: string }): Promise<void> {
  return deviceKeyCapability() === 'native' ? armDeviceKeyNative(options) : armDeviceKeyWeb();
}

export async function signWithDeviceKey(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  return deviceKeyCapability() === 'native'
    ? signWithDeviceKeyNative(digest, options)
    : signWithDeviceKeyWeb(digest, options);
}
