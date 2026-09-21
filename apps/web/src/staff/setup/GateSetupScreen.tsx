import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

import { fmt } from '../../shared/i18n';
import { Alert, Button, Field, Screen, Spinner } from '../../shared/ui';
import { SEEDED_EVENT_ID } from '../constants';
import { useStaffSetupCopy, type StaffSetupCopy } from './copy';
import { gatePayloadText, useGateRegistration, type GateSetupError } from './useGateRegistration';

const DIGITS_ONLY = /\D/g;

/** Each typed failure gets its own sentence; none of them is "something went wrong". */
const ERROR_LINE: Record<GateSetupError, keyof StaffSetupCopy> = {
  KEY_UNAVAILABLE: 'errKeyUnavailable',
  AUTH_REQUIRED: 'errAuthRequired',
  SUBMIT_REJECTED: 'errSubmitRejected',
  CHAIN_UNREACHABLE: 'errChainUnreachable',
};

/**
 * Whole seconds since the application was accepted. A staff member watching a phone that says
 * only "waiting" cannot tell a slow organizer from a dead screen; a number that moves can.
 */
function useElapsedSeconds(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** The fallback code. Rendered from the submitted payload, never from a second spelling of it. */
function PayloadQr({ text, alt }: { text: string; alt: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    // `type: 'svg'` keeps this off canvas, which a WebView kiosk may not give us.
    void QRCode.toString(text, { type: 'svg', margin: 1 })
      .then((markup) => {
        if (alive) setSvg(markup);
      })
      .catch(() => {
        if (alive) setSvg('');
      });
    return () => {
      alive = false;
    };
  }, [text]);
  if (svg === '') return null;
  return (
    <div
      className="gate-setup__qr"
      role="img"
      aria-label={alt}
      // Our own markup, produced by `qrcode` from a string this module built.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * 스태프가 단말기를 게이트로 등록하는 화면(스펙 §5.7-1).
 *
 * 화면이 하는 일은 두 가지다. 단말기가 만든 계정과 공개키를 **직접 신청**하고, 등록됐는지를
 * 체인의 `gateOf` 에 계속 물어본다. 신청이 막혀도 화면은 멈추지 않는다 — 같은 값을 QR 과
 * 글자로 띄워 두고, 관리자가 손으로 등록하면 폴링이 그걸 알아본다.
 */
export function GateSetupScreen() {
  const copy = useStaffSetupCopy();
  // The event the device is applying for. Separate from the field's text on purpose: a hook
  // keyed on every keystroke would send an application per character typed.
  const [chosenEventId, setChosenEventId] = useState<string>(SEEDED_EVENT_ID);
  const [draft, setDraft] = useState<string>(SEEDED_EVENT_ID);
  const registration = useGateRegistration({ eventId: chosenEventId });
  const elapsed = useElapsedSeconds(registration.submittedAt);

  const { status, payload, error } = registration;
  const draftIsUsable = draft.length > 0;

  if (status === 'registered' && !registration.revoked) {
    return (
      <Screen title={copy.registeredTitle}>
        <p>{copy.registeredBody}</p>
        <dl className="gate-setup__facts">
          <dt>{copy.gateIdLabel}</dt>
          <dd>{String(registration.gateId)}</dd>
          <dt>{copy.eventLabel}</dt>
          <dd>{String(registration.eventId)}</dd>
          <dt>{copy.orgIdLabel}</dt>
          <dd>{String(registration.orgId)}</dd>
        </dl>
        {registration.open ? null : <Alert tone="warn">{copy.notOpen}</Alert>}
      </Screen>
    );
  }

  return (
    <Screen title={copy.title}>
      {registration.revoked ? <Alert tone="error">{copy.revoked}</Alert> : null}

      <Field label={copy.eventLabel}>
        <input
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(DIGITS_ONLY, ''))}
        />
      </Field>
      <p>{draftIsUsable ? copy.eventHint : copy.eventInvalid}</p>
      <Button
        variant="ghost"
        onClick={() => setChosenEventId(draft)}
        disabled={!draftIsUsable || draft === chosenEventId}
      >
        {copy.eventApply}
      </Button>

      {status === 'creating' ? (
        <>
          <Spinner />
          <p>{copy.creating}</p>
        </>
      ) : null}
      {status === 'submitting' ? <p>{copy.submitting}</p> : null}
      {status === 'waiting' ? (
        <>
          <p>{registration.submitted ? copy.submitted : copy.waitingUnsent}</p>
          {registration.submitted ? <p>{fmt(copy.elapsed, { seconds: elapsed })}</p> : null}
        </>
      ) : null}

      {error === undefined ? null : (
        <Alert tone={error === 'CHAIN_UNREACHABLE' ? 'warn' : 'error'}>{copy[ERROR_LINE[error]]}</Alert>
      )}

      {payload === undefined ? null : (
        <section className="gate-setup__fallback">
          <h2>{copy.fallbackTitle}</h2>
          <p>{copy.fallbackHint}</p>
          <PayloadQr text={gatePayloadText(payload)} alt={copy.qrAlt} />
          <dl className="gate-setup__facts">
            <dt>{copy.accountLabel}</dt>
            <dd className="mono selectable">{payload.gateAccount}</dd>
            <dt>{copy.kxLabel}</dt>
            <dd className="mono selectable">{payload.kx}</dd>
            <dt>{copy.kyLabel}</dt>
            <dd className="mono selectable">{payload.ky}</dd>
          </dl>
          <Button onClick={registration.resubmit}>{copy.resubmit}</Button>
        </section>
      )}
    </Screen>
  );
}
