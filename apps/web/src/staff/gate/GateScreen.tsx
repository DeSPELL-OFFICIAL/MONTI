// The gate screen: the registration guard, the console, and the QR way in when a tap will not
// land. It holds no rules of its own — `useGate` owns the wiring and `GateConsole` owns the
// drawing, and this file is the seam where a registered device becomes a running door.
//
// Two of the things it does are refusals, and both exist because a screen that keeps serving
// codes it has no authority for is worse than one that stops.
//
// **Registration is re-read on every mount, and nothing runs until it answers.** A gate is what
// `gateOf` says it is, never what this phone stored, so the first moment of every gate screen is
// a wait — and it is a wait rather than a redirect on purpose: redirecting on "not yet" would
// bounce a perfectly registered terminal back to setup every time the door screen opened.
//
// **A gate whose door was closed stops taking taps — actually stops.** The permission has two
// halves: what the registration says (`open && !revoked`) and what `isOpenGate` says on mount and
// every minute after, because an organizer closing a door or revoking a lost phone emits nothing
// this device subscribes to. Both are handed to `useGate` as `enabled`, and they are handed to it
// rather than checked below the hook on purpose: a blocking screen that left the emitter running
// would keep rotating codes behind the warning, spending one sponsored operation per attendee on
// a revert the gate already knew about — or, with no signal, writing durable queue rows for a
// door that will never be allowed to send them, with nothing on the phone saying it happened.
import { useCallback, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { GateConsole } from '../Console';
import { useStaffCopy } from '../copy';
import { warn } from '../log';
import { scanFailureText, scanGateResponse } from '../qr/scan';
import { useGateRegistration } from '../setup/useGateRegistration';
import { useGate } from './useGate';

export function GateScreen(): ReactElement {
  const registration = useGateRegistration();
  const { gateId, eventId, orgId, address } = registration;

  // The chain has not answered yet. Nothing routes an unregistered device here — the setup
  // screen is the entry point and hands off only once it is registered — so the honest thing on
  // this mount is to wait rather than to send a registered terminal back where it came from.
  if (gateId === undefined || eventId === undefined || orgId === undefined || address === undefined) {
    return <Waiting />;
  }

  // Keyed on the registration, so a device somehow re-registered onto another event gets a new
  // machine, a new emitter and a new guest list rather than a running gate quietly changing
  // which event it is admitting people to.
  return (
    <RunningGate
      key={`${gateId}:${eventId}`}
      gateId={gateId}
      eventId={eventId}
      orgId={orgId}
      gateAccount={address}
      open={registration.open}
      revoked={registration.revoked}
    />
  );
}

/** The same frame the three blocking states use, so the screen never jumps while it resolves. */
function Waiting(): ReactElement {
  const copy = useStaffCopy();
  return (
    <Screen title={copy.setup.title}>
      <Spinner />
    </Screen>
  );
}

interface RunningGateProps {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  gateAccount: `0x${string}`;
  /** `gateInfo(gateId).open` — the organizer's switch for this door, and it flips both ways. */
  open: boolean;
  /** `gateInfo(gateId).revoked` — permanent, unlike a closed door. */
  revoked: boolean;
}

/** Where the entries this gate still owes the chain are read and re-sent. */
const QUEUE_PATH = '../queue';

function RunningGate({ gateId, eventId, orgId, gateAccount, open, revoked }: RunningGateProps): ReactElement {
  const copy = useStaffCopy();
  const navigate = useNavigate();
  // The hook takes the permission rather than the screen checking it afterwards — see the header.
  const gate = useGate({ gateId, eventId, orgId, gateAccount, enabled: open && !revoked });
  const [scanError, setScanError] = useState<string>();

  /**
   * The QR fallback (Task 31). Everything after the decode is identical to a tap — same match,
   * same preflight, same verdict — because `handleResponse` **is** the tap path. An iPhone that
   * will not present its tag and a phone whose NFC is off are the same problem, and a second set
   * of rules for the camera is a second set of rules for who gets in.
   */
  const scan = useCallback(() => {
    setScanError(undefined);
    void scanGateResponse()
      .then(gate.handleResponse)
      .catch((cause) => {
        // A closed camera is not a failure and gets no sentence; a refusal the gate itself made
        // is already on the gate's own screen. Only the rest is worth a line here.
        const line = scanFailureText(copy.qr, cause);
        if (line === null) warn('gate', 'scan produced no answer', cause);
        setScanError(line ?? undefined);
      });
  }, [copy.qr, gate.handleResponse]);

  if (revoked) {
    return (
      <Screen title={copy.setup.title}>
        <Alert tone="error">{copy.setup.revoked}</Alert>
      </Screen>
    );
  }

  // `undefined` is "not told", not "told no": a gate that has never had an answer from the chain
  // waits rather than closing itself on a dropped read.
  if (gate.gateOpen === undefined) return <Waiting />;

  const queued = gate.pendingCount + gate.parkedCount;

  if (!gate.gateOpen) {
    return (
      <Screen title={copy.setup.title}>
        <Alert tone="warn">{copy.setup.notOpen}</Alert>
      </Screen>
    );
  }

  return (
    <GateConsole
      gateName={`${copy.setup.gateIdLabel} ${gateId}`}
      eventTitle={gate.eventTitle || `${copy.setup.eventLabel} ${eventId}`}
      context={gate}
      entriesCount={gate.entriesCount}
      lastTap={gate.lastTap}
      refusal={gate.refusal}
      photo={gate.photo}
      deviceChangedRecently={gate.deviceChangedRecently}
      parkedCount={gate.parkedCount}
      queueError={gate.queueError}
      onDone={gate.retry}
      canApprove={gate.canApprove}
      onOverrideSubmit={(pin, reason) => void gate.submitOverride(pin, reason)}
      // Cancelling is the way out of the dialog, and it is `retry` — the same press that clears
      // any other settled screen — so the result lands in 직전 탭 on the way back to waiting.
      onOverrideCancel={gate.retry}
      actions={
        <>
          <Button variant="ghost" onClick={scan}>
            {copy.qr.scanButton}
          </Button>
          {/*
            The way into manual approval, and the only one (04 T32). It is offered exactly when
            there is something to approve — `manualOverride(tokenId, …)` needs a ticket, and the
            only ticket this screen knows is the one the guest list matched on the tap that is on
            screen — and it is hidden while the dialog is open so the screen never shows two
            buttons that both say 수동 승인.
          */}
          {gate.ticket === undefined || gate.state === 'override' ? null : (
            <Button variant="ghost" onClick={gate.openOverride}>
              {copy.override.open}
            </Button>
          )}
          {/*
            The door is open on a remembered answer rather than a fresh one. It still opens —
            refusing every attendee because a venue's wifi is down is the worse failure — but a
            permission read last session is a fact about last session, and whoever is holding the
            phone gets told so rather than finding out from a queue of reverts.
          */}
          {gate.gateOpenStale ? <Alert tone="warn">{copy.setup.gateOpenStale}</Alert> : null}
          {/*
            The only way into the queue screen. Without it a terminal that took people in during a
            signal drop has no path to the one screen that can re-send them or show the conflicts,
            and the count is on the button because a staff member has to be able to see that the
            gate owes something without opening anything.
          */}
          <Button variant="ghost" onClick={() => navigate(QUEUE_PATH)}>
            {queued === 0 ? copy.queue.title : `${copy.queue.title} ${queued}`}
          </Button>
          {scanError === undefined ? null : <Alert tone="warn">{scanError}</Alert>}
        </>
      }
    />
  );
}
