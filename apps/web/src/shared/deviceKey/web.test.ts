import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P256_HALF_ORDER, P256_ORDER, joinRs, type Hex } from '@monti/shared';

/**
 * `vi.resetModules()` hands every reload a fresh `DeviceKeyUnavailable` class, so the name is
 * what the assertion pins — the same contract `Device.tsx` branches on for exactly that reason.
 */
async function expectUnavailable(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ name: 'DeviceKeyUnavailable' });
}

/**
 * jsdom has no IndexedDB, so the store is stood up here rather than pulled in as a dependency.
 * It implements exactly the four things web.ts uses — open with an upgrade, get, put, close —
 * and fires its callbacks asynchronously, which is the part a synchronous stub would get wrong:
 * web.ts attaches its handlers after the request object exists.
 */
class FakeStore {
  constructor(private readonly data: Map<string, unknown>) {}
  get(key: string) {
    return fakeRequest(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    return fakeRequest(() => {
      this.data.set(key, value);
      return undefined;
    });
  }
}

function fakeRequest<T>(run: () => T) {
  const request: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.();
    } catch (cause) {
      request.error = cause;
      request.onerror?.();
    }
  });
  return request;
}

/** Survives a "reload": the page's module state is thrown away, the browser's store is not. */
let disk = new Map<string, Map<string, unknown>>();
let openFailure: Error | null = null;

function installFakeIndexedDb(): void {
  (globalThis as Record<string, unknown>)['indexedDB'] = {
    open(name: string) {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        if (openFailure) {
          request['error'] = openFailure;
          (request['onerror'] as (() => void) | undefined)?.();
          return;
        }
        const fresh = !disk.has(name);
        const data = disk.get(name) ?? new Map<string, unknown>();
        disk.set(name, data);
        const names = { contains: () => !fresh };
        request['result'] = {
          objectStoreNames: names,
          createObjectStore: () => undefined,
          transaction: () => ({ objectStore: () => new FakeStore(data) }),
          close: () => undefined,
        };
        (request['onupgradeneeded'] as (() => void) | undefined)?.();
        (request['onsuccess'] as (() => void) | undefined)?.();
      });
      return request;
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import('./web');
}

const ALIAS = 'monti-attendee';
const DIGEST = `0x${'ab'.repeat(32)}` as Hex;
const digestBytes = hexToBytes(DIGEST);

function hexToBytes(hex: Hex): Uint8Array<ArrayBuffer> {
  const pairs = hex.slice(2).match(/../g) ?? [];
  const bytes = new Uint8Array(new ArrayBuffer(pairs.length));
  for (let i = 0; i < pairs.length; i += 1) bytes[i] = Number.parseInt(pairs[i] as string, 16);
  return bytes;
}

/** The exported public half, imported back as a verify key — the only way to prove x, y are real. */
async function verifier(x: Hex, y: Hex): Promise<CryptoKey> {
  const raw = new Uint8Array(new ArrayBuffer(65));
  raw[0] = 0x04;
  raw.set(hexToBytes(x), 1);
  raw.set(hexToBytes(y), 33);
  return crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

function verify(key: CryptoKey, signature: Hex, message: BufferSource): Promise<boolean> {
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, hexToBytes(signature), message);
}

beforeEach(() => {
  disk = new Map();
  openFailure = null;
  installFakeIndexedDb();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['indexedDB'];
});

