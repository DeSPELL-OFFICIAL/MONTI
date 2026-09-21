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
// **A gate whose door was closed stops taking taps.** `isOpenGate` is re-read on mount and every
// minute (`useGate`), because an organizer closing a door or revoking a lost phone emits nothing
// this device subscribes to. Without the re-check the terminal keeps emitting codes, and every
// tap becomes a sponsored operation that can only revert `GateNotOpen` — one per attendee, each
// one a person told "no" by a door that simply was not told it had shut.
import { useCallback, useState, type ReactElement } from 'react';

import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { GateConsole } from '../Console';
import { useStaffCopy } from '../copy';
import { warn } from '../log';
import { scanFailureText, scanGateResponse } from '../qr/scan';
import { useGateRegistration } from '../setup/useGateRegistration';
import type { OverrideReason } from '../types';
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
  /** `gateInfo(gateId).revoked` — permanent, unlike a closed door. */
  revoked: boolean;
}

function RunningGate({ gateId, eventId, orgId, gateAccount, revoked }: RunningGateProps): ReactElement {
  const copy = useStaffCopy();
  const gate = useGate({ gateId, eventId, orgId, gateAccount });
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
      onOverrideSubmit={submitOverride}
      onOverrideCancel={gate.retry}
      actions={
        <>
          <Button variant="ghost" onClick={scan}>
            {copy.qr.scanButton}
          </Button>
          {scanError === undefined ? null : <Alert tone="warn">{scanError}</Alert>}
        </>
      }
    />
  );
}

/**
 * The manual-approval hand-off, typed and deliberately empty — Task 32 owns the decision, the
 * `Organizers` permission read and the `Ticket.manualOverride` call.
 *
 * It is a stub rather than a missing prop so the shape Task 32 has to satisfy is already
 * written down, and so nothing here can quietly grow half an approval rule in the meantime: the
 * one thing this screen must never do is let somebody in on its own judgement. Nothing reaches
 * the `override` state today — no path calls `machine.onOverride()` — so the dialog is
 * unreachable, which is the honest state of the feature.
 */
function submitOverride(pin: string, reason: OverrideReason): void {
  warn('gate', 'manual approval is not wired yet (Task 32)', { reason, pin: pin.length });
}
