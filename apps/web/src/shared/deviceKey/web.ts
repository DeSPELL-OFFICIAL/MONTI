import { DeviceKeyUnavailable } from './types';

/** The web has no non-syncing hardware key. Attendees on a browser use the QR path. */
export async function ensureDeviceKeyWeb(): Promise<never> {
  throw new DeviceKeyUnavailable();
}

export async function armDeviceKeyWeb(): Promise<never> {
  throw new DeviceKeyUnavailable();
}

export async function signWithDeviceKeyWeb(): Promise<never> {
  throw new DeviceKeyUnavailable();
}
