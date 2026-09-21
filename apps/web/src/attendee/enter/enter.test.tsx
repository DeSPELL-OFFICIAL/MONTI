import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGateResponse, type GateCodeWire, type GateResponseWire, type Hex } from '@monti/shared';
import { ko } from '../../shared/copy/index';
import { fmt } from '../../shared/i18n';

// Partial mocks throughout: the real `DeviceKeyUnavailable`, `NfcError` and `NFC_ERROR` stay,
// because the screen tells one ending from another by those classes and codes.
const armDeviceKey = vi.fn();
const signWithDeviceKey = vi.fn(async () => ({
  r: `0x${'11'.repeat(32)}` as Hex,
  // Comfortably inside the low half of the curve order, which `buildGateResponse` requires.
  s: `0x${'22'.repeat(32)}` as Hex,
}));
vi.mock('../../shared/deviceKey', async (orig) => ({
  ...(await orig<typeof import('../../shared/deviceKey')>()),
  armDeviceKey,
  signWithDeviceKey,
}));

const nfcCapability = vi.fn<() => 'native' | 'webnfc' | 'none'>(() => 'native');
/**
 * The one session. Its default stands in for a whole tap: the session opens, a gate record
 * arrives, the callback verifies and signs, and the primitive writes what that returns to the
 * same tag before ending. `written` is what reached the tag; `session` counts the open/close.
 */
const readThenWrite = vi.fn<
  (sign: (code: GateCodeWire) => Promise<GateResponseWire>, options?: { signal?: AbortSignal }) => Promise<void>
>();
vi.mock('../../shared/nfc', async (orig) => ({
  ...(await orig<typeof import('../../shared/nfc')>()),
  nfcCapability,
  readThenWrite,
}));

// `waiting` mounts <Result />, which opens a log subscription, reads `checkInOf` once and
// registers for push. None of that is this file's subject, and the real subscription would put
// a 400 ms poll and a WebSocket client behind the fake timers several tests here drive.
vi.mock('../../shared/chain/subscribeLogs', () => ({ subscribeLogs: () => () => undefined }));
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ({ checkInOf: async () => ({ ts: 0n }) }),
}));
vi.mock('../../shared/push', () => ({ registerPush: async () => ({ status: 'unavailable', reason: 'x' }) }));

const verifyGate = vi.fn();
vi.mock('./verifyGate', async (orig) => ({
  ...(await orig<typeof import('./verifyGate')>()),
  verifyGate,
}));

