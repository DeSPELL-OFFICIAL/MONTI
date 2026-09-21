import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEVICE_COOLDOWN_SECONDS } from '@monti/shared';
import { Alert, Button } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { api, callableFailure } from '../../shared/api/functions';
import { ROTATION_UNDO_WINDOW_SECONDS, readIdentity } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/**
 * The server takes `sms` or `kyc`. Only `kyc` is offered, because `sms` needs a Firebase phone
 * re-authentication session (`device.ts` refuses anything else with `PHONE_REAUTH_REQUIRED`)
 * and this app has no screen that opens one. Offering a choice where one side always fails is
 * a worse screen than offering the side that works.
 */
const METHOD = 'kyc' as const;

/**
 * The two refusals the person can do something about. Everything else — a mismatched person,
 * a missing phone index, a dropped call — is ours to fix, not theirs, and gets one sentence.
 */
const REFUSALS: Readonly<Record<string, 'newDeviceNeedsPhone' | 'newDeviceNeedsKyc'>> = {
  PHONE_REAUTH_REQUIRED: 'newDeviceNeedsPhone',
  KYC_REQUIRED: 'newDeviceNeedsKyc',
};

/** Whole days still to wait, or 0 once the chain would accept the change. */
function daysUntil(readyAt: number, now: number): number {
  const seconds = readyAt - now;
  return seconds <= 0 ? 0 : Math.ceil(seconds / SECONDS_PER_DAY);
}

/** The single banner: the server's sentence if it has spoken, otherwise the chain's count. */
function statusLine(notice: string, daysLeft: number | null, copy: Copy): ReactNode {
  if (notice) return <Alert tone="info">{notice}</Alert>;
  if (daysLeft === 0) return <Alert tone="info">{copy.me.newDeviceReady}</Alert>;
  if (daysLeft !== null && daysLeft > 0) {
    return <Alert tone="warn">{fmt(copy.me.newDeviceWait, { days: daysLeft })}</Alert>;
  }
  return null;
}

/**
 * The delayed half of the device policy (spec §9.3): the contract counts `DEVICE_COOLDOWN`
 * from `deviceUpdatedAt`, so that is where the wait is read from — never from the copy in
 * Firestore, and never from anything this screen remembers between visits.
 *
 * The three sentences above the button are what a person is owed before they start, because
 * all three are hard to reverse: inside the undo window the old phone can still take the move
 * back, inside that same window the contracts hold the new account at arm's length, and the
 * tickets only come across once it closes — and then only because somebody asks them to. The
 * span comes from `ROTATION_UNDO_WINDOW_SECONDS`, so the number in the sentence is the
 * contract's own.
 *
 * T27b (after the 01b redeploy): this screen gains the two buttons it cannot have yet —
 * `Ticket.migrate(tokenId)` sent by the NEW account once the window has closed, and
 * `Identity.cancelRotation()` on the previous device while it is still open, shown only when
 * `rotatedFrom(personId) == me && now < rotatedAt + MIGRATE_DELAY`. Both need Identity's
 * `rotatedAt`/`rotatedFrom`/`ROTATION_UNDO_WINDOW` and Ticket's `MIGRATE_DELAY` registered in
 * `USED_ABI` and read through `readIdentity()`/`readTicket()` instead of the constant above.
 */
export function NewDevice() {
  const copy = useCopy();
  const locale = useLocale();
  const session = useSession();
  const navigate = useNavigate();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [nextStep, setNextStep] = useState(false);
  const [error, setError] = useState('');
  const [needsKyc, setNeedsKyc] = useState(false);
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
    setNextStep(false);
    setNeedsKyc(false);
    try {
      const { allowed, allowedAt, now } = await api.startDeviceChange({ method: METHOD });
      setDaysLeft(daysUntil(allowedAt, now));
      setNotice(
        allowed
          ? copy.me.newDeviceReady
          : fmt(copy.me.newDeviceAllowedOn, {
              date: new Date(allowedAt * 1_000).toLocaleDateString(locale),
            }),
      );
      // Nothing was switched here and nothing can be: `setActiveDevice` reads `msg.sender`, so
      // it is the new phone's own write. Saying "you can register now" and stopping would leave
      // somebody staring at a button that already did all it does.
      setNextStep(allowed);
    } catch (cause) {
      const reason = callableFailure(cause).reason;
      const key = REFUSALS[reason];
      setError(key ? copy.me[key] : copy.me.newDeviceFailed);
      // The one refusal with somewhere to go. `PHONE_REAUTH_REQUIRED` deliberately gets no
      // button: the screen it would point at does not exist.
      setNeedsKyc(reason === 'KYC_REQUIRED');
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
      {nextStep ? <p>{copy.me.newDeviceNext}</p> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {needsKyc ? (
        <Button onClick={() => navigate('/me/verify?returnTo=/me')}>{copy.kyc.cta}</Button>
      ) : null}
      {/* Left enabled through the wait on purpose: the client-side count is advisory — the
          server answers with the real date, and a chain read that failed must not strand the
          one person who most needs this button. */}
      <Button variant="ghost" onClick={() => void request()} disabled={busy}>
        {copy.me.newDeviceCta}
      </Button>
    </section>
  );
}
