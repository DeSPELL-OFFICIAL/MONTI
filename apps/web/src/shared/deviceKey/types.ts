import type { Hex } from '@monti/shared';

export class DeviceKeyUnavailable extends Error {
  constructor() {
    super('DeviceKeyUnavailable');
    this.name = 'DeviceKeyUnavailable';
  }
}

/** The active native backend cannot honour the policy the caller asked for. */
export class DeviceKeyPolicyUnsupported extends Error {
  constructor(
    readonly alias: string,
    readonly reason: string,
  ) {
    super(`DeviceKeyPolicyUnsupported: ${reason} for ${alias}`);
    this.name = 'DeviceKeyPolicyUnsupported';
  }
}

/** Where the private key actually lives. Android may downgrade StrongBox to TEE silently. */
export type DeviceKeyBacking = 'secureEnclave' | 'strongBox' | 'tee';

export interface DeviceKeyPublic {
  x: Hex;
  y: Hex;
  /** Absent when the backend cannot report it; never assume StrongBox from silence. */
  backing?: DeviceKeyBacking;
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
