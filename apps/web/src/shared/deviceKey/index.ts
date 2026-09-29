import { Capacitor } from '@capacitor/core';
import type { Hex } from '@monti/shared';
import { armDeviceKeyNative, ensureDeviceKeyNative, peekDeviceKeyNative, signWithDeviceKeyNative } from './native';
import type { DeviceKeyOptions, DeviceKeyPublic } from './types';
import { armDeviceKeyWeb, deleteDeviceKeyWeb, ensureDeviceKeyWeb, peekDeviceKeyWeb, signWithDeviceKeyWeb } from './web';

export * from './types';
export { DEVICE_KEY_ERROR, deviceKeyErrorCode, type DeviceKeyErrorCode } from './plugin';
export { verifyDeviceSignature } from './verify';

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

/**
 * The device key already on this device, or `null` when there is none — read-only, so unlike
 * {@link ensureDeviceKey} it never mints one. The device-key health check reads it to decide
 * whether a synced-passkey login has a usable key on this browser at all.
 */
export async function peekDeviceKey(options: { alias: string }): Promise<DeviceKeyPublic | null> {
  return deviceKeyCapability() === 'native' ? peekDeviceKeyNative(options) : peekDeviceKeyWeb(options);
}

/**
 * Discards this device's stored key so the next {@link ensureDeviceKey} mints a fresh one. Only
 * the browser's software key is dropped: a new-phone recovery has no secure-element key to begin
 * with, and rotating a live one is out of scope here.
 */
export async function resetDeviceKey(options: { alias: string }): Promise<void> {
  if (deviceKeyCapability() === 'software') await deleteDeviceKeyWeb(options);
}
