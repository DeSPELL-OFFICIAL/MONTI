import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, recoverAddress } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { derSigToEthSignature, getAttesterAccount, signKeccak, type KmsSignClient } from '../src/lib/attester.js';
import { rsToDer, joinRs, splitRs } from '@monti/shared';
import type { Hex } from '@monti/shared';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const account = privateKeyToAccount(PK);

/** Foundry/anvil 0번 계정. 테스트가 개인키를 직접 넘길 때만 쓰는 공개된 값이다. */
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

async function derFor(digest: Hex, privateKey: Hex = PK): Promise<Hex> {
  const viemSig = await sign({ hash: digest, privateKey, to: 'hex' });
  return rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));
}

describe('derSigToEthSignature', () => {
  it('reproduces the signature viem produces for the same digest', async () => {
    const digest = keccak256(stringToBytes('monti attester test'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));

    const converted = await derSigToEthSignature(der, digest, account.address as Hex);
    expect(await recoverAddress({ hash: digest, signature: converted })).toBe(account.address);
  });

  it('produces a 65-byte signature whose v is 27 or 28', async () => {
    const digest = keccak256(stringToBytes('another digest'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));
    const converted = await derSigToEthSignature(der, digest, account.address as Hex);

    expect(converted).toHaveLength(2 + 130);
    expect([27, 28]).toContain(Number.parseInt(converted.slice(130), 16));
  });

  it('throws when the signature does not recover to the expected address', async () => {
    const digest = keccak256(stringToBytes('yet another digest'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));

    await expect(
      derSigToEthSignature(der, digest, '0x000000000000000000000000000000000000dEaD' as Hex),
    ).rejects.toThrow('ATTESTER_RECOVERY_FAILED');
  });

  // KMS 는 low-s 정규화를 해 주지 않는다. 높은 s 가 그대로 나가면 컨트랙트의 ecrecover 가 거부한다.
  it('normalises a high-s DER signature back to low-s and still recovers', async () => {
    const digest = keccak256(stringToBytes('high s digest'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const lowS = `0x${viemSig.slice(66, 130)}` as Hex;
    const highS = `0x${(SECP256K1_N - BigInt(lowS)).toString(16).padStart(64, '0')}` as Hex;
    const highSDer = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, highS));

    const converted = await derSigToEthSignature(highSDer, digest, account.address as Hex);

    expect(splitRs(converted.slice(0, 130) as Hex).s).toBe(lowS);
    expect(BigInt(splitRs(converted.slice(0, 130) as Hex).s) <= SECP256K1_N / 2n).toBe(true);
    expect(await recoverAddress({ hash: digest, signature: converted })).toBe(account.address);
  });
});

describe('getAttesterAccount', () => {
  it('derives the address of an explicitly supplied private key', () => {
    expect(getAttesterAccount(ANVIL_PK).address).toBe(ANVIL_ADDRESS);
  });

  it('reads ATTESTER_PK at call time, not at import time', () => {
    process.env.ATTESTER_PK = PK;
    expect(getAttesterAccount().address).toBe(account.address);
    delete process.env.ATTESTER_PK;
  });

  it('throws MISSING_ATTESTER_PK when the secret is absent or malformed', () => {
    delete process.env.ATTESTER_PK;
    expect(() => getAttesterAccount()).toThrow('MISSING_ATTESTER_PK');
    expect(() => getAttesterAccount('0xnope')).toThrow('MISSING_ATTESTER_PK');
  });
});

/** 실제 KMS 왕복 없이 DER 을 돌려주는 가짜 서명자. digest 를 그대로 서명한다. */
function fakeKms(privateKey: Hex = PK, override?: null): KmsSignClient & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    async asymmetricSign({ name, digest }) {
      names.push(name);
      if (override === null) return [{ signature: null }];
      const der = await derFor(`0x${digest.sha256.toString('hex')}` as Hex, privateKey);
      return [{ signature: Buffer.from(der.slice(2), 'hex') }];
    },
  };
}

let savedProject: string | undefined;
beforeAll(() => {
  savedProject = process.env.GCP_PROJECT_ID;
  process.env.GCP_PROJECT_ID = 'monti-dev';
});
afterAll(() => {
  if (savedProject === undefined) delete process.env.GCP_PROJECT_ID;
  else process.env.GCP_PROJECT_ID = savedProject;
});

describe('signKeccak', () => {
  it('signs a keccak digest through KMS and returns an ethereum signature', async () => {
    const client = fakeKms();
    const digest = keccak256(stringToBytes('kms path'));

    const signature = await signKeccak(digest, account.address as Hex, client);

    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
    expect(client.names[0]).toContain('/cryptoKeys/attester/cryptoKeyVersions/1');
  });

  it('accepts a base64 signature payload from the KMS client', async () => {
    const digest = keccak256(stringToBytes('base64 payload'));
    const client: KmsSignClient = {
      async asymmetricSign({ digest: d }) {
        const der = await derFor(`0x${d.sha256.toString('hex')}` as Hex);
        return [{ signature: Buffer.from(der.slice(2), 'hex').toString('base64') }];
      },
    };

    const signature = await signKeccak(digest, account.address as Hex, client);
    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
  });

  it('rejects a digest that is not 32 bytes', async () => {
    await expect(signKeccak('0xdeadbeef' as Hex, account.address as Hex, fakeKms())).rejects.toThrow('BAD_DIGEST');
  });

  it('throws when KMS returns no signature', async () => {
    const digest = keccak256(stringToBytes('empty kms'));
    await expect(signKeccak(digest, account.address as Hex, fakeKms(PK, null))).rejects.toThrow(
      'KMS_EMPTY_SIGNATURE',
    );
  });
});
