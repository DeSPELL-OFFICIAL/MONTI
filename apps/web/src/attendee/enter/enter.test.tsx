import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateCodeWire, Hex } from '@monti/shared';
import type { ArmState } from './useArm';
import { ko } from '../../shared/copy/index';
import { fmt } from '../../shared/i18n';

// Partial mocks throughout: the real `DeviceKeyUnavailable`, `NfcError` and `NFC_ERROR` stay,
// because the screen tells one ending from another by those classes and codes.
const armDeviceKey = vi.fn();
vi.mock('../../shared/deviceKey', async (orig) => ({
  ...(await orig<typeof import('../../shared/deviceKey')>()),
  armDeviceKey,
}));

const nfcCapability = vi.fn<() => 'native' | 'webnfc' | 'none'>(() => 'native');
const readGateCode = vi.fn();
vi.mock('../../shared/nfc', async (orig) => ({
  ...(await orig<typeof import('../../shared/nfc')>()),
  nfcCapability,
  readGateCode,
}));

const verifyGate = vi.fn();
vi.mock('./verifyGate', async (orig) => ({
  ...(await orig<typeof import('./verifyGate')>()),
  verifyGate,
}));

const handOverSignature = vi.fn();
vi.mock('./buildResponse', async (orig) => ({
  ...(await orig<typeof import('./buildResponse')>()),
  handOverSignature,
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ tokenId: '7' }),
}));

const { Enter } = await import('./Enter');
const { ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable } = await import('../../shared/deviceKey');
const { NFC_ERROR, NfcError } = await import('../../shared/nfc');

const WIRE: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_790_000_000,
  nonce: `0x${'5a'.repeat(32)}` as Hex,
  kx: `0x${'11'.repeat(32)}` as Hex,
  ky: `0x${'22'.repeat(32)}` as Hex,
  sig: `0x${'33'.repeat(64)}` as Hex,
};

beforeEach(() => {
  armDeviceKey.mockReset().mockResolvedValue(undefined);
  readGateCode.mockReset().mockResolvedValue(WIRE);
  verifyGate.mockReset().mockResolvedValue({ ok: true });
  nfcCapability.mockReset().mockReturnValue('native');
  handOverSignature.mockReset().mockResolvedValue(undefined);
});

async function tapEnter() {
  const user = userEvent.setup();
  render(<Enter />);
  await user.click(screen.getByRole('button', { name: ko.enter.cta }));
}

describe('<Enter /> arming', () => {
  it('arms the attendee key before the reader session is opened', async () => {
    await tapEnter();
    expect(armDeviceKey).toHaveBeenCalledWith({ alias: ATTENDEE_KEY_ALIAS });
    expect(readGateCode).toHaveBeenCalledTimes(1);
    // The ordering is the point, not just that both ran: a biometric raised behind the iOS
    // reader sheet is a screen nobody can answer, and a code read by a phone that then refuses
    // to sign is a code burned for nothing.
    expect(armDeviceKey.mock.invocationCallOrder[0] as number).toBeLessThan(
      readGateCode.mock.invocationCallOrder[0] as number,
    );
  });

  it('shows the countdown and the tap guide once armed', async () => {
    // Held at `verifying` so the armed group is what is on screen when the assertions run.
    verifyGate.mockReturnValue(new Promise(() => undefined));
    await tapEnter();
    expect(screen.getByRole('timer')).toHaveTextContent('60');
    expect(screen.getByText(fmt(ko.enter.armed, { seconds: 60 }))).toBeInTheDocument();
    expect(screen.getByText(ko.enter.verifying)).toBeInTheDocument();
  });

  it('offers the code instead of a tap when this phone has no hardware key', async () => {
    armDeviceKey.mockRejectedValue(new DeviceKeyUnavailable());
    await tapEnter();
    expect(readGateCode).not.toHaveBeenCalled();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
    expect(screen.getByText(ko.enter.deviceUnavailable)).toBeInTheDocument();
  });

  it('reports any other arming failure instead of opening a session', async () => {
    armDeviceKey.mockRejectedValue(new Error('biometry failed'));
    await tapEnter();
    expect(readGateCode).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.armFailed);
  });

  it('offers the code when the phone has no NFC at all, after arming', async () => {
    nfcCapability.mockReturnValue('none');
    await tapEnter();
    expect(armDeviceKey).toHaveBeenCalledTimes(1);
    expect(readGateCode).not.toHaveBeenCalled();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
  });

  it('keeps the armed sentence and the timer on the same second', async () => {
    vi.useFakeTimers();
    verifyGate.mockReturnValue(new Promise(() => undefined));
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    for (let second = 0; second < 3; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    const left = Number(screen.getByRole('timer').textContent);
    expect(left).toBeLessThan(ARM_WINDOW_SECONDS);
    expect(screen.getByText(fmt(ko.enter.armed, { seconds: left }))).toBeInTheDocument();
  });

  it('drops a read that lands after the window closed', async () => {
    vi.useFakeTimers();
    let land!: (wire: GateCodeWire) => void;
    readGateCode.mockReturnValue(
      new Promise<GateCodeWire>((resolve) => {
        land = resolve;
      }),
    );
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    for (let second = 0; second <= ARM_WINDOW_SECONDS; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(screen.getByText(ko.enter.expired)).toBeInTheDocument();

    // The secure chip closed the window; a code that arrives now must not restart the flow.
    await act(async () => {
      land(WIRE);
    });
    expect(verifyGate).not.toHaveBeenCalled();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: ko.enter.cta })).toBeInTheDocument();
  });

  it('drops a verification that lands after the window closed', async () => {
    vi.useFakeTimers();
    verifyGate.mockReturnValue(new Promise(() => undefined));
    let settle!: (verdict: { ok: boolean }) => void;
    verifyGate.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        settle = resolve;
      }),
    );
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    for (let second = 0; second <= ARM_WINDOW_SECONDS; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    await act(async () => {
      settle({ ok: true });
    });
    expect(screen.getByText(ko.enter.expired)).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('aborts the reader session when the window closes', async () => {
    vi.useFakeTimers();
    readGateCode.mockReturnValue(new Promise(() => undefined));
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    const options = readGateCode.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);

    for (let second = 0; second <= ARM_WINDOW_SECONDS; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    // Otherwise the iOS reader sheet outlives the window it belongs to, inviting a tap into a
    // flow that can no longer sign.
    expect(options.signal.aborted).toBe(true);
  });

  it('does not re-arm on its own when the window runs out', async () => {
    // Fake timers here, so `userEvent` (which schedules its own) is swapped for a plain click.
    vi.useFakeTimers();
    verifyGate.mockReturnValue(new Promise(() => undefined));
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    // One second at a time: React 19 flushes through a MessageChannel that fake timers do not
    // drive, so each tick needs its own `act` for the countdown's next timeout to be scheduled.
    for (let second = 0; second <= ARM_WINDOW_SECONDS; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByText(ko.enter.expired)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ko.enter.cta })).toBeInTheDocument();
    expect(armDeviceKey).toHaveBeenCalledTimes(1);
  });
});

