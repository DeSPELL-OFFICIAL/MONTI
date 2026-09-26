import { p256 } from '@noble/curves/p256';
import { base64UrlEncode } from '@monti/shared';
import * as WebAuthnP256 from 'ox/WebAuthnP256';
import {
  bytesToHex,
  createPublicClient,
  custom,
  decodeAbiParameters,
  hexToBytes,
  sha256,
  stringToHex,
  type Hex,
} from 'viem';
import { getUserOperationHash, toCoinbaseSmartAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { monadChain } from './chain';

/**
 * The RP ID the gate build ships (`apps/web/.env.local` → `VITE_RP_ID`). `webauthn-sol` never
 * looks at `rpIdHash`, but it is pinned anyway: if the config key were dropped,
 * `sha256('undefined')` would still produce a signature the wallet accepts and nothing else
 * in the system would notice the gate stopped naming itself.
 */
vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.despell.io' }) }));

const signWithGateKey = vi.fn();
vi.mock('../../staff/gate/gateKey', () => ({ signWithGateKey }));

const RP_ID = 'monti.despell.io';
const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

/** One fixed device key. noble's ECDSA is RFC-6979 deterministic, so the vectors below pin. */
const PRIV = hexToBytes(`0x${'42'.repeat(32)}`);
const PUB = p256.getPublicKey(PRIV, false);
const X = bytesToHex(PUB.slice(1, 33));
const Y = bytesToHex(PUB.slice(33, 65));
const N = p256.CURVE.n;

const toWord = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;

/**
 * viem and noble hand back `Uint8Array<ArrayBufferLike>`, and WebCrypto's `BufferSource` will
 * not take a view that might sit on a SharedArrayBuffer — same fix as `gateKey.test.ts`.
 */
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/** Stands in for the secure element: signs the 32 bytes it is handed, raw, and records them. */
const digests: Hex[] = [];
async function sign(digest: Hex): Promise<{ r: Hex; s: Hex }> {
  digests.push(digest);
  const sig = p256.sign(hexToBytes(digest), PRIV, { prehash: false });
  return { r: toWord(sig.r), s: toWord(sig.s) };
}

/**
 * The same signature with `s` raised into the high half. `(r, n - s)` verifies for the same
 * message and key — that is what ECDSA malleability means — but `webauthn-sol` returns false
 * on `s > n/2` before it verifies anything, so a chip that hands back the high half must not
 * be able to produce an unusable UserOp signature.
 */
async function signHighS(digest: Hex): Promise<{ r: Hex; s: Hex }> {
  const { r, s } = await sign(digest);
  const value = BigInt(s);
  return { r, s: toWord(value > N / 2n ? value : N - value) };
}

const { buildWebAuthnAuth, encodeWebAuthnSignature, signUserOpWithDeviceKey } = await import('./gateSigner');

/** `CoinbaseSmartWallet.SignatureWrapper`, field for field (contracts/lib/smart-wallet/src). */
const SIGNATURE_WRAPPER = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint256' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

/** `WebAuthn.WebAuthnAuth`, field for field (lib/smart-wallet/lib/webauthn-sol/src/WebAuthn.sol). */
const WEBAUTHN_AUTH = [
  {
    type: 'tuple',
    components: [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
      { name: 'challengeIndex', type: 'uint256' },
      { name: 'typeIndex', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
    ],
  },
] as const;

/**
 * The attendee-side check, run against the gate's synthetic bytes: WebCrypto is handed the
 * pre-hash payload and applies the outer SHA-256 itself, which is exactly step 20 of
 * `WebAuthn.verify` (`sha256(authenticatorData ‖ sha256(clientDataJSON))`).
 */
async function webCryptoVerify(auth: {
  authenticatorData: Hex;
  clientDataJSON: string;
  r: bigint;
  s: bigint;
}): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', copy(PUB), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
  const authenticatorData = hexToBytes(auth.authenticatorData);
  const clientDataHash = hexToBytes(sha256(stringToHex(auth.clientDataJSON)));
  const message = new Uint8Array(authenticatorData.length + clientDataHash.length);
  message.set(authenticatorData, 0);
  message.set(clientDataHash, authenticatorData.length);
  const signature = copy(hexToBytes(`0x${toWord(auth.r).slice(2)}${toWord(auth.s).slice(2)}`));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
}

const CHALLENGE = `0x${'7e'.repeat(32)}` as const;
/** `CoinbaseSmartWallet` passes `abi.encode(userOpHash)` — the bare 32 bytes — as the challenge. */
const challengeB64 = (challenge: Hex) => base64UrlEncode(hexToBytes(challenge));

beforeEach(() => {
  digests.length = 0;
  signWithGateKey.mockReset();
});

describe('buildWebAuthnAuth', () => {
  it('points typeIndex and challengeIndex at exactly what webauthn-sol slices out', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);

    // Step 11: clientDataJSON[typeIndex .. typeIndex + 21] == '"type":"webauthn.get"'.
    expect(auth.clientDataJSON.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21)).toBe(
      '"type":"webauthn.get"',
    );

    // Step 12: the slice from challengeIndex is '"challenge":"' + Base64.encodeURL(challenge) + '"'.
    // OpenZeppelin's encodeURL emits no padding, so 32 bytes are 43 characters.
    const expected = `"challenge":"${challengeB64(CHALLENGE)}"`;
    expect(challengeB64(CHALLENGE)).toHaveLength(43);
    expect(auth.clientDataJSON.slice(Number(auth.challengeIndex), Number(auth.challengeIndex) + expected.length)).toBe(
      expected,
    );
  });

  it('synthesises 37 bytes of authenticatorData: rpIdHash, UP|UV, counter 0', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);
    const bytes = hexToBytes(auth.authenticatorData);

    expect(bytes).toHaveLength(37);
    expect(auth.authenticatorData.slice(0, 66)).toBe(sha256(stringToHex(RP_ID)));
    expect(bytes[32]).toBe(0x05);
    expect(bytes[32]! & 0x01).toBe(0x01); // UP — webauthn-sol step 16, the one flag it requires
    expect(bytes[32]! & 0x04).toBe(0x04); // UV — step 17, ignored at requireUV:false but honest
    expect([...bytes.slice(33)]).toEqual([0, 0, 0, 0]); // no sign counter is claimed
  });

  it('hands the device key sha256(authenticatorData || sha256(clientDataJSON)) and nothing else', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);
    const expected = sha256(`0x${auth.authenticatorData.slice(2)}${sha256(stringToHex(auth.clientDataJSON)).slice(2)}`);

    expect(digests).toEqual([expected]);
  });

  it('normalises a high-s signature back under n/2 before wrapping it', async () => {
    const high = await buildWebAuthnAuth(CHALLENGE, signHighS);
    const low = await buildWebAuthnAuth(CHALLENGE, sign);

    expect(high.s).toBeLessThanOrEqual(N / 2n);
    expect(high.r).toBe(low.r);
    expect(high.s).toBe(low.s);
    expect(await webCryptoVerify(high)).toBe(true);
  });

  it('verifies under ox WebAuthnP256.verify with user verification required', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);

    expect(
      WebAuthnP256.verify({
        challenge: CHALLENGE,
        metadata: {
          authenticatorData: auth.authenticatorData,
          clientDataJSON: auth.clientDataJSON,
          challengeIndex: Number(auth.challengeIndex),
          typeIndex: Number(auth.typeIndex),
          userVerificationRequired: true,
        },
        publicKey: { prefix: 4, x: BigInt(X), y: BigInt(Y) },
        signature: { r: auth.r, s: auth.s },
      }),
    ).toBe(true);
  });

  it('verifies under WebCrypto, and does not when the challenge is swapped', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);
    expect(await webCryptoVerify(auth)).toBe(true);

    // Same signature, a different challenge in the clientDataJSON: the payload moves, so this
    // must fail. Otherwise the check above would pass for any bytes at all.
    const other = await buildWebAuthnAuth(`0x${'7f'.repeat(32)}`, sign);
    expect(await webCryptoVerify({ ...auth, clientDataJSON: other.clientDataJSON })).toBe(false);
  });
});

