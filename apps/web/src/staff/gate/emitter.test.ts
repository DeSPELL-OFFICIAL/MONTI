import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGateResponse, type GateCodeWire, type GateResponseWire, type Hex } from '@monti/shared';

import {
  decodeGateCodeMessage,
  encodeGateCodeMessage,
  encodeGateResponseMessage,
} from '../../shared/nfc/ndef';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
}));

type WriteListener = (event: { ndef: string }) => void;

const listeners: WriteListener[] = [];
const remove = vi.fn();
const hce = {
  start: vi.fn(),
  setPayload: vi.fn(),
  stop: vi.fn(),
  addListener: vi.fn(),
  removeAllListeners: vi.fn(),
};

/** The plugin's own base64 helpers stay real — the bridge has exactly one spelling of bytes. */
vi.mock('@monti/hce-android', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@monti/hce-android')>()),
  Hce: hce,
}));

/**
 * The gate key is Task 11's, and Task 16 already checks a real P-256 chip signs what the
 * attendee verifies. What this file is about is the loop, the ring and the plugin calls, so the
 * key is a stub here and every assertion below stays about those.
 */
const signGateCode = vi.fn();
vi.mock('./gateKey', () => ({
  ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}`, backing: 'strongBox' }),
  gateKeyCoordinates: (key: { x: Hex; y: Hex }) => ({ kx: key.x, ky: key.y }),
  signGateCode: (...args: unknown[]) => signGateCode(...args),
}));

const { fromBase64, toBase64 } = await import('@monti/hce-android');
const { CODE_WINDOW_SECONDS, GATE_CODE_ROTATE_MS, MONTI_AID } = await import('../constants');
const { GATE_TAP_ERROR, GateTapError, startGateEmitter } = await import('./emitter');

/**
 * `0x22…` repeated is a low-s value, which is the half of the curve order Solady's
 * `P256.verifySignature` will look at — Task 19 refuses a high one before it ever reaches here.
 */
const DEVICE_SIG = `0x${'22'.repeat(64)}` as const;

/** An answer to a nonce this gate never served — the shape, with nothing behind it. */
const RESPONSE: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: `0x${'ee'.repeat(32)}`,
  deviceSig: DEVICE_SIG,
};

/** What the attendee writes back after reading `code`: v2 names the nonce it answers. */
function answerTo(code: GateCodeWire): GateResponseWire {
  return { v: 2, tokenId: '7', nonce: code.nonce, deviceSig: DEVICE_SIG };
}

/** What the plugin hands JS: one completed NDEF message, standard base64. */
function write(bytes: Uint8Array): void {
  for (const listener of listeners) listener({ ndef: toBase64(bytes) });
}

/** Every code that reached the wire, read back the way the attendee's phone reads it. */
function servedCodes(): GateCodeWire[] {
  return hce.setPayload.mock.calls.map(([options]) => decodeGateCodeMessage(fromBase64(options.ndef)));
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.length = 0;
  hce.start.mockResolvedValue(undefined);
  hce.setPayload.mockResolvedValue(undefined);
  hce.stop.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
  hce.addListener.mockImplementation(async (_name: string, listener: WriteListener) => {
    listeners.push(listener);
    return { remove };
  });
  signGateCode.mockResolvedValue({ r: `0x${'33'.repeat(32)}`, s: `0x${'44'.repeat(32)}` });
});

afterEach(() => {
  vi.useRealTimers();
});

function start(overrides: Partial<Parameters<typeof startGateEmitter>[0]> = {}) {
  return startGateEmitter({ gateId: 7n, eventId: 42n, onTap: () => {}, ...overrides });
}

describe('the rotation loop', () => {
  it('claims the AID and serves a first code before it returns', async () => {
    const emitter = await start();

    expect(hce.start).toHaveBeenCalledWith({ aid: MONTI_AID });
    expect(hce.setPayload).toHaveBeenCalledTimes(1);
    const served = servedCodes();
    expect(served[0]?.gateId).toBe('7');
    expect(served[0]?.eventId).toBe('42');
    expect(emitter.lastCode()).toEqual(served[0]);
  });

  it('listens for writes before it claims the AID, so no tap can arrive unheard', async () => {
    await start();

    expect(hce.addListener).toHaveBeenCalledWith('write', expect.any(Function));
    expect(hce.addListener.mock.invocationCallOrder[0] as number).toBeLessThan(
      hce.start.mock.invocationCallOrder[0] as number,
    );
  });

  it('rotates every 3 s, with a fresh nonce each time', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(3 * GATE_CODE_ROTATE_MS);

    expect(hce.setPayload).toHaveBeenCalledTimes(4);
    expect(new Set(servedCodes().map((code) => code.nonce)).size).toBe(4);
  });

  it('stops the loop and releases the AID', async () => {
    const emitter = await start();
    await emitter.stop();
    await vi.advanceTimersByTimeAsync(3 * GATE_CODE_ROTATE_MS);

    // The plugin empties the served file itself on stop, so a reader arriving after this reads
    // an empty NDEF file rather than a code the gate is no longer standing behind.
    expect(hce.setPayload).toHaveBeenCalledTimes(1);
    expect(hce.stop).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('keeps rotating after a swap the plugin refused, and says so', async () => {
    const onError = vi.fn();
    await start({ onError });
    hce.setPayload.mockRejectedValueOnce(new Error('transient'));
    await vi.advanceTimersByTimeAsync(2 * GATE_CODE_ROTATE_MS);

    expect(onError).toHaveBeenCalledTimes(1);
    // One failed swap is survivable: the code already on the wire is good for a whole minute.
    expect(hce.setPayload).toHaveBeenCalledTimes(3);
  });

  it('hands a refused AID claim back to the caller with nothing left running', async () => {
    // `HcePlugin.start` leaves emulation off when the OS refuses the preferred-service claim,
    // so there is no degraded mode to fall into — the caller shows the persistent warning.
    const claimRefused = Object.assign(new Error('the OS refused the claim'), { code: 'CLAIM_REFUSED' });
    hce.start.mockRejectedValueOnce(claimRefused);

    await expect(start()).rejects.toBe(claimRefused);
    await vi.advanceTimersByTimeAsync(3 * GATE_CODE_ROTATE_MS);
    expect(hce.setPayload).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('a completed tap', () => {
  it('decodes the response and pairs it with the code it names', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    const answer = answerTo(servedCodes()[0] as GateCodeWire);
    write(encodeGateResponseMessage(answer));

    expect(onTap).toHaveBeenCalledTimes(1);
    const tap = onTap.mock.calls[0]?.[0];
    expect(tap.response).toEqual(answer);
    expect(tap.code).toEqual(servedCodes()[0]);
  });

  /**
   * The plugin applies a swap only between taps (Task 5), so a write landing just after a
   * rotation is an answer to the code *before* it. `GateResponseWire` v2 carries the nonce it
   * answers, so the gate looks that code up instead of guessing which side of the swap the read
   * fell on — guessing was what would have refused real attendees at every rotation boundary.
   */
  it('resolves a tap to the older code it actually answers, not to the one now on the wire', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    const answeredCode = servedCodes()[0] as GateCodeWire;
    await vi.advanceTimersByTimeAsync(2 * GATE_CODE_ROTATE_MS);
    write(encodeGateResponseMessage(answerTo(answeredCode)));

    const served = servedCodes();
    expect(served).toHaveLength(3);
    expect(onTap.mock.calls[0]?.[0].code).toEqual(answeredCode);
    expect(onTap.mock.calls[0]?.[0].code).not.toEqual(served[2]);
  });

  it('forgets a code the chain would already refuse as a replay', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    const first = servedCodes()[0] as GateCodeWire;
    await vi.advanceTimersByTimeAsync((CODE_WINDOW_SECONDS + 10) * 1000);
    write(encodeGateResponseMessage(answerTo(first)));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError.mock.calls.at(-1)?.[0].code).toBe(GATE_TAP_ERROR.noLiveCode);

    // The code currently on the wire still answers, so the gate has not simply stopped working.
    write(encodeGateResponseMessage(answerTo(servedCodes().at(-1) as GateCodeWire)));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('never accepts an answer to a code the plugin refused to serve', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    hce.setPayload.mockRejectedValueOnce(new Error('transient'));
    await vi.advanceTimersByTimeAsync(2 * GATE_CODE_ROTATE_MS);

    // Three rotations, one of which never reached the wire: nobody can have read that code, so
    // an answer naming it is not an answer at all.
    const built = servedCodes();
    expect(built).toHaveLength(3);
    onError.mockClear();
    write(encodeGateResponseMessage(answerTo(built[1] as GateCodeWire)));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0].code).toBe(GATE_TAP_ERROR.noLiveCode);
  });

  it('refuses a write that is not a MONTI response instead of guessing', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    write(Uint8Array.from([1, 2, 3]));
    // A gate code coming back at us is another app's tag or a loop, never an answer.
    write(encodeGateCodeMessage(servedCodes()[0] as GateCodeWire));
    // The right shape with no NDEF frame around it is not what the attendee writes either.
    write(encodeGateResponse(RESPONSE));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(3);
    for (const [error] of onError.mock.calls) {
      expect(error).toBeInstanceOf(GateTapError);
      expect(error.code).toBe(GATE_TAP_ERROR.badTag);
    }
  });

  it('refuses a well-formed answer naming a nonce this gate never served', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    write(encodeGateResponseMessage(RESPONSE));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].code).toBe(GATE_TAP_ERROR.noLiveCode);
    // The precise reason survives on `cause` — Task 19's typed error, with its DENY screen.
    expect(onError.mock.calls[0]?.[0].cause.code).toBe('RESPONSE_UNKNOWN_CODE');
    expect(onError.mock.calls[0]?.[0].cause.deny).toBe('EXPIRED_CODE');
  });

  it('refuses an answer whose signature the chain could only reject', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    const answer = answerTo(servedCodes()[0] as GateCodeWire);
    // High s: Solady's P256.verifySignature returns false before it verifies anything.
    write(encodeGateResponseMessage({ ...answer, deviceSig: `0x${'ee'.repeat(64)}` }));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0].cause.code).toBe('RESPONSE_BAD_SIGNATURE');
    expect(onError.mock.calls[0]?.[0].cause.deny).toBe('DEVICE_MISMATCH');
  });

  /**
   * Both halves of a rotation cross a bridge to Android, so `stop()` can land in either gap.
   * A rotation that finished after the stop would push a payload into a file the gate no longer
   * serves and refill the ring `stop()` had just emptied.
   */
  it('abandons a rotation that was in flight when the gate stopped', async () => {
    const emitter = await start();
    const swapsBefore = hce.setPayload.mock.calls.length;

    // The next rotation hangs inside the chip signature, which is where a real one spends its
    // time, and the gate is stopped while it is in there.
    let release = (): void => {};
    signGateCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` });
        }),
    );
    await vi.advanceTimersByTimeAsync(GATE_CODE_ROTATE_MS);
    await emitter.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);

    // Nothing was pushed into a file the gate no longer serves, and the ring stayed empty.
    expect(hce.setPayload.mock.calls.length).toBe(swapsBefore);
    expect(emitter.lastCode()).toBeUndefined();
  });

  it('reports a throw from the caller’s onTap instead of letting it escape the plugin', async () => {
    const onError = vi.fn();
    const boom = new Error('the screen blew up');
    const onTap = vi.fn(() => {
      throw boom;
    });
    await start({ onTap, onError });
    // A throw here would land in Android's listener dispatch, where nothing catches it and the
    // write listener can be lost — leaving a gate that looks open and reads nothing.
    expect(() => write(encodeGateResponseMessage(answerTo(servedCodes()[0] as GateCodeWire)))).not.toThrow();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('drops a tap that lands after the gate was stopped', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    const emitter = await start({ onTap, onError });
    await emitter.stop();
    write(encodeGateResponseMessage(RESPONSE));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(emitter.lastCode()).toBeUndefined();
  });
});
