import { Capacitor } from '@capacitor/core';
import type { Hex } from '@monti/shared';
import { armDeviceKeyNative, ensureDeviceKeyNative, signWithDeviceKeyNative } from './native';
import type { DeviceKeyOptions, DeviceKeyPublic } from './types';
import { armDeviceKeyWeb, ensureDeviceKeyWeb, signWithDeviceKeyWeb } from './web';

export * from './types';
export { DEVICE_KEY_ERROR, deviceKeyErrorCode, type DeviceKeyErrorCode } from './plugin';

export function deviceKeyCapability(): 'native' | 'none' {
  return Capacitor.isNativePlatform() ? 'native' : 'none';
}

export async function ensureDeviceKey(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  return deviceKeyCapability() === 'native' ? ensureDeviceKeyNative(options) : ensureDeviceKeyWeb();
}

export async function armDeviceKey(options: { alias: string }): Promise<void> {
  return deviceKeyCapability() === 'native' ? armDeviceKeyNative(options) : armDeviceKeyWeb();
}

export async function signWithDeviceKey(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  return deviceKeyCapability() === 'native' ? signWithDeviceKeyNative(digest, options) : signWithDeviceKeyWeb();
}
