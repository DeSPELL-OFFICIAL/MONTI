import { WebPlugin } from '@capacitor/core';
import {
  DEVICE_KEY_ERROR,
  type DeviceKeyErrorCode,
  type DeviceKeyPlugin,
  type DeviceKeyResult,
  type SignResult,
} from './definitions';

/** The code doubles as the message: no prose here, and an unhandled rejection still names it. */
function deviceKeyError(code: DeviceKeyErrorCode): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * There is no software fallback, deliberately. A WebCrypto key is syncable and extractable,
 * so registering one on chain under the same contract field as a Secure Enclave key would
 * quietly weaken every ticket. Attendees on a browser take the QR path instead.
 */
export class DeviceKeyWeb extends WebPlugin implements DeviceKeyPlugin {
  async generateKey(): Promise<DeviceKeyResult> {
    throw deviceKeyError(DEVICE_KEY_ERROR.unavailable);
  }

  /** Not `KEY_NOT_FOUND`: that code means "mint one", and the web must never lead there. */
  async loadKey(): Promise<DeviceKeyResult> {
    throw deviceKeyError(DEVICE_KEY_ERROR.unavailable);
  }

  async sign(): Promise<SignResult> {
    throw deviceKeyError(DEVICE_KEY_ERROR.unavailable);
  }
}
