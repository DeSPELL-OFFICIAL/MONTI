import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { encodeGateCode } from '@monti/shared';

const isNativePlatform = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => isNativePlatform() } }));
// native.ts pulls in plugin.ts, whose import registers the Capacitor plugin. These tests never
// reach the native branch, but the module graph still has to load.
vi.mock('@capgo/capacitor-nfc', () => ({
  CapacitorNfc: { startScanning: vi.fn(), stopScanning: vi.fn(), write: vi.fn(), addListener: vi.fn() },
}));

const { NFC_ERROR, nfcCapability, readThenWrite } = await import('./index');

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

interface WrittenMessage {
  records: Array<{ recordType: string; data: Uint8Array }>;
}

/** Stands in for Chrome Android's NDEFReader. */
class FakeNdefReader {
  static last: FakeNdefReader | undefined;
  readonly written: WrittenMessage[] = [];
  scanned = false;
  private readonly handlers = new Map<string, (event: unknown) => void>();

  constructor() {
    FakeNdefReader.last = this;
  }

  async scan(): Promise<void> {
    this.scanned = true;
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.handlers.set(name, handler);
  }

  async write(message: WrittenMessage): Promise<void> {
    this.written.push(message);
  }

  present(payload: Uint8Array, recordType = 'monti.app:g'): void {
    const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    this.handlers.get('reading')?.({ message: { records: [{ recordType, data }] } });
  }
}

beforeEach(() => {
  isNativePlatform.mockReturnValue(false);
  FakeNdefReader.last = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nfc capability', () => {
  it('is native inside the app shell', () => {
    isNativePlatform.mockReturnValue(true);
    expect(nfcCapability()).toBe('native');
  });

  it('is webnfc on a browser that exposes NDEFReader', () => {
    vi.stubGlobal('NDEFReader', FakeNdefReader);
    expect(nfcCapability()).toBe('webnfc');
  });

  it('is none on a browser without it, and refuses rather than pretending a tap happened', async () => {
    expect(nfcCapability()).toBe('none');
    await expect(readThenWrite(async () => RESPONSE)).rejects.toMatchObject({
      code: NFC_ERROR.unavailable,
    });
  });

  it('reads the gate code and writes the signed answer through Web NFC', async () => {
    vi.stubGlobal('NDEFReader', FakeNdefReader);
    const sign = vi.fn(async () => RESPONSE);
    const tap = readThenWrite(sign);
    await vi.waitFor(() => expect(FakeNdefReader.last?.scanned).toBe(true));
    FakeNdefReader.last?.present(encodeGateCode(GATE_CODE));
    await tap;

    expect(sign).toHaveBeenCalledWith(GATE_CODE);
    const message = FakeNdefReader.last?.written[0];
    expect(message?.records[0]?.recordType).toBe('monti.app:s');
    expect(message?.records[0]?.data.byteLength).toBeGreaterThan(140);
  });

  it('ignores a tag that carries some other external record', async () => {
    vi.stubGlobal('NDEFReader', FakeNdefReader);
    const tap = readThenWrite(async () => RESPONSE);
    await vi.waitFor(() => expect(FakeNdefReader.last?.scanned).toBe(true));
    FakeNdefReader.last?.present(encodeGateCode(GATE_CODE), 'android.com:pkg');
    await expect(tap).rejects.toMatchObject({ code: NFC_ERROR.noGateRecord });
  });
});
