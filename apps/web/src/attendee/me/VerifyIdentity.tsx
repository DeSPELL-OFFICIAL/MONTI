import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { safeReturnTo } from '../../shared/returnTo';
import {
  KYC_WEB_MARKER,
  KYC_WEB_MARKER_DONE,
  closeHostedFlow,
  isKycCallback,
  listenDeepLink,
  openHostedFlow,
} from '../../shared/api/deepLink';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45; // 90 seconds

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
    setPolling(true);
    for (let attempt = 0; attempt < POLL_LIMIT && alive(); attempt += 1) {
      // A dropped call is a missed tick, not a verdict: it must never throw out of the effect and
      // leave the screen spinning with the button disabled and no way back.
      const snapshot = await api.getSignupStatus().catch(() => null);
      if (!alive()) return;
      if (snapshot !== null) {
        const { status, kycLevel, reason } = snapshot;
        if (kycLevel >= 1) {
          await queryClient.invalidateQueries({ queryKey: ['kycLevel'] });
          navigate(returnTo, { replace: true });
          return;
        }
        if (status === 'rejected') {
          // M acceptance 1: the same face on a second phone must read "이미 계정이 있습니다".
          // Every other reason the server can send collapses into one sentence; the vendor's own
          // wording never reaches the screen.
          setError(reason === 'duplicate_face' ? copy.kyc.duplicate : copy.kyc.rejected);
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
    try {
      const { kycUrl } = await api.startKyc();
      // Polling waits for the return. On native `Browser.open` resolves on presentation, not on
      // dismissal, so starting here would burn the whole 90 s ceiling while the person is still
      // holding up their ID; on the web this tab leaves for the hosted page altogether.
      await openHostedFlow(kycUrl);
    } catch {
      setError(copy.common.error);
    }
  }

  return (
    <Screen title={copy.kyc.title}>
      <p>{copy.kyc.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {timedOut ? <Alert tone="warn">{copy.kyc.timeout}</Alert> : null}
      {polling ? <><Spinner /><p>{copy.kyc.waiting}</p></> : null}
      {timedOut ? (
        <Button variant="ghost" onClick={() => void poll()}>{copy.common.retry}</Button>
      ) : null}
      <Button onClick={start} disabled={polling}>{copy.kyc.cta}</Button>
    </Screen>
  );
}