describe('encodeWebAuthnSignature', () => {
  it('wraps the struct the way CoinbaseSmartWallet._validateSignature decodes it', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);
    const wrapped = encodeWebAuthnSignature(auth, 0n);

    const [wrapper] = decodeAbiParameters(SIGNATURE_WRAPPER, wrapped);
    expect(wrapper.ownerIndex).toBe(0n);

    const [decoded] = decodeAbiParameters(WEBAUTHN_AUTH, wrapper.signatureData);
    expect(decoded).toEqual({
      authenticatorData: auth.authenticatorData,
      clientDataJSON: auth.clientDataJSON,
      challengeIndex: auth.challengeIndex,
      typeIndex: auth.typeIndex,
      r: auth.r,
      s: auth.s,
    });
  });

  it('carries a non-zero ownerIndex through', async () => {
    const auth = await buildWebAuthnAuth(CHALLENGE, sign);
    const [wrapper] = decodeAbiParameters(SIGNATURE_WRAPPER, encodeWebAuthnSignature(auth, 3n));
    expect(wrapper.ownerIndex).toBe(3n);
  });

  /**
   * The attendee's real passkey reaches the same wallet through viem's own encoder
   * (`toCoinbaseSmartAccount` → `toWebAuthnSignature` → `wrapSignature`), which viem marks
   * `@internal` and does not export. Byte-equality is pinned instead: if viem's encoding ever
   * moves, the gate would stop matching the attendee and this test says so.
   */
  it('produces the same bytes viem produces for the attendee passkey', async () => {
    const SENDER = `0x${'ab'.repeat(20)}` as Hex;
    const client = createPublicClient({
      chain: monadChain(10143, ['https://rpc.example'], 'wss://ws.example'),
      transport: custom({
        async request({ method }) {
          throw new Error(`unexpected RPC ${method}`);
        },
      }),
    });

    const owner = {
      id: 'gate',
      publicKey: `0x${X.slice(2)}${Y.slice(2)}` as Hex,
      type: 'webAuthn',
      async sign({ hash }: { hash: Hex }) {
        const auth = await buildWebAuthnAuth(hash, sign);
        return {
          signature: `0x${toWord(auth.r).slice(2)}${toWord(auth.s).slice(2)}1b` as Hex,
          webauthn: {
            authenticatorData: auth.authenticatorData,
            clientDataJSON: auth.clientDataJSON,
            challengeIndex: Number(auth.challengeIndex),
            typeIndex: Number(auth.typeIndex),
            userVerificationRequired: true,
          },
          raw: {} as never,
        };
      },
    } as unknown as WebAuthnAccount;

    const account = await toCoinbaseSmartAccount({ address: SENDER, client, owners: [owner], version: '1.1' });
    const userOperation = {
      sender: SENDER,
      nonce: 5n,
      initCode: '0x' as Hex,
      callData: '0xdeadbeef' as Hex,
      callGasLimit: 200_000n,
      verificationGasLimit: 800_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      paymasterAndData: '0x' as Hex,
    };

    const fromViem = await account.signUserOperation(userOperation as never);
    const userOpHash = getUserOperationHash({
      chainId: 10143,
      entryPointAddress: ENTRY_POINT_V06,
      entryPointVersion: '0.6',
      userOperation: userOperation as never,
    });

    expect(fromViem).toBe(encodeWebAuthnSignature(await buildWebAuthnAuth(userOpHash, sign), 0n));
  });
});

