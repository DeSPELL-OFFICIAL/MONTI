import { KeyManagementServiceClient } from '@google-cloud/kms';
import { recoverAddress } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { derToRs, splitRs, joinRs, type Hex } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { attesterKeyName } from './kms.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;

export interface KmsSignClient {
  asymmetricSign(req: {
    name: string;
    digest: { sha256: Buffer };
  }): Promise<[{ signature: Uint8Array | string | null }]>;
}

let cached: { key: string; account: PrivateKeyAccount } | undefined;

/**
 * MVP 경로. Secret Manager `ATTESTER_PK` 하나만 읽는다.
 * 시크릿은 **호출 시점에만** 읽는다 — 모듈 로드 시점에 읽으면 배포(analyze) 단계에서 터진다.
 */
export function getAttesterAccount(privateKey?: string): PrivateKeyAccount {
  const pk = privateKey ?? ATTESTER_PK.value();
  if (!PRIVATE_KEY_RE.test(pk)) throw new Error('MISSING_ATTESTER_PK');
  if (cached?.key !== pk) cached = { key: pk, account: privateKeyToAccount(pk as Hex) };
  return cached.account;
}

/** secp256k1 은 (r, s)와 (r, n-s)가 둘 다 유효하다. 이더리움은 낮은 쪽만 받는다. */
function toLowS(s: Hex): Hex {
  const value = BigInt(s);
  if (value <= SECP256K1_HALF_N) return s;
  const flipped = SECP256K1_N - value;
  return `0x${flipped.toString(16).padStart(64, '0')}` as Hex;
}

/** DER ECDSA 서명 → 이더리움 65바이트 서명. v는 실제로 복구되는 쪽을 고른다. */
export async function derSigToEthSignature(der: Hex, digest: Hex, expectedAddress: Hex): Promise<Hex> {
  const { r, s } = splitRs(derToRs(der));
  const base = joinRs(r, toLowS(s));
  for (const v of [27, 28]) {
    const candidate = `${base}${v.toString(16)}` as Hex;
    const recovered = await recoverAddress({ hash: digest, signature: candidate });
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) return candidate;
  }
  throw new Error('ATTESTER_RECOVERY_FAILED');
}

let cachedKms: KeyManagementServiceClient | undefined;

function defaultSignClient(): KmsSignClient {
  if (!cachedKms) cachedKms = new KeyManagementServiceClient();
  return cachedKms as unknown as KmsSignClient;
}

/**
 * 프로덕션 경로. KMS `EC_SIGN_SECP256K1_SHA256` 은 다이제스트를 검사하지 않으므로
 * keccak256 다이제스트를 sha256 필드에 그대로 넣으면 이더리움 호환 서명이 나온다.
 * 전환은 `Identity.setAttester(kmsAddress)` 한 번이면 끝난다.
 */
export async function signKeccak(
  digest: Hex,
  expectedAddress: Hex,
  client: KmsSignClient = defaultSignClient(),
): Promise<Hex> {
  if (!DIGEST_RE.test(digest)) throw new Error('BAD_DIGEST');
  const [response] = await client.asymmetricSign({
    name: attesterKeyName(),
    digest: { sha256: Buffer.from(digest.slice(2), 'hex') },
  });
  const raw = response.signature;
  if (raw === null || raw === undefined || raw.length === 0) throw new Error('KMS_EMPTY_SIGNATURE');
  const der = (typeof raw === 'string'
    ? `0x${Buffer.from(raw, 'base64').toString('hex')}`
    : `0x${Buffer.from(raw).toString('hex')}`) as Hex;
  return derSigToEthSignature(der, digest, expectedAddress);
}