describe('browser device key', () => {
  it('mints a non-extractable P-256 key and answers with the point registerIdentity puts on chain', async () => {
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');
    const { ensureDeviceKeyWeb } = await loadModule();

    const { x, y, backing } = await ensureDeviceKeyWeb({ alias: ALIAS });

    expect(x).toMatch(/^0x[0-9a-f]{64}$/);
    expect(y).toMatch(/^0x[0-9a-f]{64}$/);
    // The backend's B32_RE is the same shape, and the contract refuses a zero coordinate.
    expect(BigInt(x)).not.toBe(0n);
    expect(BigInt(y)).not.toBe(0n);
    // Software is software: claiming secure hardware here would be a lie the gate believes.
    expect(backing).toBeUndefined();
    expect(generateKey).toHaveBeenCalledWith({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const pair = (await generateKey.mock.results[0]!.value) as CryptoKeyPair;
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.usages).toEqual(['sign']);
  });

  it('returns the stored key on a second call instead of minting a second one', async () => {
    const { ensureDeviceKeyWeb } = await loadModule();
    const first = await ensureDeviceKeyWeb({ alias: ALIAS });
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');

    const second = await ensureDeviceKeyWeb({ alias: ALIAS });

    expect(second).toEqual(first);
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('survives a reload: the key is read back out of IndexedDB, not minted again', async () => {
    const before = await (await loadModule()).ensureDeviceKeyWeb({ alias: ALIAS });
    // A new module instance is what a reload actually is — the in-page cache is gone.
    const reloaded = await loadModule();
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');

    await expect(reloaded.ensureDeviceKeyWeb({ alias: ALIAS })).resolves.toEqual(before);
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('keeps a second alias in its own record', async () => {
    const { ensureDeviceKeyWeb } = await loadModule();
    const attendee = await ensureDeviceKeyWeb({ alias: ALIAS });
    const gate = await ensureDeviceKeyWeb({ alias: 'monti-gate' });
    expect(gate.x).not.toBe(attendee.x);
  });

  it('never mints two keys when two callers race', async () => {
    const { ensureDeviceKeyWeb } = await loadModule();
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');

    const [a, b] = await Promise.all([
      ensureDeviceKeyWeb({ alias: ALIAS }),
      ensureDeviceKeyWeb({ alias: ALIAS }),
    ]);

    expect(a).toEqual(b);
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it('signs with the stored key: r, s verify against the x, y it registered', async () => {
    const { ensureDeviceKeyWeb, signWithDeviceKeyWeb } = await loadModule();
    const { x, y } = await ensureDeviceKeyWeb({ alias: ALIAS });

    const { r, s } = await signWithDeviceKeyWeb(DIGEST, { alias: ALIAS });

    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(verify(await verifier(x, y), joinRs(r, s), digestBytes)).resolves.toBe(true);
  });

  it('normalises s into the low half — the fixed vector both halves verify against', async () => {
    const { ensureDeviceKeyWeb, signWithDeviceKeyWeb } = await loadModule();
    const { x, y } = await ensureDeviceKeyWeb({ alias: ALIAS });
    const key = await verifier(x, y);

    const { r, s } = await signWithDeviceKeyWeb(DIGEST, { alias: ALIAS });
    // Solady's P256.verifySignature refuses anything above n/2, so this is the invariant.
    expect(BigInt(s) <= P256_HALF_ORDER).toBe(true);

    // ECDSA malleability, pinned: (r, n - s) is a second valid signature over the same message
    // and key. WebCrypto accepts both, the chain accepts only the low one, and `toLowS` is what
    // maps one to the other — so the flipped vector must verify and must map back to `s`.
    const flipped = `0x${(P256_ORDER - BigInt(s)).toString(16).padStart(64, '0')}` as Hex;
    expect(BigInt(flipped) > P256_HALF_ORDER).toBe(true);
    await expect(verify(key, joinRs(r, flipped), digestBytes)).resolves.toBe(true);
    const { toLowS } = await import('./lowS');
    expect(toLowS(flipped)).toBe(s);
  });

  it('signs a preimage of any length, so a browser claim is signed over the digest', async () => {
    const { ensureDeviceKeyWeb, signWithDeviceKeyWeb } = await loadModule();
    const { x, y } = await ensureDeviceKeyWeb({ alias: ALIAS });
    // 256 bytes — the shape of claimAuthPreimage; the old 32-byte guard would have refused it.
    const preimage = `0x${'cd'.repeat(256)}` as Hex;

    const { r, s } = await signWithDeviceKeyWeb(preimage, { alias: ALIAS });

    // WebCrypto hashed the preimage, so r‖s verifies over it — i.e. over its SHA-256, the digest.
    await expect(verify(await verifier(x, y), joinRs(r, s), hexToBytes(preimage))).resolves.toBe(true);
    expect(BigInt(s) <= P256_HALF_ORDER).toBe(true);
  });

  it('refuses malformed hex rather than signing whatever it was handed', async () => {
    const { signWithDeviceKeyWeb } = await loadModule();
    await expect(signWithDeviceKeyWeb('0xabc' as Hex, { alias: ALIAS })).rejects.toThrow('BAD_MESSAGE'); // odd length
    await expect(signWithDeviceKeyWeb('0x' as Hex, { alias: ALIAS })).rejects.toThrow('BAD_MESSAGE'); // empty
  });

  it('reports the key as unavailable when the browser has no IndexedDB', async () => {
    delete (globalThis as Record<string, unknown>)['indexedDB'];
    const { ensureDeviceKeyWeb } = await loadModule();
    await expectUnavailable(ensureDeviceKeyWeb({ alias: ALIAS }));
  });

  it('reports the key as unavailable when opening the store is refused (private mode)', async () => {
    openFailure = new Error('SecurityError');
    const { ensureDeviceKeyWeb } = await loadModule();
    await expectUnavailable(ensureDeviceKeyWeb({ alias: ALIAS }));
  });

  it('lets a later attempt succeed instead of remembering the refusal forever', async () => {
    openFailure = new Error('SecurityError');
    const { ensureDeviceKeyWeb } = await loadModule();
    await expectUnavailable(ensureDeviceKeyWeb({ alias: ALIAS }));

    openFailure = null;
    await expect(ensureDeviceKeyWeb({ alias: ALIAS })).resolves.toMatchObject({ x: expect.any(String) });
  });

  it('reports the key as unavailable when WebCrypto is missing', async () => {
    const subtle = crypto.subtle;
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try {
      const { ensureDeviceKeyWeb } = await loadModule();
      await expectUnavailable(ensureDeviceKeyWeb({ alias: ALIAS }));
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
    }
  });

  /**
   * Entry is native-only. A browser that reported itself armed would walk into a real Web NFC
   * tap on Android Chrome and hand the gate a signature the chain refuses.
   */
  it('refuses to arm, which is what keeps a browser out of the gate flow', async () => {
    const { armDeviceKeyWeb } = await loadModule();
    await expectUnavailable(armDeviceKeyWeb());
  });
});
