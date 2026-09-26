// The four things the gate screen can be, and the one button that is not a tap.
//
// `useGate` has its own end-to-end test next door, so it is a seam here: what this file is about
// is the screen's own judgement — when a door may take taps at all, and what a staff member is
// told when it may not. Each of the three refusals below is a different sentence on purpose. "Not
// yet told" is not "closed", and "closed" is not "revoked": the first is a wait, the second
// clears when an organizer opens the door, and the third never clears.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateResponseWire } from '@monti/shared';

import { staffKo } from '../copy';
import type { GateRegistration } from '../setup/useGateRegistration';
import type { UseGateParams, UseGateResult } from './useGate';

const GATE_ACCOUNT = `0x${'aa'.repeat(20)}` as const;

const registration = vi.fn<() => GateRegistration>();
vi.mock('../setup/useGateRegistration', () => ({ useGateRegistration: () => registration() }));

const handleResponse = vi.fn(async () => undefined);
const openOverride = vi.fn(() => true);
const searchGuests = vi.fn(() => []);
const submitOverride = vi.fn(async () => undefined);
const gate = vi.fn<() => UseGateResult>();
/** What the screen handed the hook. `enabled` is the guard, so it is asserted rather than read. */
let asked: UseGateParams | undefined;
vi.mock('./useGate', () => ({
  useGate: (p: UseGateParams) => {
    asked = p;
    return gate();
  },
}));

const scanGateResponse = vi.fn<() => Promise<GateResponseWire>>();
vi.mock('../qr/scan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../qr/scan')>()),
  scanGateResponse: () => scanGateResponse(),
}));

const { GateScreen } = await import('./GateScreen');
const { ScanError, SCAN_ERROR, ScanCancelled } = await import('../qr/scan');

function registered(over: Partial<GateRegistration> = {}): GateRegistration {
  return {
    status: 'registered',
    address: GATE_ACCOUNT,
    gateId: 7n,
    eventId: 42n,
    orgId: 5n,
    open: true,
    revoked: false,
    submitted: true,
    resubmit: vi.fn(),
    ...over,
  };
}

const TICKET = {
  tokenId: '123',
  account: `0x${'aa'.repeat(20)}`,
  deviceX: `0x${'11'.repeat(32)}`,
  deviceY: `0x${'22'.repeat(32)}`,
  photoJpegB64: '',
  displayName: '김입장',
  tier: 0,
  tierName: '일반',
  seat: '',
  checkedIn: false,
} as const;

function running(over: Partial<UseGateResult> = {}): UseGateResult {
  return {
    state: 'ready',
    gateId: 7n,
    eventId: 42n,
    orgId: 5n,
    finalized: false,
    checking: false,
    waitHint: false,
    pendingCount: 0,
    snapshotAgeMs: 0,
    online: true,
    elapsedMs: 0,
    entriesCount: 3,
    deviceChangedRecently: false,
    requireKyc: true,
    eventTitle: '가을 밤 콘서트',
    parkedCount: 0,
    gateOpen: true,
    gateOpenStale: false,
    canApprove: false,
    openOverride,
    searchGuests,
    submitOverride,
    handleResponse,
    retry: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  asked = undefined;
  registration.mockReturnValue(registered());
  gate.mockReturnValue(running());
});

/**
 * The staff APK is a kiosk on a MemoryRouter and `StaffRoutes` is a descendant router mounted at
 * `/staff/*`, so the gate and the queue are siblings *inside* it. The nesting is copied rather
 * than flattened because it is what makes the screen's relative `../queue` resolve at all.
 */
