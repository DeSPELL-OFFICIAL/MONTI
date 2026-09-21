import { encode as encodeCbor } from 'cbor-x';
import * as Base64 from 'ox/Base64';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isNativePlatform = vi.fn(() => false);
vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.app' }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => isNativePlatform() } }));

const createCredential = vi.fn(async (_options: unknown) => ({
  id: 'Y3JlZC1pZA',
  publicKey: { prefix: 4, x: 0x11n, y: 0x22n },
  raw: { id: 'Y3JlZC1pZA', response: { clientDataJSON: 'e30', attestationObject: 'o2M' }, type: 'public-key' },
}));
vi.mock('ox/WebAuthnP256', () => ({ createCredential }));

function toBase64Url(bytes: Uint8Array): string {
  return Base64.fromBytes(bytes, { url: true, pad: false });
}

/** A minimal but well-formed ES256 attestation object, the way an authenticator returns one. */
function attestationObject(fill: number): string {
  const cose = encodeCbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(32).fill(fill)],
      [-3, new Uint8Array(32).fill(fill)],
    ]),
  );
  const authData = new Uint8Array(55 + 16 + cose.length);
  authData[32] = 0x45;
  authData.set([0x00, 16], 53);
  authData.set(cose, 71);
  return toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData }));
}

const nativeCreateCredential = vi.fn(async (_options: unknown) => ({
  id: 'Y3JlZC1pZA',
  rawId: 'Y3JlZC1pZA',
  type: 'public-key' as const,
  clientExtensionResults: {},
  response: { clientDataJSON: 'e30', attestationObject: attestationObject(0x11) },
}));
const nativeGetCredential = vi.fn(async (_options: unknown) => ({
  id: 'Y3JlZC1pZA',
  rawId: 'Y3JlZC1pZA',
  type: 'public-key' as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: toBase64Url(new Uint8Array([0x7b, 0x7d])),
    authenticatorData: toBase64Url(new Uint8Array([0x01, 0x02, 0x03])),
    signature: toBase64Url(new Uint8Array([0x30, 0x44])),
    userHandle: toBase64Url(new Uint8Array([0x09])),
  },
}));
const signalAllAcceptedCredentials = vi.fn();
vi.mock('@capgo/capacitor-passkey', () => ({
  CapacitorPasskey: {
    createCredential: nativeCreateCredential,
    getCredential: nativeGetCredential,
    signalAllAcceptedCredentials,
  },
}));

const { createPasskey, storedCredential, clearCredential } = await import('./index');
const { getFnNative } = await import('./native');

beforeEach(() => {
  clearCredential();
  isNativePlatform.mockReturnValue(false);
});

describe('createPasskey (web)', () => {
  it('asks for a resident key with user verification and stores what registerPasskey needs', async () => {
    const credential = await createPasskey('MONTI');
    const options = createCredential.mock.calls[0]![0] as {
      rp: { id: string };
      authenticatorSelection: { residentKey: string; userVerification: string };
    };
    expect(options.rp.id).toBe('monti.app');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(credential.id).toBe('Y3JlZC1pZA');
    // 0x04 || x(32) || y(32) — the uncompressed point viem hands to toCoinbaseSmartAccount.
    expect(credential.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(JSON.parse(credential.attestationJson).type).toBe('public-key');
    expect(storedCredential()?.id).toBe('Y3JlZC1pZA');
  });
});

describe('createPasskey (native)', () => {
  beforeEach(() => isNativePlatform.mockReturnValue(true));

  it('sends a JSON-safe request under publicKey and stores the same credential shape as the web path', async () => {
    const credential = await createPasskey('MONTI');
    const request = nativeCreateCredential.mock.calls[0]![0] as {
      publicKey: {
        rp: { id: string; name: string };
        user: { id: string; name: string };
        challenge: string;
        pubKeyCredParams: Array<{ type: string; alg: number }>;
        authenticatorSelection: { residentKey: string; userVerification: string };
      };
    };
    expect(request.publicKey.rp.id).toBe('monti.app');
    expect(request.publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(request.publicKey.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(request.publicKey.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.id).toBe('Y3JlZC1pZA');
    expect(credential.publicKey).toBe(`0x04${'11'.repeat(32)}${'11'.repeat(32)}`);
    expect(Object.keys(credential).sort()).toEqual(['attestationJson', 'id', 'publicKey', 'transports']);
    expect(storedCredential()?.publicKey).toBe(credential.publicKey);
    expect(signalAllAcceptedCredentials).not.toHaveBeenCalled();
  });
});

describe('storedCredential', () => {
  it('drops a corrupt entry instead of throwing, so the caller can register again', () => {
    localStorage.setItem('monti.passkey', '{"id":"Y3JlZC1pZA"');
    expect(storedCredential()).toBeNull();
    expect(localStorage.getItem('monti.passkey')).toBeNull();
  });
});

describe('getFnNative', () => {
  it('hands viem the same binary credential a browser would', async () => {
    const assertion = await getFnNative({
      publicKey: {
        challenge: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        rpId: 'monti.app',
        userVerification: 'required',
        allowCredentials: [{ id: new Uint8Array([0x63, 0x72, 0x65, 0x64]), type: 'public-key' }],
      },
    });
    const request = nativeGetCredential.mock.calls[0]![0] as {
      publicKey: {
        challenge: string;
        rpId: string;
        userVerification: string;
        allowCredentials: Array<{ id: string; type: string }>;
      };
    };
    expect(request.publicKey.challenge).toBe('3q2-7w');
    expect(request.publicKey.rpId).toBe('monti.app');
    expect(request.publicKey.userVerification).toBe('required');
    expect(request.publicKey.allowCredentials).toEqual([{ id: 'Y3JlZA', type: 'public-key' }]);

    const raw = assertion as unknown as {
      id: string;
      type: string;
      rawId: ArrayBuffer;
      response: {
        clientDataJSON: ArrayBuffer;
        authenticatorData: ArrayBuffer;
        signature: ArrayBuffer;
        userHandle: ArrayBuffer | null;
      };
    };
    expect(raw.type).toBe('public-key');
    expect(raw.rawId).toBeInstanceOf(ArrayBuffer);
    expect(raw.response.clientDataJSON).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(raw.response.clientDataJSON)]).toEqual([0x7b, 0x7d]);
    expect([...new Uint8Array(raw.response.authenticatorData)]).toEqual([0x01, 0x02, 0x03]);
    expect([...new Uint8Array(raw.response.signature)]).toEqual([0x30, 0x44]);
    expect([...new Uint8Array(raw.response.userHandle!)]).toEqual([0x09]);
    expect(signalAllAcceptedCredentials).not.toHaveBeenCalled();
  });
});
