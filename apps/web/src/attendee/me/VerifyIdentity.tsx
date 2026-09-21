import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Browser } from '@capacitor/browser';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { listenDeepLink } from '../../shared/api/deepLink';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45; // 90 seconds

/**
 * A native return arrives as `monti://kyc/callback`. On the web there is no custom scheme, so the
 * hosted page sends the browser back to this screen and the focus listener hands us that address;
 * `didit=done` is the marker the server puts on that return URL.
 */
function isKycCallback(url: string): boolean {
  return url.includes('kyc/callback') || url.includes('didit=done');
}

export function VerifyIdentity() {
  const copy = useCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo') ?? '/me';
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const stopped = useRef(false);
  const run = useRef(0);

  // Leaving the screen ends every loop, and a later run supersedes an earlier one instead of
  // doubling the request rate when the deep link lands on top of a poll already in flight.
  useEffect(() => () => {
    stopped.current = true;
    run.current += 1;
  }, []);

  const poll = useCallback(async () => {
    run.current += 1;
    const mine = run.current;
    const alive = () => !stopped.current && run.current === mine;
    setPolling(true);
    for (let attempt = 0; attempt < POLL_LIMIT && alive(); attempt += 1) {
      const { status, kycLevel, reason } = await api.getSignupStatus();
      if (!alive()) return;
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
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (alive()) setPolling(false);
  }, [navigate, queryClient, returnTo, copy.kyc.duplicate, copy.kyc.rejected]);

  useEffect(() => {
    let remove: (() => void) | null = null;
    let cancelled = false;
    void listenDeepLink((url) => {
      if (!isKycCallback(url)) return;
      void Browser.close().catch(() => undefined);
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
    try {
      const { kycUrl } = await api.startKyc();
      await Browser.open({ url: kycUrl, presentationStyle: 'popover' });
      void poll();
    } catch {
      setError(copy.common.error);
    }
  }

  return (
    <Screen title={copy.kyc.title}>
      <p>{copy.kyc.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {polling ? <><Spinner /><p>{copy.kyc.waiting}</p></> : null}
      <Button onClick={start} disabled={polling}>{copy.kyc.cta}</Button>
    </Screen>
  );
}
