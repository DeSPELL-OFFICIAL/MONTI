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

const RESPONSE: GateResponseWire = { v: 1, tokenId: '7', deviceSig: `0x${'ab'.repeat(64)}` };

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
  it('decodes the response and pairs it with the code on the wire', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    write(encodeGateResponseMessage(RESPONSE));

    expect(onTap).toHaveBeenCalledTimes(1);
    const tap = onTap.mock.calls[0]?.[0];
    expect(tap.response).toEqual(RESPONSE);
    expect(tap.codes).toEqual(servedCodes());
  });

  /**
   * The plugin applies a swap only between taps (Task 5), so a write landing just after a
   * rotation is an answer to the code before it. The response cannot say which: it is
   * `{ v, tokenId, deviceSig }` and carries no nonce. So every code still inside the chain's
   * window is offered, newest first, and the sender picks the one whose `deviceSig` verifies
   * against the snapshot's device key. Offering only the newest would refuse real attendees.
   */
  it('offers the codes before it too, newest first', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    await vi.advanceTimersByTimeAsync(2 * GATE_CODE_ROTATE_MS);
    write(encodeGateResponseMessage(RESPONSE));

    const served = servedCodes();
    expect(served).toHaveLength(3);
    expect(onTap.mock.calls[0]?.[0].codes).toEqual([served[2], served[1], served[0]]);
  });

  it('forgets a code the chain would already refuse as a replay', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    await vi.advanceTimersByTimeAsync((CODE_WINDOW_SECONDS + 10) * 1000);
    write(encodeGateResponseMessage(RESPONSE));

    const offered: GateCodeWire[] = onTap.mock.calls[0]?.[0].codes;
    const oldest = offered.at(-1) as GateCodeWire;
    expect(offered.length).toBeLessThan(hce.setPayload.mock.calls.length);
    expect(Math.floor(Date.now() / 1000) - oldest.issuedAt).toBeLessThanOrEqual(CODE_WINDOW_SECONDS + 5);
  });

  it('never offers a code the plugin refused to serve', async () => {
    const onTap = vi.fn();
    await start({ onTap });
    hce.setPayload.mockRejectedValueOnce(new Error('transient'));
    await vi.advanceTimersByTimeAsync(2 * GATE_CODE_ROTATE_MS);
    write(encodeGateResponseMessage(RESPONSE));

    // Three rotations, one of which never reached the wire: a code nobody was served cannot be
    // the one that was answered.
    expect(onTap.mock.calls[0]?.[0].codes).toHaveLength(2);
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

  it('refuses a well-formed answer to a code no chain would still accept', async () => {
    const onTap = vi.fn();
    const onError = vi.fn();
    await start({ onTap, onError });
    // Every swap fails, so nothing new reaches the wire and the ring ages out. Admitting on a
    // code the chain now calls expired would queue a check-in that can only ever revert.
    hce.setPayload.mockRejectedValue(new Error('transient'));
    await vi.advanceTimersByTimeAsync((CODE_WINDOW_SECONDS + 10) * 1000);
    onError.mockClear();
    write(encodeGateResponseMessage(RESPONSE));

    expect(onTap).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].code).toBe(GATE_TAP_ERROR.noLiveCode);
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
