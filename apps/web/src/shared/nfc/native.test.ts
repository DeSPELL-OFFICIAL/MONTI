import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { encodeGateCode } from '@monti/shared';

const startScanning = vi.fn();
const stopScanning = vi.fn();
const write = vi.fn();
const listeners = new Map<string, (event: unknown) => void>();
const removed: string[] = [];
const addListener = vi.fn();

// Only `CapacitorNfc` is replaced, so `plugin.ts` — the one file that speaks the plugin's own
// vocabulary — runs for real and these tests fail if the plugin renames an event or a field.
vi.mock('@capgo/capacitor-nfc', () => ({ CapacitorNfc: { startScanning, stopScanning, write, addListener } }));

const { NFC_ERROR } = await import('./errors');
const { readGateCodeNative, readThenWriteNative, writeGateResponseNative } = await import('./native');

const GATE_CODE: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '3',
  issuedAt: 1790000000,
  nonce: `0x${'11'.repeat(32)}`,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};
const RESPONSE: GateResponseWire = { v: 1, tokenId: '42', deviceSig: `0x${'ab'.repeat(64)}` };

const typeBytes = (type: string): number[] => [...type].map((character) => character.charCodeAt(0));

/** The shape the native layer hands to `ndefDiscovered`: a tag, with the message inside it. */
function emitTag(records: Array<{ tnf: number; type: number[]; id: number[]; payload: number[] }>): void {
  listeners.get('ndefDiscovered')?.({ type: 'ndef', tag: { ndefMessage: records } });
}

function emitSessionEnd(reason: string): void {
  listeners.get('nfcSessionEnd')?.({ reason });
}

function gateCodeRecord(): { tnf: number; type: number[]; id: number[]; payload: number[] } {
  return { tnf: 4, type: typeBytes('monti.app:g'), id: [], payload: [...encodeGateCode(GATE_CODE)] };
}

/** Lets the module register its listeners and reach `startScanning` before the tap arrives. */
const scanning = (): Promise<void> => vi.waitFor(() => expect(startScanning).toHaveBeenCalled());

beforeEach(() => {
  listeners.clear();
  removed.length = 0;
  startScanning.mockResolvedValue(undefined);
  stopScanning.mockResolvedValue(undefined);
  write.mockResolvedValue(undefined);
  addListener.mockImplementation(async (name: string, handler: (event: unknown) => void) => {
    listeners.set(name, handler);
    return {
      remove: async () => {
        removed.push(name);
        listeners.delete(name);
      },
    };
  });
});

describe('native nfc session', () => {
  it('reads the gate code and writes the answer without closing the session in between', async () => {
    const sign = vi.fn(async (code: GateCodeWire) => {
      // The write has to be reachable while the reader session is still open: iOS binds the
      // write to the tag discovered in this session, so a stopScanning here loses the tag.
      expect(stopScanning).not.toHaveBeenCalled();
      expect(code).toEqual(GATE_CODE);
      return RESPONSE;
    });
    const tap = readThenWriteNative(sign);
    await scanning();
    emitTag([gateCodeRecord()]);
    await tap;

    expect(sign).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      records: [{ tnf: 4, type: typeBytes('monti.app:s'), id: [], payload: expect.any(Array) }],
    });
    expect(write.mock.calls[0]?.[0].records[0].payload.length).toBeGreaterThan(140);
    expect(stopScanning).toHaveBeenCalledTimes(1);
    expect(removed).toEqual(['ndefDiscovered', 'nfcSessionEnd']);
  });

  it('registers both listeners before scanning, so a fast tap cannot arrive first', async () => {
    const tap = readGateCodeNative();
    await scanning();
    expect(addListener).toHaveBeenCalledWith('ndefDiscovered', expect.any(Function));
    expect(addListener).toHaveBeenCalledWith('nfcSessionEnd', expect.any(Function));
    for (const order of addListener.mock.invocationCallOrder) {
      expect(order).toBeLessThan(startScanning.mock.invocationCallOrder[0] as number);
    }
    emitTag([gateCodeRecord()]);
    await expect(tap).resolves.toEqual(GATE_CODE);
  });

  it('keeps the iOS session alive past the first read instead of taking the plugin default', async () => {
    const tap = readGateCodeNative();
    await scanning();
    expect(startScanning).toHaveBeenCalledWith({ invalidateAfterFirstRead: false });
    emitTag([gateCodeRecord()]);
    await tap;
  });

  it('ignores records of any other external type and reports no gate record', async () => {
    const tap = readGateCodeNative();
    await scanning();
    emitTag([{ tnf: 4, type: typeBytes('monti.app:s'), id: [], payload: [1, 2, 3] }]);
    await expect(tap).rejects.toMatchObject({ code: NFC_ERROR.noGateRecord });
    expect(stopScanning).toHaveBeenCalledTimes(1);
    expect(removed).toEqual(['ndefDiscovered', 'nfcSessionEnd']);
  });

  it('turns each way an iOS session can end into its own code', async () => {
    const cancelled = readGateCodeNative();
    await scanning();
    emitSessionEnd('userCancelled');
    await expect(cancelled).rejects.toMatchObject({ code: NFC_ERROR.cancelled });

    startScanning.mockClear();
    const timedOut = readGateCodeNative();
    await scanning();
    emitSessionEnd('sessionTimeout');
    await expect(timedOut).rejects.toMatchObject({ code: NFC_ERROR.timeout });

    startScanning.mockClear();
    const lost = readGateCodeNative();
    await scanning();
    emitSessionEnd('invalidated');
    await expect(lost).rejects.toMatchObject({ code: NFC_ERROR.tagLost });
  });

  it('tears the session down even when signing throws', async () => {
    const tap = readThenWriteNative(async () => {
      throw new Error('SIGN_REFUSED');
    });
    await scanning();
    emitTag([gateCodeRecord()]);
    await expect(tap).rejects.toThrow('SIGN_REFUSED');
    expect(write).not.toHaveBeenCalled();
    expect(stopScanning).toHaveBeenCalledTimes(1);
    expect(removed).toEqual(['ndefDiscovered', 'nfcSessionEnd']);
  });

  it('writes into a session someone else already opened, without starting one', async () => {
    await writeGateResponseNative(RESPONSE);
    expect(startScanning).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith({
      records: [{ tnf: 4, type: typeBytes('monti.app:s'), id: [], payload: expect.any(Array) }],
    });
  });
});
