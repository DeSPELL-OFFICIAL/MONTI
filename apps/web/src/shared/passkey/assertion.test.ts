import { describe, expect, it, vi } from 'vitest';
import { base64UrlEncode } from '@monti/shared';

vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.despell.io' }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

/** The authenticator, standing in for the browser: whatever it is asked to sign, it signs. */
const sign = vi.fn(async (_options: { hash: string }) => ({
  signature: '0x00',
  webauthn: { authenticatorData: '0x010203', clientDataJSON: '{}', challengeIndex: 0, typeIndex: 0 },
  raw: {
    id: 'cred',
    rawId: new Uint8Array([0x63, 0x72, 0x65, 0x64]).buffer,
    type: 'public-key',
    response: {
      clientDataJSON: new Uint8Array([0x7b, 0x7d]).buffer,
      authenticatorData: new Uint8Array([0x01, 0x02, 0x03]).buffer,
      signature: new Uint8Array([0x30, 0x44]).buffer,
      userHandle: null,
    },
  },
}));
const toWebAuthnAccount = vi.fn((parameters: { credential: { id: string }; rpId?: string }) => ({
  ...parameters,
  id: parameters.credential.id,
  type: 'webAuthn',
  sign,
}));
vi.mock('viem/account-abstraction', async (orig) => ({
  ...(await orig<typeof import('viem/account-abstraction')>()),
  toWebAuthnAccount,
}));

const { challengeToHash, toAssertionJson, signPasskeyAssertion, storeCredential } = await import('./index');

const CHALLENGE = base64UrlEncode(new Uint8Array(32).fill(0x2a));

describe('challengeToHash', () => {
  it('turns the base64url challenge into the hex the signer takes, byte for byte', () => {
    expect(challengeToHash(CHALLENGE)).toBe(`0x${'2a'.repeat(32)}`);
  });

  it('accepts an unpadded challenge of any length the server may mint', () => {
    expect(challengeToHash(base64UrlEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef])))).toBe('0xdeadbeef');
  });
});

describe('toAssertionJson', () => {
  it('base64urls every binary field loginVerify reads', () => {
    const assertion = toAssertionJson({
      id: 'cred',
      rawId: new Uint8Array([0x63, 0x72, 0x65, 0x64]).buffer,
      response: {
        clientDataJSON: new Uint8Array([0x7b, 0x7d]).buffer,
        authenticatorData: new Uint8Array([0x01, 0x02, 0x03]).buffer,
        signature: new Uint8Array([0x30, 0x44]).buffer,
        userHandle: new Uint8Array([0x09]).buffer,
      },
    });
    expect(assertion).toEqual({
      id: 'cred',
      rawId: 'Y3JlZA',
      type: 'public-key',
      response: {
        clientDataJSON: 'e30',
        authenticatorData: 'AQID',
        signature: 'MEQ',
        userHandle: 'CQ',
      },
      clientExtensionResults: {},
    });
  });

  it('omits a userHandle the authenticator did not return', () => {
    const assertion = toAssertionJson({
      id: 'cred',
      rawId: new Uint8Array([0x63]).buffer,
      response: {
        clientDataJSON: new Uint8Array([0x7b]).buffer,
        authenticatorData: new Uint8Array([0x01]).buffer,
        signature: new Uint8Array([0x30]).buffer,
        userHandle: null,
      },
    });
    expect('userHandle' in assertion.response).toBe(false);
  });

  it('refuses a credential whose binary fields are missing rather than sending empty strings', () => {
    expect(() => toAssertionJson({ id: 'cred', response: {} })).toThrow();
    expect(() => toAssertionJson({ response: {} })).toThrow();
  });
});

describe('signPasskeyAssertion', () => {
  it('signs the server challenge with the stored credential and returns wire JSON', async () => {
    storeCredential({
      id: 'cred',
      publicKey: `0x04${'cd'.repeat(64)}`,
      transports: ['internal'],
      attestationJson: '{}',
    });

    const assertion = await signPasskeyAssertion(CHALLENGE);

    // The challenge reaches the authenticator as the hash it signs, and the stored credential
    // is the one asked — a different credential would resolve to a different account.
    expect(toWebAuthnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ credential: expect.objectContaining({ id: 'cred' }), rpId: 'monti.despell.io' }),
    );
    expect(sign).toHaveBeenCalledWith({ hash: `0x${'2a'.repeat(32)}` });
    expect(assertion).toMatchObject({ id: 'cred', response: { clientDataJSON: 'e30' } });
  });
});
