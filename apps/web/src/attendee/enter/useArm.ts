// The entry screen's state machine, and the one thing that must happen before any of it: the
// device key is armed.
//
// Spec §7.3 — `armDeviceKey` raises the biometric prompt once and the secure chip keeps the key
// usable for `ARM_WINDOW_SECONDS`. It runs on the person's tap and BEFORE the NFC session opens,
// for two reasons: iOS puts its reader sheet over everything, so a biometric prompt behind it is
// a dead screen; and a gate code read into a phone that then refuses to sign is a code burned
// for nothing. Nothing in here re-arms on its own — an expired window is the person tapping again.
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, armDeviceKey } from '../../shared/deviceKey';
import { NFC_ERROR, NfcError, type NfcErrorCode } from '../../shared/nfc';

export type EnterPhase =
  | 'idle'
  | 'arming'
  | 'armed'
  | 'reading'
  | 'verifying'
  | 'signing'
  | 'writing'
  | 'qr'
  | 'waiting'
  | 'done'
  | 'failed';

export interface ArmState {
  phase: EnterPhase;
  /** A copy key under `copy.enter`, never a sentence. `''` when there is nothing to say. */
  error: string;
  /** `Date.now()` of the biometric, or 0. The countdown is measured from here, not from a tick. */
  armedAt: number;
}

export interface PhaseEnding {
  phase: EnterPhase;
  error: string;
}

/**
 * Every way `shared/nfc` ends a tap, each with the phase and sentence it becomes. `unavailable`
 * is the only one that is not a failure: a phone with no NFC is told to show a code, not that
 * something went wrong. `nfcSessionEnd`'s three iOS reasons arrive here already mapped onto
 * `cancelled` / `timeout` / `readFailed` by `shared/nfc/native.ts`.
 */
const TAP_ENDING: Record<NfcErrorCode, PhaseEnding> = {
  [NFC_ERROR.unavailable]: { phase: 'qr', error: 'deviceUnavailable' },
  [NFC_ERROR.cancelled]: { phase: 'failed', error: 'tapCancelled' },
  [NFC_ERROR.timeout]: { phase: 'failed', error: 'tapTimeout' },
  [NFC_ERROR.noGateRecord]: { phase: 'failed', error: 'tapFailed' },
  [NFC_ERROR.readFailed]: { phase: 'failed', error: 'tapFailed' },
};

/** A rejection from the tap, as a phase. Anything that is not an `NfcError` is a failed read. */
export function tapEnding(cause: unknown): PhaseEnding {
  return cause instanceof NfcError ? TAP_ENDING[cause.code] : { phase: 'failed', error: 'tapFailed' };
}

export interface Arm {
  state: ArmState;
  setState: Dispatch<SetStateAction<ArmState>>;
  arm: () => Promise<boolean>;
  windowSeconds: number;
}

export const IDLE: ArmState = { phase: 'idle', error: '', armedAt: 0 };

export function useArm(): Arm {
  const [state, setState] = useState<ArmState>(IDLE);

  const arm = useCallback(async (): Promise<boolean> => {
    setState({ phase: 'arming', error: '', armedAt: 0 });
    try {
      await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
      setState({ phase: 'armed', error: '', armedAt: Date.now() });
      return true;
    } catch (cause) {
      // A browser has no non-syncing hardware key at all: that is the QR path, not an error.
      const unavailable = cause instanceof DeviceKeyUnavailable;
      setState({
        phase: unavailable ? 'qr' : 'failed',
        error: unavailable ? 'deviceUnavailable' : 'failed',
        armedAt: 0,
      });
      return false;
    }
  }, []);

  return { state, setState, arm, windowSeconds: ARM_WINDOW_SECONDS };
}
