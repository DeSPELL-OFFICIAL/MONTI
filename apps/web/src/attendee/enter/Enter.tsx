// Entry, step 1: arm, count down, read the gate code, prove the gate is real.
//
// Everything past `verifying` — signing the digest, writing the answer back, the QR fallback and
// the result — is Tasks 25 and 26. Those phases exist in `EnterPhase` and are rendered as
// placeholders here so the state machine is whole; nothing in this file signs anything.
import { useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import type { GateCodeWire } from '@monti/shared';
import { Alert, Button, Countdown, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { nfcCapability, readGateCode } from '../../shared/nfc';
import { IDLE, tapEnding, useArm, type EnterPhase } from './useArm';
import { verifyGate, type GateVerdict } from './verifyGate';

/** The phases that hold the armed window open, and so show the countdown. */
const ARMED_PHASES: readonly EnterPhase[] = ['armed', 'reading', 'verifying', 'signing', 'writing'];

/**
 * `ArmState.error` is a copy key, so the sentence is chosen here rather than carried around as a
 * string. Anything unrecognised falls back to the generic apology instead of rendering a key.
 */
function failureText(copy: Copy, error: string): string {
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
  };
  return sentences[error] ?? copy.common.error;
}

export function Enter() {
  const copy = useCopy();
  const { tokenId = '' } = useParams();
  const { state, setState, arm, isCurrent, windowSeconds } = useArm();
  // The open reader session, so the countdown can take it back. iOS keeps its sheet up for its
  // own 60 s, which always outlasts the arm window because the read starts after the biometric.
  const tap = useRef<AbortController | null>(null);

  const expire = useCallback((): void => {
    tap.current?.abort();
    tap.current = null;
    // The window belongs to the secure chip, so an expiry is final: back to idle with a
    // sentence, and the next arming is the person deciding to tap again.
    setState({ ...IDLE, error: 'expired' });
  }, [setState]);

  async function start(): Promise<void> {
    // Arming first, always: the biometric belongs to this tap, not to a reader sheet already up.
    const armedAt = await arm();
    if (!armedAt) return;
    if (nfcCapability() === 'none') {
      setState((prev) => ({ ...prev, phase: 'qr', error: 'deviceUnavailable' }));
      return;
    }

    const controller = new AbortController();
    tap.current = controller;
    setState((prev) => ({ ...prev, phase: 'reading' }));
    let wire: GateCodeWire;
    try {
      wire = await readGateCode({ signal: controller.signal });
    } catch (cause) {
      // An expiry aborts the read, so its rejection arrives on a window that is already gone.
      if (!isCurrent(armedAt)) return;
      setState((prev) => ({ ...prev, ...tapEnding(cause) }));
      return;
    } finally {
      if (tap.current === controller) tap.current = null;
    }
    if (!isCurrent(armedAt)) return;

    setState((prev) => ({ ...prev, phase: 'verifying' }));
    let verdict: GateVerdict;
    try {
      verdict = await verifyGate(wire, { tokenId });
    } catch {
      // Not the network — `verifyGate` answers those itself. A read that broke for any other
      // reason is this app's problem, and saying so beats inventing a verdict.
      if (!isCurrent(armedAt)) return;
      setState((prev) => ({ ...prev, phase: 'failed', error: '' }));
      return;
    }
    if (!isCurrent(armedAt)) return;
    if (!verdict.ok) {
      setState((prev) => ({ ...prev, phase: 'failed', error: verdict.reason }));
      return;
    }
    // Task 25 takes it from here: sign the check-in digest and write the answer back.
    setState((prev) => ({ ...prev, phase: 'signing', error: '' }));
  }

  const secondsLeft = state.armedAt
    ? Math.max(0, windowSeconds - Math.floor((Date.now() - state.armedAt) / 1000))
    : windowSeconds;

  return (
    <Screen title={copy.enter.cta}>
      {state.phase === 'idle' ? (
        <>
          {state.error ? <Alert tone="warn">{failureText(copy, state.error)}</Alert> : null}
          <Button onClick={() => void start()}>{copy.enter.cta}</Button>
        </>
      ) : null}

      {state.phase === 'arming' ? (
        <>
          <Spinner />
          <p>{copy.enter.arming}</p>
        </>
      ) : null}

      {ARMED_PHASES.includes(state.phase) ? (
        <>
          <Countdown seconds={secondsLeft} onExpire={expire}>
            {(left) => <p>{fmt(copy.enter.armed, { seconds: left })}</p>}
          </Countdown>
          <p>{state.phase === 'armed' || state.phase === 'reading' ? copy.enter.tapGuide : copy.enter.verifying}</p>
        </>
      ) : null}

      {/* Task 26 replaces this with the real code. */}
      {state.phase === 'qr' ? (
        <>
          <p>{copy.enter.qrTitle}</p>
          {state.error ? <Alert tone="info">{failureText(copy, state.error)}</Alert> : null}
        </>
      ) : null}

      {/* Task 25/26 own these; they are here so no phase renders an empty screen. */}
      {state.phase === 'waiting' ? <p>{copy.enter.resultWaiting}</p> : null}
      {state.phase === 'done' ? <p>{copy.enter.done}</p> : null}

      {state.phase === 'failed' ? (
        <>
          <Alert tone="error">{failureText(copy, state.error)}</Alert>
          <Button onClick={() => setState(IDLE)}>{copy.common.retry}</Button>
        </>
      ) : null}
    </Screen>
  );
}
