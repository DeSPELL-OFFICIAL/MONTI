import type { Hex } from '@monti/shared';

export class DeviceKeyUnavailable extends Error {
  constructor() {
    super('DeviceKeyUnavailable');
    this.name = 'DeviceKeyUnavailable';
  }
}

/** The active native backend cannot enforce `requireAuth`, so the key would be unprotected. */
export class DeviceKeyPolicyUnsupported extends Error {
  constructor(readonly alias: string) {
    super(`DeviceKeyPolicyUnsupported: backend cannot enforce biometric access control for ${alias}`);
    this.name = 'DeviceKeyPolicyUnsupported';
  }
}

export interface DeviceKeyPublic {
  x: Hex;
  y: Hex;
}

export interface DeviceKeyOptions {
  alias: string;
  requireAuth: boolean;
  strongBox: boolean;
}

/** Attendee entry key: biometric-gated, never synced. */
export const ATTENDEE_KEY_ALIAS = 'monti-attendee';
/** Gate device key (sub-plan 04): no biometric prompt, the staff device signs unattended. */
export const GATE_KEY_ALIAS = 'monti-gate';
/** Spec 7.3: the biometric arming window is 60 seconds, enforced by the secure chip. */
export const ARM_WINDOW_SECONDS = 60;
