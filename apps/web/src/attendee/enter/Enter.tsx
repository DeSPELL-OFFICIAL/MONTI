// Entry: one tap, one NFC session.
//
// The ordering is the security property and the usability one at once. The biometric is raised
// on the person's click and BEFORE the session opens: iOS puts its reader sheet over
// everything, so a prompt behind it is a dead screen, and a gate code read by a phone that then
// refuses to sign is a code burned for nothing. Once the session is open nothing may prompt —
// `readThenWrite` reads the gate's record, hands it to the signer, and writes the answer back
// to the same tag before the session ends, all while the two phones are still touching.
//
// Everything past the write — the green, the chain subscription — is Task 26.
import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { GateCodeWire } from '@monti/shared';
import { Alert, Button, Countdown, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { nfcCapability, readThenWrite } from '../../shared/nfc';
import { IDLE, useArm, type EnterPhase } from './useArm';
import { tapFailure, tapSigner } from './buildResponse';
import { Qr } from './Qr';

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
    signFailed: copy.enter.signFailed,
    keyInvalidated: copy.enter.keyInvalidated,
    deviceMismatch: copy.enter.deviceMismatch,
    writeFailed: copy.enter.writeFailed,
  };
  return sentences[error] ?? copy.common.error;
}

export function Enter() {
  const copy = useCopy();
  const { tokenId = '' } = useParams();
  const { state, setState, arm, isCurrent, windowSeconds } = useArm();
  // Held from the read onwards: the QR fallback answers the same code the tap read, and there
  // is no second chance to get it — the reader has already rotated by the time it is needed.
  const [gateCode, setGateCode] = useState<GateCodeWire | null>(null);
  // The open session, so the countdown can take it back rather than leave a sheet up over a
  // window the secure chip has already closed.
  const tap = useRef<AbortController | null>(null);

  const expire = useCallback((): void => {
    tap.current?.abort();
    tap.current = null;
    // The window belongs to the secure chip, so an expiry is final: back to idle with a
    // sentence, and the next arming is the person deciding to tap again.
    setState({ ...IDLE, error: 'expired' });
  }, [setState]);

  async function start(): Promise<void> {
    const armedAt = await arm();
    if (!armedAt) return;
    if (nfcCapability() === 'none') {
      setState((prev) => ({ ...prev, phase: 'qr', error: 'deviceUnavailable' }));
      return;
    }

    setGateCode(null);
    // Local, because `gateCode` state is not readable from inside this closure and the failure
    // taxonomy turns on whether a code was ever read.
    let read: GateCodeWire | null = null;
    const controller = new AbortController();
    tap.current = controller;
    setState((prev) => ({ ...prev, phase: 'reading', error: '' }));

    try {
      await readThenWrite(
        tapSigner({
          tokenId,
          setState,
          armedAt,
          isCurrent,
          onGateCode: (code) => {
            read = code;
            setGateCode(code);
          },
        }),
        { signal: controller.signal },
      );
    } catch (cause) {
      if (!isCurrent(armedAt)) return;
      setState((prev) => ({ ...prev, ...tapFailure(cause, read !== null) }));
      return;
    } finally {
      if (tap.current === controller) tap.current = null;
    }
    if (!isCurrent(armedAt)) return;

    // The session ended AFTER the write landed, which is the success: spec §7.2 step 4 wants one
    // buzz here and nothing more. Whether the entry was granted comes from the chain (Task 26).
    if (navigator.vibrate) navigator.vibrate(60);
    setState((prev) => ({ ...prev, phase: 'waiting', error: '' }));
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

      {state.phase === 'qr' ? (
        <>
          <p>{copy.enter.qrTitle}</p>
          {state.error ? <Alert tone="info">{failureText(copy, state.error)}</Alert> : null}
          {/* Without a code there is nothing to answer: a phone with no NFC never read one. */}
          {gateCode ? <Qr tokenId={tokenId} gateCode={gateCode} onExpire={expire} /> : null}
        </>
      ) : null}

      {/* Task 26 owns these; they are here so no phase renders an empty screen. */}
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
