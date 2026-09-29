import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { encodeFunctionData } from 'viem';
import { DEVICE_COOLDOWN_SECONDS, MIGRATE_DELAY_SECONDS, type Hex } from '@monti/shared';
import { Alert, Button } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { api, callableFailure } from '../../shared/api/functions';
import { identityAbi, ticketAbi } from '../../shared/chain/abis';
import { readIdentity, readTicket } from '../../shared/chain/reads';
import { sendAction } from '../../shared/relay/sendAction';
import { relayActionCode } from '../transfer/useTransfer';
import { useSession } from '../../shared/session';
import { loadMyTickets } from '../tickets/useTickets';

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** `rotatedFrom` answers with the zero address when no rotation is waiting to be undone. */
const NO_ACCOUNT = `0x${'00'.repeat(20)}`;

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

/**
 * Whether a relayed operation was refused with one named error. The relayer names the revert in the
 * settled doc's `error.code`, read through {@link relayActionCode}; an unknown outcome (empty code)
 * is not a match, so a dropped relay listener is never mistaken for a determinate refusal.
 */
function refusedWith(cause: unknown, errorName: string): boolean {
  return relayActionCode(cause) === errorName;
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

/** Idle → working → done, for each of the two writes below. */
type Phase = 'idle' | 'working' | 'done';

/**
 * The delayed half of the device policy (spec §9.3): the contract counts `DEVICE_COOLDOWN`
 * from `deviceUpdatedAt`, so that is where the wait is read from — never from the copy in
 * Firestore, and never from anything this screen remembers between visits. That same count is
 * the `deviceUpdatedAt + 7 days` the recovery notes below point at: undoing a rotation
 * deliberately leaves the lock on, and this is the screen that says when it can come off.
 *
 * The three sentences above the button are what a person is owed before they start, because
 * all three are hard to reverse: inside the undo window the old phone can still take the move
 * back, inside that same window the contracts hold the new account at arm's length — a genuine
 * recovery receives nothing at all for those hours — and the tickets only come across once it
 * closes, and then only because somebody asks them to. The span is read from
 * `Identity.ROTATION_UNDO_WINDOW()`, so the number in the sentence is the contract's own.
 *
 * Two buttons hang off the same pair of reads (abi-delta-01b.md §1 and §6):
 *
 * - **되돌리기** — `Identity.cancelRotation()`, shown to the account a rotation pushed aside
 *   while the window is still open. Platform-sponsored, so it works from an account holding
 *   nothing, which is the whole point: the pushed-aside phone is the one an attacker does not
 *   have.
 * - **티켓 가져오기** — `Ticket.migrate(tokenId)`, sent by the NEW account once
 *   `Ticket.MIGRATE_DELAY()` has passed. Nothing moves by itself, and the tickets are still
 *   held by the old account until it does, so the list to move is read for that account.
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
  const [undoWindow, setUndoWindow] = useState<number | null>(null);
  const [migrateWindow, setMigrateWindow] = useState<number | null>(null);
  const [rotation, setRotation] = useState<{ from: Hex; at: number } | null>(null);
  const [undoPhase, setUndoPhase] = useState<Phase>('idle');
  const [undoError, setUndoError] = useState('');
  const [migratePhase, setMigratePhase] = useState<Phase>('idle');
  const [migrated, setMigrated] = useState(0);
  const [migrateError, setMigrateError] = useState('');

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

  // The two spans, from the two contracts that each name one. They are equal by construction —
  // a contract test asserts `Identity.ROTATION_UNDO_WINDOW == Ticket.MIGRATE_DELAY` — which is
  // why `MIGRATE_DELAY_SECONDS` is a safe stand-in for either while a read is still out or has
  // failed. Nothing here writes the span out by hand.
  useEffect(() => {
    let live = true;
    void readIdentity()
      .rotationUndoWindow()
      .then((seconds) => {
        if (live) setUndoWindow(Number(seconds));
      })
      .catch(() => undefined);
    void readTicket()
      .migrateDelay()
      .then((seconds) => {
        if (live) setMigrateWindow(Number(seconds));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // `rotatedAt` alone says nothing: `register` stamps it too, so every member carries one. The
  // flag is `rotatedFrom` — the single account the last rotation pushed aside, cleared the
  // moment the undo lands (abi-delta-01b.md §1).
  useEffect(() => {
    const personId = session.personId as Hex | undefined;
    if (!personId) return;
    let live = true;
    const identity = readIdentity();
    void Promise.all([identity.rotatedFrom(personId), identity.rotatedAt(personId)])
      .then(([from, at]) => {
        if (live) setRotation({ from, at: Number(at) });
      })
      // Nothing to offer is the safe answer: both buttons stay hidden and the screen is the
      // one it has always been.
      .catch(() => {
        if (live) setRotation(null);
      });
    return () => {
      live = false;
    };
  }, [session.personId]);

  const undoSeconds = undoWindow ?? MIGRATE_DELAY_SECONDS;
  const migrateSeconds = migrateWindow ?? MIGRATE_DELAY_SECONDS;
  const undoHours = undoSeconds / SECONDS_PER_HOUR;
  const now = Math.floor(Date.now() / 1000);
  const me = session.account?.toLowerCase();
  const pushedAside =
    rotation && rotation.from.toLowerCase() !== NO_ACCOUNT ? rotation.from.toLowerCase() : null;
  const rotatedAt = rotation?.at ?? 0;
  // The two buttons are never on the same phone. 되돌리기 is §1's exact test, and it belongs to
  // the account the rotation pushed aside — the one an attacker does not have. 티켓 가져오기 is
  // its mirror: `Ticket.migrate` refuses anybody but the account the rotation moved TO with
  // `NotRotatedAccount`, so offering it on the pushed-aside phone would be offering a button
  // that can only be refused.
  const isPushedAside = pushedAside !== null && pushedAside === me;
  const canUndo = isPushedAside && now < rotatedAt + undoSeconds;
  // `rotatedFrom` is cleared by `cancelRotation` alone — never by the window closing and never
  // by `migrate` (Identity.sol: the two paths are mutually exclusive in time, so there is
  // nothing to clear). So what retires this button is the ticket list below going empty, not
  // the flag going to zero.
  const canMigrate =
    pushedAside !== null && me !== undefined && !isPushedAside && now >= rotatedAt + migrateSeconds;

  /**
   * The tickets still sitting on the account the rotation pushed aside. They are read for THAT
   * address, not for the signed-in one: `migrate` is what moves them, so until it runs the
   * index still shows the old account holding them. A ticket already spent, voided or handed
   * on cannot migrate (`AlreadyCheckedIn` / `TicketRevoked` / `NotRotatedAccount`), so the two
   * states that can are the only ones offered.
   */
  const movable = useQuery({
    queryKey: ['migratable', pushedAside],
    enabled: canMigrate && pushedAside !== null,
    queryFn: () => loadMyTickets(pushedAside ?? ''),
  });
  const pending = (movable.data ?? []).filter(
    (ticket) => ticket.state === 'before' || ticket.state === 'pendingOffer',
  );

  async function request(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    setNextStep(false);
    setNeedsKyc(false);
    try {
      const { allowed, allowedAt, now: serverNow } = await api.startDeviceChange({ method: METHOD });
      setDaysLeft(daysUntil(allowedAt, serverNow));
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

  /** `Identity.cancelRotation()`: no arguments — the forwarder passes the account through as
   *  `_msgSender()` — and relayed on the platform's budget, not any organisation's. */
  async function undoRotation(): Promise<void> {
    setUndoPhase('working');
    setUndoError('');
    try {
      await sendAction(
        'cancelRotation',
        'identity',
        encodeFunctionData({ abi: identityAbi, functionName: 'cancelRotation', args: [] }),
      );
      setUndoPhase('done');
    } catch (cause) {
      // One refusal covers both "no rotation" and "the window closed": the contract will not
      // tell them apart, and neither does the sentence.
      setUndoError(
        refusedWith(cause, 'NoRotationToCancel') ? copy.me.undoGone : copy.me.undoFailed,
      );
      setUndoPhase('idle');
    }
  }

  /**
   * One `migrate` per ticket, one at a time, the way the invite inbox collects offers: a single
   * refusal — one ticket already spent, one event that voided it — must not abandon the rest.
   * Every operation is relayed, so nothing here needs the ticket's organisation.
   */
  async function migrateTickets(): Promise<void> {
    setMigratePhase('working');
    setMigrateError('');
    setMigrated(0);
    let moved = 0;
    let failure = '';
    try {
      for (const ticket of pending) {
        const tokenId = BigInt(ticket.tokenId);
        try {
          await sendAction(
            'migrate',
            'ticket',
            encodeFunctionData({ abi: ticketAbi, functionName: 'migrate', args: [tokenId] }),
          );
          moved += 1;
        } catch (cause) {
          failure ||= refusedWith(cause, 'RotationPending')
            ? fmt(copy.me.migrateWait, { hours: undoHours })
            : copy.me.migrateFailed;
        }
      }
    } catch {
      failure ||= copy.me.migrateFailed;
    }
    // Both facts stand, never one: a run that moved three of four says three came across AND
    // says what stopped the fourth. `migrate` has seven named refusals and five of them are
    // per-ticket (`NoSuchTicket`, `NotRotatedAccount`, `NothingToMigrate`, `TicketRevoked`,
    // `AlreadyCheckedIn`); only the timelock is worth its own sentence, so the rest share one.
    setMigrated(moved);
    setMigrateError(failure);
    setMigratePhase(moved > 0 ? 'done' : 'idle');
    // What is left is whatever did not come across, read back from the index rather than
    // guessed at here.
    if (moved > 0) void movable.refetch();
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
      {canUndo ? (
        <div>
          <p>{copy.me.undoBody}</p>
          {undoPhase === 'working' ? <p>{copy.me.undoWorking}</p> : null}
          {undoPhase === 'done' ? <Alert tone="info">{copy.me.undoDone}</Alert> : null}
          {undoError ? <Alert tone="error">{undoError}</Alert> : null}
          <Button onClick={() => void undoRotation()} disabled={undoPhase !== 'idle'}>
            {copy.me.undoCta}
          </Button>
        </div>
      ) : null}
      {canMigrate && (pending.length > 0 || migratePhase === 'done') ? (
        <div>
          {migratePhase === 'working' ? <p>{copy.me.migrateWorking}</p> : null}
          {migratePhase === 'done' ? (
            <Alert tone="info">{fmt(copy.me.migrateDone, { count: migrated })}</Alert>
          ) : null}
          {migrateError ? <Alert tone="error">{migrateError}</Alert> : null}
          {pending.length > 0 ? (
            <Button onClick={() => void migrateTickets()} disabled={migratePhase === 'working'}>
              {copy.me.migrateCta}
            </Button>
          ) : null}
        </div>
      ) : null}
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
