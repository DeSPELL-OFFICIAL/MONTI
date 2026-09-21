// Entry: one tap, one NFC session.
//
// The ordering is the security property and the usability one at once. The biometric is raised
// on the person's click and BEFORE the session opens: iOS puts its reader sheet over
// everything, so a prompt behind it is a dead screen, and a gate code read by a phone that then
// refuses to sign is a code burned for nothing. Once the session is open nothing may prompt —
// `readThenWrite` reads the gate's record, hands it to the signer, and writes the answer back
// to the same tag before the session ends, all while the two phones are still touching.
//
// Everything past the write belongs to <Result />: the phase machine here ends at `waiting`,
// and the green, the refusal and the waiting deadline are reconciled there from the chain and
// the push.
import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { Alert, Button, Countdown, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import { nfcCapability, readThenWrite } from '../../shared/nfc';
import { IDLE, failureText, useArm, type EnterPhase } from './useArm';
import { tapFailure, tapSigner } from './buildResponse';
import { Qr } from './Qr';
import { Result } from './Result';

/** The phases that hold the armed window open, and so show the countdown. */
const ARMED_PHASES: readonly EnterPhase[] = ['armed', 'reading', 'verifying', 'signing', 'writing'];

export function Enter() {
  const copy = useCopy();
  const { tokenId = '' } = useParams();
  const { state, setState, arm, isCurrent, windowSeconds } = useArm();
  // Held from the read onwards: the QR fallback answers the same code the tap read, and there
  // is no second chance to get it — the reader has already rotated by the time it is needed.
  const [gateCode, setGateCode] = useState<GateCodeWire | null>(null);
  // The answer the tap built. If the write failed, this is what the code on screen shows —
  // the same bytes, rather than a second signature over the same digest.
  const [response, setResponse] = useState<GateResponseWire | null>(null);
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
      // Out of MVP scope, and it cannot be papered over: the code the staff scan is a device
      // signature over the gate's one-time code, which only a tap can deliver.
      setState((prev) => ({ ...prev, phase: 'failed', error: 'deviceUnavailable' }));
      return;
    }

    setGateCode(null);
    setResponse(null);
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
          onResponse: setResponse,
        }),
        { signal: controller.signal },
      );
    } catch (cause) {
      if (!isCurrent(armedAt)) return;
      setState((prev) => ({ ...prev, ...tapFailure(cause, read !== null) }));
      return;
    } finally {
      // Cleared only once `readThenWrite` has settled: the session stays open through verify,
      // sign and write, and `expire()` must be able to take back one that is mid-write.
      if (tap.current === controller) tap.current = null;
    }
    if (!isCurrent(armedAt)) return;

    // The session ended AFTER the write landed, which is the success: spec §7.2 step 4 wants one
    // buzz here and nothing more. Whether the entry was granted comes from <Result />.
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
          {gateCode ? (
            <Qr tokenId={tokenId} gateCode={gateCode} wire={response} onExpire={expire} />
          ) : null}
        </>
      ) : null}

      {/* The tap is over; <Result /> owns everything after it, deadline included. */}
      {state.phase === 'waiting' ? <Result tokenId={tokenId} /> : null}

      {state.phase === 'failed' ? (
        <>
          <Alert tone="error">{failureText(copy, state.error)}</Alert>
          <Button onClick={() => setState(IDLE)}>{copy.common.retry}</Button>
        </>
      ) : null}
    </Screen>
  );
}