/**
 * Ruling 3's pinned vector: fixed key, fixed userOpHash, fixed bytes. Cross-checked against
 * WebCrypto (above) and against the real `webauthn-sol` `WebAuthn.verify` under forge — see
 * the task-12 report. A change to any number here is a change to what the gate's smart account
 * will accept, and must never happen by accident.
 */
describe('pinned vector', () => {
  const USER_OP_HASH = `0x${'7e'.repeat(32)}` as const;

  it('pins the whole wrapped signature for the fixed key and userOpHash', async () => {
    const auth = await buildWebAuthnAuth(USER_OP_HASH, sign);

    expect(X).toBe('0x3ad3861a95621392516bb593ef05583ed2e5866f5cb6260a3017237fd89b90af');
    expect(Y).toBe('0xd0961c7e37075a6791a39c61f56295b02b6d26567b615e60aa41ee1c8e83388d');
    expect(auth.clientDataJSON).toBe(
      '{"type":"webauthn.get","challenge":"fn5-fn5-fn5-fn5-fn5-fn5-fn5-fn5-fn5-fn5-fn4",' +
        '"origin":"https://monti.despell.io","crossOrigin":false}',
    );
    expect(auth.typeIndex).toBe(1n);
    expect(auth.challengeIndex).toBe(23n);
    expect(auth.authenticatorData).toBe('0x1edb9855237a83658e6579fd04f4484f31951f96d16cd71303ec6df2dfa7ec360500000000');
    expect(digests[0]).toBe('0xe51d9b1662da783a128f8ee11fcaf1f5ccc08c4b34031a69359e7eea64eb82a9');
    expect(toWord(auth.r)).toBe('0x73435c38e15fd6c41856806130966fbb68f05f8d3b5805532d80ec68f2d44955');
    expect(toWord(auth.s)).toBe('0x46ec64ae10bb7ade2fdc98d72500f5ded4600a4d7804f3663d67f7908fcc6769');
    expect(encodeWebAuthnSignature(auth, 0n)).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000040' +
        '0000000000000000000000000000000000000000000000000000000000000200' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '00000000000000000000000000000000000000000000000000000000000000c0' +
        '0000000000000000000000000000000000000000000000000000000000000120' +
        '0000000000000000000000000000000000000000000000000000000000000017' +
        '0000000000000000000000000000000000000000000000000000000000000001' +
        '73435c38e15fd6c41856806130966fbb68f05f8d3b5805532d80ec68f2d44955' +
        '46ec64ae10bb7ade2fdc98d72500f5ded4600a4d7804f3663d67f7908fcc6769' +
        '0000000000000000000000000000000000000000000000000000000000000025' +
        '1edb9855237a83658e6579fd04f4484f31951f96d16cd71303ec6df2dfa7ec36' +
        '0500000000000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000089' +
        '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e67' +
        '65223a22666e352d666e352d666e352d666e352d666e352d666e352d666e352d' +
        '666e352d666e352d666e352d666e34222c226f726967696e223a226874747073' +
        '3a2f2f6d6f6e74692e64657370656c6c2e696f222c2263726f73734f72696769' +
        '6e223a66616c73657d0000000000000000000000000000000000000000000000',
    );
    expect(await webCryptoVerify(auth)).toBe(true);
  });
});

describe('signUserOpWithDeviceKey', () => {
  it('signs the userOpHash with the gate key and wraps it at ownerIndex 0', async () => {
    signWithGateKey.mockImplementation(sign);

    const wrapped = await signUserOpWithDeviceKey(CHALLENGE);

    expect(signWithGateKey).toHaveBeenCalledTimes(1);
    expect(signWithGateKey.mock.calls[0]?.[0]).toBe(digests[0]);

    const [wrapper] = decodeAbiParameters(SIGNATURE_WRAPPER, wrapped);
    expect(wrapper.ownerIndex).toBe(0n);
    const [decoded] = decodeAbiParameters(WEBAUTHN_AUTH, wrapper.signatureData);
    // The challenge the wallet checks is the userOpHash itself: CoinbaseSmartWallet hands
    // `abi.encode(userOpHash)` to WebAuthn.verify. replaySafeHash is the ERC-1271 path only.
    expect(decoded.clientDataJSON).toContain(`"challenge":"${challengeB64(CHALLENGE)}"`);
  });
});
