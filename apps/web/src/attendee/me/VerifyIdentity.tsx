import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, ContactLink, Screen, Spinner, StickyBar } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api, callableFailure } from '../../shared/api/functions';
import { safeReturnTo } from '../../shared/returnTo';
import {
  KYC_WEB_MARKER,
  KYC_WEB_MARKER_DONE,
  closeHostedFlow,
  isKycCallback,
  kycCallbackUrl,
  listenDeepLink,
  openHostedFlow,
} from '../../shared/api/deepLink';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45; // 90 seconds

/**
 * Another call of this person's is already opening a session and holds the 60-second claim
 * (`functions/src/lib/kycSession.ts`). It is the one refusal that fixes itself: a second tap
 * after the claim lapses goes through, so it gets "wait a moment and try again" and a button,
 * not the generic sentence that tells somebody to go away and hope.
 */
function isSessionInFlight(cause: unknown): boolean {
  const { code, reason } = callableFailure(cause);
  return code === 'aborted' || reason === 'KYC_SESSION_IN_FLIGHT';
}

export function VerifyIdentity() {
  const copy = useCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setSearchParams] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'), '/me');
  const returnedOnWeb = params.get(KYC_WEB_MARKER) === KYC_WEB_MARKER_DONE;
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const stopped = useRef(false);
  const run = useRef(0);

  // StrictMode remounts on the same fiber, so refs survive the simulated unmount: the latch has to
  // be lifted on every setup or the screen is dead for the rest of its life in development.
  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
      run.current += 1;
    };
  }, []);

  const poll = useCallback(async () => {
    run.current += 1;
    const mine = run.current;
    const alive = () => !stopped.current && run.current === mine;
    setError('');
    setTimedOut(false);
    setInFlight(false);
    setPolling(true);
    for (let attempt = 0; attempt < POLL_LIMIT && alive(); attempt += 1) {
      // A dropped call is a missed tick, not a verdict: it must never throw out of the effect and
      // leave the screen spinning with the button disabled and no way back.
      const snapshot = await api.getSignupStatus().catch(() => null);
      if (!alive()) return;
      if (snapshot !== null) {
        const { status, kycLevel, kycReason } = snapshot;
        if ((kycLevel ?? 0) >= 1) {
          await queryClient.invalidateQueries({ queryKey: ['kycLevel'] });
          navigate(returnTo, { replace: true });
          return;
        }
        if (status === 'rejected') {
          // M acceptance 1: the same face on a second phone must read "이미 계정이 있습니다".
          // Every other reason the server can send collapses into one sentence; the vendor's own
          // wording never reaches the screen.
          setError(kycReason === 'duplicate_face' ? copy.kyc.duplicate : copy.kyc.rejected);
          setPolling(false);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // The ceiling is not a failure — the webhook may simply be late — so it offers another look.
    if (alive()) {
      setTimedOut(true);
      setPolling(false);
    }
  }, [navigate, queryClient, returnTo, copy.kyc.duplicate, copy.kyc.rejected]);

  // The web leg comes back as a plain page load, so the marker is read here rather than heard.
  useEffect(() => {
    if (!returnedOnWeb) return;
    // Strip it first: a refresh or a later window focus must not re-enter the flow.
    const next = new URLSearchParams(params);
    next.delete(KYC_WEB_MARKER);
    setSearchParams(next, { replace: true });
    void poll();
  }, [returnedOnWeb, params, setSearchParams, poll]);

  useEffect(() => {
    let remove: (() => void) | null = null;
    let cancelled = false;
    void listenDeepLink((url) => {
      if (!isKycCallback(url)) return;
      void closeHostedFlow();
      void poll();
    }).then((fn) => {
      // The screen can go away before the plugin answers; the listener still has to be dropped.
      if (cancelled) fn();
      else remove = fn;
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [poll]);

  async function start() {
    setError('');
    setTimedOut(false);
    setInFlight(false);
    try {
      // Without this the server falls back to `https://<rp>/kyc/callback` and the `returnTo`
      // is lost with it — on the web that drops a verified person on the explore tab.
      const callbackUrl = kycCallbackUrl(returnTo);
      const { kycUrl } = await api.startKyc(callbackUrl === undefined ? undefined : { callbackUrl });
      // Polling waits for the return. On native `Browser.open` resolves on presentation, not on
      // dismissal, so starting here would burn the whole 90 s ceiling while the person is still
      // holding up their ID; on the web this tab leaves for the hosted page altogether.
      await openHostedFlow(kycUrl);
    } catch (cause) {
      const busy = isSessionInFlight(cause);
      setError(busy ? copy.kyc.inFlight : copy.common.error);
      setInFlight(busy);
    }
  }

  return (
    <Screen title={copy.kyc.title}>
      <p>{copy.kyc.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* A refused check is the one place in the app a person cannot help themselves out of:
          the verdict came from the vendor and no button on this screen can change it. */}
      {error ? <ContactLink /> : null}
      {timedOut ? <Alert tone="warn">{copy.kyc.timeout}</Alert> : null}
      {polling ? <><Spinner /><p>{copy.kyc.waiting}</p></> : null}
      {timedOut ? (
        <Button variant="ghost" onClick={() => void poll()}>{copy.common.retry}</Button>
      ) : null}
      {/* Never up at the same time as the one above: both `start` and `poll` clear the other's
          flag before they run, so there is only ever one "try again" on the screen. */}
      {inFlight ? (
        <Button variant="ghost" onClick={() => void start()}>{copy.common.retry}</Button>
      ) : null}
      {/* An explicit way out to wherever they came from (returnTo). A deep-link landing may have no
          history for the global back bar to pop, so verification is never a place a person is stuck. */}
      {polling ? null : (
        <Button variant="ghost" onClick={() => navigate(returnTo)}>{copy.kyc.later}</Button>
      )}
      {/* 주행동은 하단 바로 내려가 화면 아래 절반이 비지 않게 한다(visual R1-5). 확인 중에는 잠긴 채로. */}
      <StickyBar>
        <Button onClick={start} disabled={polling}>{copy.kyc.cta}</Button>
      </StickyBar>
    </Screen>
  );
}
