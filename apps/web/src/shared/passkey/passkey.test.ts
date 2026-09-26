import { encode as encodeCbor } from 'cbor-x';
import * as Base64 from 'ox/Base64';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isNativePlatform = vi.fn(() => false);
vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.despell.io' }) }));
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

/** Exactly what loginChallenge mints: 32 random bytes, base64url, 43 characters. */
const CHALLENGE_BYTES = new Uint8Array(32).fill(0x2a);
const CHALLENGE = toBase64Url(CHALLENGE_BYTES);

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

const { createPasskey, getPasskeyAccount, storedCredential, clearCredential, NoPasskeyOnDevice } =
  await import('./index');
const { getFnNative } = await import('./native');

beforeEach(() => {
  clearCredential();
  isNativePlatform.mockReturnValue(false);
});

describe('createPasskey (web)', () => {
  it('asks for a resident key with user verification and stores what registerPasskey needs', async () => {
    const credential = await createPasskey('MONTI', CHALLENGE);
    const options = createCredential.mock.calls[0]![0] as {
      rp: { id: string };
      challenge: Uint8Array;
      authenticatorSelection: { residentKey: string; userVerification: string };
    };
    expect(options.rp.id).toBe('monti.despell.io');
    // The server looks the attestation's challenge up as a document id; ox would otherwise
    // invent one and registerPasskey would answer CHALLENGE_NOT_FOUND every time.
    expect([...options.challenge]).toEqual([...CHALLENGE_BYTES]);
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(credential.id).toBe('Y3JlZC1pZA');
    // 0x04 || x(32) || y(32) — the uncompressed point the authenticator produced. The smart
    // account owner drops that prefix; getPasskeyAccount is the one place that converts.
    expect(credential.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(JSON.parse(credential.attestationJson).type).toBe('public-key');
    expect(storedCredential()?.id).toBe('Y3JlZC1pZA');
  });
});

describe('createPasskey (native)', () => {
  beforeEach(() => isNativePlatform.mockReturnValue(true));

  it('sends a JSON-safe request under publicKey and stores the same credential shape as the web path', async () => {
    const credential = await createPasskey('MONTI', CHALLENGE);
    const request = nativeCreateCredential.mock.calls[0]![0] as {
      publicKey: {
        rp: { id: string; name: string };
        user: { id: string; name: string };
        challenge: string;
        pubKeyCredParams: Array<{ type: string; alg: number }>;
        authenticatorSelection: { residentKey: string; userVerification: string };
      };
    };
    expect(request.publicKey.rp.id).toBe('monti.despell.io');
    expect(request.publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(request.publicKey.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    // Native speaks base64url already, so the server's challenge travels through untouched.
    expect(request.publicKey.challenge).toBe(CHALLENGE);
    expect(credential.id).toBe('Y3JlZC1pZA');
    expect(credential.publicKey).toBe(`0x04${'11'.repeat(32)}${'11'.repeat(32)}`);
    expect(Object.keys(credential).sort()).toEqual(['attestationJson', 'id', 'publicKey', 'transports']);
    expect(storedCredential()?.publicKey).toBe(credential.publicKey);
    expect(signalAllAcceptedCredentials).not.toHaveBeenCalled();
  });
});

describe('getPasskeyAccount', () => {
  it('owns the account with the 64-byte x || y, not the stored uncompressed point', async () => {
    const credential = await createPasskey('MONTI', CHALLENGE);
    const account = await getPasskeyAccount();

    // viem hands a webAuthn owner to the factory verbatim, and registerPasskey salts the
    // address over ownerBytes(x, y) (functions/src/lib/webauthn.ts). 65 bytes here would
    // predict an address the server, the Identity contract and the rules have never seen.
    expect(account.publicKey).toBe(`0x${credential.publicKey.slice(4)}`);
    expect((account.publicKey.length - 2) / 2).toBe(64);
  });

  it('throws NoPasskeyOnDevice when nothing is stored, so sign-in can say "sign up first"', async () => {
    clearCredential();
    await expect(getPasskeyAccount()).rejects.toBeInstanceOf(NoPasskeyOnDevice);
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
        rpId: 'monti.despell.io',
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
    expect(request.publicKey.rpId).toBe('monti.despell.io');
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
