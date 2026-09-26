// The entry screen's state machine, and the one thing that must happen before any of it: the
// device key is armed.
//
// Spec §7.3 — `armDeviceKey` raises the biometric prompt once and the secure chip keeps the key
// usable for `ARM_WINDOW_SECONDS`. It runs on the person's tap and BEFORE the NFC session opens,
// for two reasons: iOS puts its reader sheet over everything, so a biometric prompt behind it is
// a dead screen; and a gate code read into a phone that then refuses to sign is a code burned
// for nothing. Nothing in here re-arms on its own — an expired window is the person tapping again.
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Copy } from '../../shared/copy/index';
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
  /** The answer is on the tag. From here <Result /> decides, not this machine. */
  | 'waiting'
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
 * Every way `shared/nfc` ends a tap, each with the phase and sentence it becomes.
 * `nfcSessionEnd`'s three iOS reasons arrive here already mapped onto `cancelled` / `timeout` /
 * `readFailed` by `shared/nfc/native.ts`.
 *
 * `unavailable` is a plain refusal, not a fallback: the QR carries a device signature over the
 * gate's code, so a phone that never read a code has nothing to show. Entering without NFC is
 * outside the MVP, and saying so is better than a screen that cannot work.
 */
const TAP_ENDING: Record<NfcErrorCode, PhaseEnding> = {
  [NFC_ERROR.unavailable]: { phase: 'failed', error: 'deviceUnavailable' },
  [NFC_ERROR.cancelled]: { phase: 'failed', error: 'tapCancelled' },
  [NFC_ERROR.timeout]: { phase: 'failed', error: 'tapTimeout' },
  [NFC_ERROR.noGateRecord]: { phase: 'failed', error: 'tapFailed' },
  [NFC_ERROR.readFailed]: { phase: 'failed', error: 'tapFailed' },
};

/**
 * `ArmState.error` is a copy key, so the sentence is chosen in one place rather than carried
 * around as a string. Anything unrecognised falls back to the generic apology instead of
 * rendering a key. Both `<Enter />` and `<Qr />` read it, which is why it lives beside the
 * taxonomy it translates and not inside either screen.
 */
export function failureText(copy: Copy, error: string): string {
  const sentences: Record<string, string> = {
    deviceUnavailable: copy.enter.deviceUnavailable,
    expired: copy.enter.expired,
    unknownGate: copy.enter.unknownGate,
    gateClosed: copy.enter.gateClosed,
    wrongEvent: copy.enter.wrongEvent,
    badSignature: copy.enter.badSignature,
    codeExpired: copy.enter.codeExpired,
    tapCancelled: copy.enter.tapCancelled,
    tapTimeout: copy.enter.tapTimeout,
    tapFailed: copy.enter.tapFailed,
    armFailed: copy.enter.armFailed,
    signFailed: copy.enter.signFailed,
    keyInvalidated: copy.enter.keyInvalidated,
    deviceMismatch: copy.enter.deviceMismatch,
    writeFailed: copy.enter.writeFailed,
  };
  return sentences[error] ?? copy.common.error;
}

/** A rejection from the tap, as a phase. Anything that is not an `NfcError` is a failed read. */
export function tapEnding(cause: unknown): PhaseEnding {
  return cause instanceof NfcError ? TAP_ENDING[cause.code] : { phase: 'failed', error: 'tapFailed' };
}

export interface Arm {
  state: ArmState;
  setState: Dispatch<SetStateAction<ArmState>>;
  /** The `armedAt` stamp of the window this call opened, or 0 if it did not open one. */
  arm: () => Promise<number>;
  /**
   * Is `armedAt` still the window the chip is holding open? Every step of the tap runs behind
   * an `await`, and the countdown can expire inside any of them: a late `readGateCode` or a
   * late verification must not put a closed window back on screen, and Task 25 must not sign
   * with a key the chip has already re-locked. Backed by a ref, never by the render's state,
   * so an async closure asking this question gets today's answer and not the one it captured.
   */
  isCurrent: (armedAt: number) => boolean;
  windowSeconds: number;
}

export const IDLE: ArmState = { phase: 'idle', error: '', armedAt: 0 };

export function useArm(): Arm {
  const [state, setRenderState] = useState<ArmState>(IDLE);
  // The state as the tap's async steps see it. React applies a queued updater when it next
  // renders, which is one or more microtasks after the call — far too late for the step that
  // is about to ask whether its window is still open. So the next state is computed here,
  // eagerly, and React is handed the finished value.
  const stateRef = useRef<ArmState>(IDLE);

  const setState = useCallback<Dispatch<SetStateAction<ArmState>>>((update) => {
    const next = typeof update === 'function' ? (update as (value: ArmState) => ArmState)(stateRef.current) : update;
    stateRef.current = next;
    setRenderState(next);
  }, []);

  const isCurrent = useCallback(
    (armedAt: number): boolean => armedAt !== 0 && stateRef.current.armedAt === armedAt,
    [],
  );

  const arm = useCallback(async (): Promise<number> => {
    setState({ phase: 'arming', error: '', armedAt: 0 });
    try {
      await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
      const armedAt = Date.now();
      setState({ phase: 'armed', error: '', armedAt });
      return armedAt;
    } catch (cause) {
      // A browser has no non-syncing hardware key at all: that is the QR path, not an error.
      // A browser with no non-syncing hardware key cannot produce a signature at all, and the
      // QR carries a signature — so there is nothing to fall back to, only something to explain.
      setState({
        phase: 'failed',
        error: cause instanceof DeviceKeyUnavailable ? 'deviceUnavailable' : 'armFailed',
        armedAt: 0,
      });
      return 0;
    }
  }, [setState]);

  return { state, setState, arm, isCurrent, windowSeconds: ARM_WINDOW_SECONDS };
}
