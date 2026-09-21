// The four things the gate screen can be, and the one button that is not a tap.
//
// `useGate` has its own end-to-end test next door, so it is a seam here: what this file is about
// is the screen's own judgement — when a door may take taps at all, and what a staff member is
// told when it may not. Each of the three refusals below is a different sentence on purpose. "Not
// yet told" is not "closed", and "closed" is not "revoked": the first is a wait, the second
// clears when an organizer opens the door, and the third never clears.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateResponseWire } from '@monti/shared';

import { staffKo } from '../copy';
import type { GateRegistration } from '../setup/useGateRegistration';
import type { UseGateResult } from './useGate';

const GATE_ACCOUNT = `0x${'aa'.repeat(20)}` as const;

const registration = vi.fn<() => GateRegistration>();
vi.mock('../setup/useGateRegistration', () => ({ useGateRegistration: () => registration() }));

const handleResponse = vi.fn(async () => undefined);
const gate = vi.fn<() => UseGateResult>();
vi.mock('./useGate', () => ({ useGate: () => gate() }));

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
    handleResponse,
    retry: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registration.mockReturnValue(registered());
  gate.mockReturnValue(running());
});

describe('before the gate may take a tap', () => {
  it('waits rather than sending a registered terminal back to setup', () => {
    registration.mockReturnValue({ ...registered(), status: 'creating', gateId: undefined });
    render(<GateScreen />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('waits while the chain has not said whether this door is open', () => {
    gate.mockReturnValue(running({ gateOpen: undefined }));
    render(<GateScreen />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  /** Closed clears when an organizer opens the door, so it is a warning and not an alert. */
  it('stops taking taps on a gate the organizer has not opened', () => {
    gate.mockReturnValue(running({ gateOpen: false }));
    render(<GateScreen />);
    expect(screen.getByText(staffKo.setup.notOpen)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.ready.tap)).not.toBeInTheDocument();
  });

  /** Revoked never clears: this phone is not a gate any more, whatever the door is doing. */
  it('stops taking taps on a revoked gate, before it even asks whether the door is open', () => {
    registration.mockReturnValue(registered({ revoked: true }));
    gate.mockReturnValue(running({ gateOpen: true }));
    render(<GateScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent(staffKo.setup.revoked);
  });
});

describe('the running console', () => {
  it('hands the machine’s state and the wiring’s facts to the console', () => {
    gate.mockReturnValue(running());
    render(<GateScreen />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(7n));
    expect(screen.getByText('가을 밤 콘서트')).toBeInTheDocument();
    expect(screen.getByText(staffKo.ready.tap)).toBeInTheDocument();
  });

  it('names the event by number until the first guest list lands', () => {
    gate.mockReturnValue(running({ eventTitle: '' }));
    render(<GateScreen />);
    expect(screen.getByText(`${staffKo.setup.eventLabel} 42`)).toBeInTheDocument();
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
    render(<GateScreen />);
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    await waitFor(() => expect(handleResponse).toHaveBeenCalledWith(response));
  });

  it('says what to do about a camera it could not use', async () => {
    scanGateResponse.mockRejectedValue(new ScanError(SCAN_ERROR.permissionDenied));
    render(<GateScreen />);
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    expect(await screen.findByText(staffKo.qr.cameraDenied)).toBeInTheDocument();
    expect(handleResponse).not.toHaveBeenCalled();
  });

  /** Closing the camera is not a failure, and a staff member who did it knows they did it. */
  it('says nothing when the staff member simply closed the camera', async () => {
    scanGateResponse.mockRejectedValue(new ScanCancelled());
    render(<GateScreen />);
    await userEvent.click(screen.getByRole('button', { name: staffKo.qr.scanButton }));
    await waitFor(() => expect(scanGateResponse).toHaveBeenCalled());
    for (const line of [staffKo.qr.cameraDenied, staffKo.qr.failed, staffKo.qr.notGateCode]) {
      expect(screen.queryByText(line)).not.toBeInTheDocument();
    }
  });
});