// `deviceSigDigest` binds the signature to this chain and this deployment, so the screen needs
// a config; the attendee app's own `VITE_*` are not this test's subject.
vi.mock('../../shared/config', () => ({
  getConfig: () => ({ chainId: 31337, addresses: { ticket: `0x${'71'.repeat(20)}` } }),
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

let written: GateResponseWire | null = null;
let opened = 0;
let closed = 0;

beforeEach(() => {
  written = null;
  opened = 0;
  closed = 0;
  armDeviceKey.mockReset().mockResolvedValue(undefined);
  verifyGate.mockReset().mockResolvedValue({ ok: true });
  nfcCapability.mockReset().mockReturnValue('native');
  signWithDeviceKey.mockClear();
  readThenWrite.mockReset().mockImplementation(async (sign) => {
    opened += 1;
    try {
      written = await sign(WIRE);
    } finally {
      closed += 1;
    }
  });
});

async function tapEnter() {
  const user = userEvent.setup();
  render(<Enter />);
  await user.click(screen.getByRole('button', { name: ko.enter.cta }));
}

describe('<Enter /> arming', () => {
  it('arms the attendee key before the session is opened', async () => {
    await tapEnter();
    expect(armDeviceKey).toHaveBeenCalledWith({ alias: ATTENDEE_KEY_ALIAS });
    expect(readThenWrite).toHaveBeenCalledTimes(1);
    // The ordering is the point, not just that both ran: a biometric raised behind the iOS
    // reader sheet is a screen nobody can answer, and nothing inside the session may prompt.
    expect(armDeviceKey.mock.invocationCallOrder[0] as number).toBeLessThan(
      readThenWrite.mock.invocationCallOrder[0] as number,
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

  it('explains, rather than offering a code, when this phone has no hardware key', async () => {
    armDeviceKey.mockRejectedValue(new DeviceKeyUnavailable());
    await tapEnter();
    expect(readThenWrite).not.toHaveBeenCalled();
    // The code carries a device signature, so a phone that cannot sign has nothing to show.
    expect(screen.queryByText(ko.enter.qrTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.deviceUnavailable);
  });

  it('reports any other arming failure instead of opening a session', async () => {
    armDeviceKey.mockRejectedValue(new Error('biometry failed'));
    await tapEnter();
    expect(readThenWrite).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.armFailed);
  });

  it('explains that a phone with no NFC cannot enter, after arming', async () => {
    nfcCapability.mockReturnValue('none');
    await tapEnter();
    expect(armDeviceKey).toHaveBeenCalledTimes(1);
    expect(readThenWrite).not.toHaveBeenCalled();
    expect(screen.queryByText(ko.enter.qrTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.deviceUnavailable);
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

describe('<Enter /> one session', () => {
  it('reads and writes inside a single session, and only then waits', async () => {
    await tapEnter();
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(written).toMatchObject({ v: 1, tokenId: '7' });
    expect(written?.deviceSig).toHaveLength(2 + 128);
    // What the primitive hands the tag is the shared encoding of exactly that wire.
    expect(encodeGateResponse(written as GateResponseWire).byteLength).toBeGreaterThan(0);
    // The waiting screen is <Result />, which is now watching the chain and the push for the
    // answer; this machine has nothing left to decide.
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
    expect(screen.queryByTestId('entry-result')).not.toBeInTheDocument();
  });

  it('verifies the code it read before signing anything, for this ticket', async () => {
    await tapEnter();
    expect(verifyGate).toHaveBeenCalledWith(WIRE, { tokenId: '7' });
    expect(verifyGate.mock.invocationCallOrder[0] as number).toBeLessThan(
      signWithDeviceKey.mock.invocationCallOrder[0] as number,
    );
  });

  it('hands the session a signal the countdown can abort', async () => {
    vi.useFakeTimers();
    readThenWrite.mockImplementation(async () => {
      opened += 1;
      await new Promise(() => undefined);
    });
    render(<Enter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko.enter.cta }));
    });
    const options = readThenWrite.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);

    for (let second = 0; second <= ARM_WINDOW_SECONDS; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    // Otherwise the iOS reader sheet outlives the window it belongs to, inviting a tap into a
    // session that can no longer sign.
    expect(options.signal.aborted).toBe(true);
  });

  it('signs and writes nothing for a code that arrives after the window closed', async () => {
    vi.useFakeTimers();
    let land!: () => void;
    readThenWrite.mockImplementation(async (sign) => {
      opened += 1;
      await new Promise<void>((resolve) => {
        land = resolve;
      });
      written = await sign(WIRE);
    });
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

    await act(async () => {
      land();
    });
    expect(verifyGate).not.toHaveBeenCalled();
    expect(signWithDeviceKey).not.toHaveBeenCalled();
    expect(written).toBeNull();
    expect(screen.getByRole('button', { name: ko.enter.cta })).toBeInTheDocument();
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
    it(`turns ${code} before any code into its own sentence`, async () => {
      readThenWrite.mockRejectedValue(new NfcError(code as never));
      await tapEnter();
      expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      expect(verifyGate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: ko.common.retry })).toBeInTheDocument();
    });
  }

  it('says so plainly when the reader turns out to be unsupported', async () => {
    readThenWrite.mockRejectedValue(new NfcError(NFC_ERROR.unavailable));
    await tapEnter();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.deviceUnavailable);
    expect(screen.queryByText(ko.enter.qrTitle)).not.toBeInTheDocument();
  });

  it('falls back to a failed read for a rejection that is not an NfcError', async () => {
    readThenWrite.mockRejectedValue(new Error('BAD_GATE_CODE'));
    await tapEnter();
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.tapFailed);
  });

  it('offers the code, with the reason, when the session dies after the read', async () => {
    readThenWrite.mockImplementation(async (sign) => {
      opened += 1;
      await sign(WIRE);
      // The phones parted, or the sheet timed out, with the answer already signed.
      throw new NfcError(NFC_ERROR.timeout);
    });
    await tapEnter();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
    expect(screen.getByText(ko.enter.tapTimeout)).toBeInTheDocument();
  });

  it('shows that code without signing a second time', async () => {
    readThenWrite.mockImplementation(async (sign) => {
      opened += 1;
      await sign(WIRE);
      throw new NfcError(NFC_ERROR.readFailed);
    });
    await tapEnter();
    expect(screen.getByText(ko.enter.qrTitle)).toBeInTheDocument();
    // <Qr /> was handed the wire the tap built; a second signature would cost a second window.
    expect(signWithDeviceKey).toHaveBeenCalledTimes(1);
  });
});

describe('<Enter /> gate verification', () => {
  const refusals: Array<[string, string]> = [
    ['codeExpired', ko.enter.codeExpired],
    ['unknownGate', ko.enter.unknownGate],
    ['gateClosed', ko.enter.gateClosed],
    ['wrongEvent', ko.enter.wrongEvent],
    ['badSignature', ko.enter.badSignature],
  ];

  for (const [reason, sentence] of refusals) {
    it(`shows the ${reason} sentence, signs nothing and writes nothing`, async () => {
      verifyGate.mockResolvedValue({ ok: false, reason });
      await tapEnter();
      expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      expect(signWithDeviceKey).not.toHaveBeenCalled();
      expect(written).toBeNull();
      expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    });
  }

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