function renderGate() {
  return render(
    <MemoryRouter initialEntries={['/staff/gate']}>
      <Routes>
        <Route path="/staff">
          <Route path="gate" element={<GateScreen />} />
          <Route path="queue" element={<div>QUEUE SCREEN</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('before the gate may take a tap', () => {
  it('waits rather than sending a registered terminal back to setup', () => {
    registration.mockReturnValue({ ...registered(), status: 'creating', gateId: undefined });
    renderGate();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('waits while the chain has not said whether this door is open', () => {
    gate.mockReturnValue(running({ gateOpen: undefined }));
    renderGate();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  /** Closed clears when an organizer opens the door, so it is a warning and not an alert. */
  it('stops taking taps on a gate the organizer has not opened', () => {
    gate.mockReturnValue(running({ gateOpen: false }));
    renderGate();
    expect(screen.getByText(staffKo.setup.notOpen)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.ready.tap)).not.toBeInTheDocument();
  });

  /**
   * The guard has to reach the hook, not just the render. A blocking screen with a live emitter
   * behind it keeps rotating codes and keeps spending on taps the chain can only refuse — and
   * the staff member is looking at the warning the whole time.
   */
  it.each([
    ['revoked', registered({ revoked: true })],
    ['not opened', registered({ open: false })],
  ])('tells the hook to stand down when the gate is %s', (_case, reg) => {
    registration.mockReturnValue(reg);
    renderGate();
    expect(asked?.enabled).toBe(false);
  });

  it('lets the hook run only when the registration says both', () => {
    renderGate();
    expect(asked?.enabled).toBe(true);
  });

  /** Revoked never clears: this phone is not a gate any more, whatever the door is doing. */
  it('stops taking taps on a revoked gate, before it even asks whether the door is open', () => {
    registration.mockReturnValue(registered({ revoked: true }));
    gate.mockReturnValue(running({ gateOpen: true }));
    renderGate();
    expect(screen.getByRole('alert')).toHaveTextContent(staffKo.setup.revoked);
  });
});

describe('the running console', () => {
  it('hands the machine’s state and the wiring’s facts to the console', () => {
    gate.mockReturnValue(running());
    renderGate();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(7n));
    expect(screen.getByText('가을 밤 콘서트')).toBeInTheDocument();
    expect(screen.getByText(staffKo.ready.tap)).toBeInTheDocument();
  });

  it('names the event by number until the first guest list lands', () => {
    gate.mockReturnValue(running({ eventTitle: '' }));
    renderGate();
    expect(screen.getByText(`${staffKo.setup.eventLabel} 42`)).toBeInTheDocument();
  });
});

describe('the way to what the gate still owes', () => {
  /**
   * Without this the queue screen has no entrance anywhere in the app, and a terminal that took
   * people in during a signal drop has no path to the one screen that can re-send them.
   */
  it('opens the queue screen', async () => {
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(staffKo.queue.title) }));
    expect(await screen.findByText('QUEUE SCREEN')).toBeInTheDocument();
  });

  it('carries the count, so a staff member sees the debt without opening anything', () => {
    gate.mockReturnValue(running({ pendingCount: 2, parkedCount: 3 }));
    renderGate();
    expect(screen.getByRole('button', { name: `${staffKo.queue.title} 5` })).toBeInTheDocument();
  });

  it('says nothing about a count when the gate owes nothing', () => {
    renderGate();
    expect(screen.getByRole('button', { name: staffKo.queue.title })).toBeInTheDocument();
  });
});

describe('the QR fallback', () => {
  it('feeds a scanned answer into the one receiving path', async () => {
    const response = {
      v: 2 as const,
      tokenId: '1042',
      nonce: `0x${'ab'.repeat(32)}` as const,
      deviceSig: `0x${'cd'.repeat(64)}` as const,
    };
    scanGateResponse.mockResolvedValue(response);
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    await waitFor(() => expect(handleResponse).toHaveBeenCalledWith(response));
  });

  it('says what to do about a camera it could not use', async () => {
    scanGateResponse.mockRejectedValue(new ScanError(SCAN_ERROR.permissionDenied));
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    expect(await screen.findByText(staffKo.qr.cameraDenied)).toBeInTheDocument();
    expect(handleResponse).not.toHaveBeenCalled();
  });

  /** Closing the camera is not a failure, and a staff member who did it knows they did it. */
  it('says nothing when the staff member simply closed the camera', async () => {
    scanGateResponse.mockRejectedValue(new ScanCancelled());
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    await waitFor(() => expect(scanGateResponse).toHaveBeenCalled());
    for (const line of [staffKo.qr.cameraDenied, staffKo.qr.failed, staffKo.qr.notGateCode]) {
      expect(screen.queryByText(line)).not.toBeInTheDocument();
    }
  });
});

/**
 * The reachability of the override state, which is the whole of Task 32 as far as this screen is
 * concerned: before it, `machine.onOverride()` had no caller and the dialog could not be opened
 * by anybody.
 */
describe('manual approval', () => {
  /**
   * Ruling 1. The attendee this exists for is the one whose phone produces nothing, so the
   * button cannot wait for a tap — requiring one would leave exactly that person with nowhere
   * to go.
   */
  it('is offered with no tap on screen at all', async () => {
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: staffKo.override.open }));
    expect(openOverride).toHaveBeenCalledTimes(1);
  });

  it('is offered on a refusal, which is the usual way in', async () => {
    gate.mockReturnValue(running({ state: 'deny', deny: 'EXPIRED_CODE', ticket: TICKET }));
    renderGate();
    await userEvent.click(screen.getByRole('button', { name: staffKo.override.open }));
    expect(openOverride).toHaveBeenCalledTimes(1);
  });

  /** The machine refuses mid-confirm, so a button there could only ever produce a refusal. */
  it('is not offered while a check-in is still confirming', () => {
    gate.mockReturnValue(running({ state: 'confirming', ticket: TICKET }));
    renderGate();
    expect(screen.queryByRole('button', { name: staffKo.override.open })).toBeNull();
  });

  it('hands the dialog a way to search the guest list', async () => {
    const found = [{ ...TICKET, tokenId: '1042', displayName: '박관객' }];
    searchGuests.mockReturnValue(found as never);
    gate.mockReturnValue(running({ state: 'override' }));
    renderGate();
    await userEvent.type(screen.getByLabelText(staffKo.override.searchLabel), '박');
    expect(searchGuests).toHaveBeenCalledWith('박');
    expect(screen.getByRole('button', { name: /박관객/ })).toBeInTheDocument();
  });

  it('shows one dialog and no second button once it is open', () => {
    gate.mockReturnValue(running({ state: 'override', ticket: TICKET }));
    renderGate();
    expect(screen.getByRole('dialog', { name: staffKo.override.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: staffKo.override.open })).toBeNull();
  });

  it('hands the PIN and the reason to the hook, and says what the chain said this staff may do', async () => {
    gate.mockReturnValue(running({ state: 'override', ticket: TICKET, canApprove: true }));
    renderGate();
    expect(screen.getByRole('button', { name: staffKo.override.approve })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(staffKo.override.pin), '4821');
    await userEvent.click(screen.getByRole('button', { name: staffKo.override.approve }));
    expect(submitOverride).toHaveBeenCalledWith('4821', 1, TICKET.tokenId);
  });

  it('offers only a request when the chain says this account may not approve', () => {
    gate.mockReturnValue(running({ state: 'override', ticket: TICKET, canApprove: false }));
    renderGate();
    expect(screen.getByRole('button', { name: staffKo.override.request })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: staffKo.override.approve })).toBeNull();
  });
});

/**
 * A staff APK that cold-starts at a venue with no signal used to be stuck on "not told yet"
 * forever: `isOpenGate` fails, `gateOpen` stays `undefined`, and the door never opens. It now
 * runs on the last answer this device had — and says so, because a permission read an hour ago
 * is a fact about an hour ago.
 */
describe('a door open on a remembered answer', () => {
  it('runs, and marks itself stale in the banner rather than between two buttons', () => {
    gate.mockReturnValue(running({ gateOpen: true, gateOpenStale: true }));
    renderGate();
    const notice = screen.getByText(staffKo.setup.gateOpenStale);
    expect(notice).toBeInTheDocument();
    expect(notice.closest('.gate__banner')).not.toBeNull();
    expect(screen.getByRole('button', { name: staffKo.qr.scanButton })).toBeInTheDocument();
  });

  it('says nothing when the chain answered for itself', () => {
    renderGate();
    expect(screen.queryByText(staffKo.setup.gateOpenStale)).toBeNull();
  });
});