describe('<Enter /> tap endings', () => {
  const endings: Array<[string, string]> = [
    [NFC_ERROR.cancelled, ko.enter.tapCancelled],
    [NFC_ERROR.timeout, ko.enter.tapTimeout],
    [NFC_ERROR.noGateRecord, ko.enter.tapFailed],
    [NFC_ERROR.readFailed, ko.enter.tapFailed],
  ];

  for (const [code, sentence] of endings) {
    it(`turns ${code} into its own sentence`, async () => {
      readGateCode.mockRejectedValue(new NfcError(code as never));
      await tapEnter();
      expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      expect(verifyGate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: ko.common.retry })).toBeInTheDocument();
    });
  }

  it('sends an unsupported reader to the code, not to an error', async () => {
    readGateCode.mockRejectedValue(new NfcError(NFC_ERROR.unavailable));
    await tapEnter();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
  });

  it('falls back to a failed read for a rejection that is not an NfcError', async () => {
    readGateCode.mockRejectedValue(new Error('BAD_GATE_CODE'));
    await tapEnter();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.tapFailed);
  });
});

describe('<Enter /> gate verification', () => {
  it('verifies the code it read, for this ticket', async () => {
    await tapEnter();
    expect(verifyGate).toHaveBeenCalledWith(WIRE, { tokenId: '7' });
  });

  const refusals: Array<[string, string]> = [
    ['codeExpired', ko.enter.codeExpired],
    ['unknownGate', ko.enter.unknownGate],
    ['gateClosed', ko.enter.gateClosed],
    ['wrongEvent', ko.enter.wrongEvent],
    ['badSignature', ko.enter.badSignature],
  ];

  for (const [reason, sentence] of refusals) {
    it(`shows the ${reason} sentence and stops`, async () => {
      verifyGate.mockResolvedValue({ ok: false, reason });
      await tapEnter();
      expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    });
  }

  it('hands a verified gate on to the signing step with nothing signed here', async () => {
    await tapEnter();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(screen.getByText(ko.enter.verifying)).toBeInTheDocument();
  });

  it('hands the verified code to the signing step, inside this arm window', async () => {
    await tapEnter();
    expect(handOverSignature).toHaveBeenCalledTimes(1);
    const handed = handOverSignature.mock.calls[0]?.[0] as {
      tokenId: string;
      gateCode: GateCodeWire;
      armedAt: number;
      isCurrent: (armedAt: number) => boolean;
    };
    expect(handed.tokenId).toBe('7');
    expect(handed.gateCode).toEqual(WIRE);
    expect(handed.isCurrent(handed.armedAt)).toBe(true);
    expect(handed.isCurrent(handed.armedAt + 1)).toBe(false);
  });

  it('does not sign a gate it refused', async () => {
    verifyGate.mockResolvedValue({ ok: false, reason: 'gateClosed' });
    await tapEnter();
    expect(handOverSignature).not.toHaveBeenCalled();
  });

  it('shows the code for the gate it read once the hand-over asks for it', async () => {
    handOverSignature.mockImplementation(
      async ({ setState }: { setState: (update: (prev: ArmState) => ArmState) => void }) => {
        setState((prev) => ({ ...prev, phase: 'qr', error: 'writeFailed' }));
      },
    );
    await tapEnter();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
    expect(screen.getByText(ko.enter.writeFailed)).toBeInTheDocument();
    // <Qr /> is mounted for the code that was actually read. jsdom has no secure element, so
    // what it settles on here is its own refusal — that it got that far is the wiring under test.
    expect(await screen.findByText(ko.enter.signFailed)).toBeInTheDocument();
  });

  it('comes back to the start button after a refusal', async () => {
    const user = userEvent.setup();
    verifyGate.mockResolvedValue({ ok: false, reason: 'unknownGate' });
    render(<Enter />);
    await user.click(screen.getByRole('button', { name: ko.enter.cta }));
    await user.click(screen.getByRole('button', { name: ko.common.retry }));
    expect(screen.getByRole('button', { name: ko.enter.cta })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
