import { useEffect, useState, type ReactNode } from 'react';
import { DEVICE_COOLDOWN_SECONDS } from '@monti/shared';
import { Alert, Button, Field } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { api, callableFailure } from '../../shared/api/functions';
import { ROTATION_UNDO_WINDOW_SECONDS, readIdentity } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** How the caller proves it is really them before the chain will accept another phone. */
type Method = 'sms' | 'kyc';

/**
 * The two refusals the person can do something about. Everything else — a mismatched person,
 * a missing phone index, a dropped call — is ours to fix, not theirs, and gets one sentence.
 */
const REFUSALS: Readonly<Record<string, 'newDeviceNeedsPhone' | 'newDeviceNeedsKyc'>> = {
  PHONE_REAUTH_REQUIRED: 'newDeviceNeedsPhone',
  KYC_REQUIRED: 'newDeviceNeedsKyc',
};

/** The single banner: the server's sentence if it has spoken, otherwise the chain's count. */
function statusLine(notice: string, daysLeft: number | null, copy: Copy): ReactNode {
  if (notice) return <Alert tone="info">{notice}</Alert>;
  if (daysLeft === 0) return <Alert tone="info">{copy.me.newDeviceReady}</Alert>;
  if (daysLeft !== null && daysLeft > 0) {
    return <Alert tone="warn">{fmt(copy.me.newDeviceWait, { days: daysLeft })}</Alert>;
  }
  return null;
}

/** Whole days still to wait, or 0 once the chain would accept the change. */
function daysUntil(readyAt: number, now: number): number {
  const seconds = readyAt - now;
  return seconds <= 0 ? 0 : Math.ceil(seconds / SECONDS_PER_DAY);
}

/**
 * The delayed half of the device policy (spec §9.3): the contract counts `DEVICE_COOLDOWN`
 * from `deviceUpdatedAt`, so that is where the wait is read from — never from the copy in
 * Firestore, and never from anything this screen remembers between visits.
 *
 * The three sentences above the button are what a person is owed before they start, because
 * all three are irreversible in one direction or the other: inside the undo window the old
 * phone can still take the move back, inside that same window the contracts hold the new
 * account at arm's length, and once it closes the tickets follow by themselves. The span comes
 * from `ROTATION_UNDO_WINDOW_SECONDS`, so the number in the sentence is the contract's own.
 */
export function NewDevice() {
  const copy = useCopy();
  const locale = useLocale();
  const session = useSession();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [method, setMethod] = useState<Method>('sms');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const undoHours = ROTATION_UNDO_WINDOW_SECONDS / SECONDS_PER_HOUR;

  useEffect(() => {
    const account = session.account;
    if (!account) return;
    let live = true;
    void readIdentity()
      .deviceUpdatedAt(account)
      .then((updatedAt) => {
        if (live) {
          setDaysLeft(daysUntil(Number(updatedAt) + DEVICE_COOLDOWN_SECONDS, Math.floor(Date.now() / 1000)));
        }
      })
      // An unread chain must not hide the button: the server decides, and it says so plainly.
      .catch(() => {
        if (live) setDaysLeft(null);
      });
    return () => {
      live = false;
    };
  }, [session.account]);

  async function request(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { allowed, allowedAt, now } = await api.startDeviceChange({ method });
      setDaysLeft(daysUntil(allowedAt, now));
      setNotice(
        allowed
          ? copy.me.newDeviceReady
          : fmt(copy.me.newDeviceAllowedOn, {
              date: new Date(allowedAt * 1_000).toLocaleDateString(locale),
            }),
      );
    } catch (cause) {
      const key = REFUSALS[callableFailure(cause).reason];
      setError(key ? copy.me[key] : copy.me.newDeviceFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{copy.me.newDevice}</h2>
      <h3>{copy.me.recoveryTitle}</h3>
      <ul>
        <li>{fmt(copy.me.recoveryUndo, { hours: undoHours })}</li>
        <li>{fmt(copy.me.recoveryQuarantine, { hours: undoHours })}</li>
        <li>{fmt(copy.me.recoveryMigrate, { hours: undoHours })}</li>
      </ul>
      {/* One status line, whichever source last spoke: the server's answer wins over the
          chain read this screen started with, and they never stack up two banners. */}
      {statusLine(notice, daysLeft, copy)}
      <Field label={copy.me.newDeviceMethod}>
        <select value={method} onChange={(event) => setMethod(event.target.value as Method)}>
          <option value="sms">{copy.me.newDeviceMethodSms}</option>
          <option value="kyc">{copy.me.newDeviceMethodKyc}</option>
        </select>
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* Left enabled through the wait on purpose: the client-side count is advisory — the
          server answers with the real date, and a chain read that failed must not strand the
          one person who most needs this button. */}
      <Button variant="ghost" onClick={() => void request()} disabled={busy}>
        {copy.me.newDeviceCta}
      </Button>
    </section>
  );
}
