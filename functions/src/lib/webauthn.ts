import { Encoder } from 'cbor-x';
import type { Hex } from '@monti/shared';

const decoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });

/**
 * 챌린지는 그대로 Firestore 문서 id 가 된다. base64url 밖의 문자(`/`, `.`, 빈 문자열)는
 * 문서 경로 자체를 깨뜨려 매핑되지 않은 500 이 되므로 id 로 쓰기 **전에** 막는다.
 * `loginChallenge` 가 내주는 값은 32바이트 base64url(43자)다.
 * 등록(Task 18)과 로그인(Task 20)이 같은 판정을 쓰도록 여기 한 곳에만 둔다.
 */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function toHex32(value: unknown, label: string): Hex {
  const bytes = value instanceof Uint8Array ? value : undefined;
  if (!bytes || bytes.length !== 32) throw new Error(label);
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

/** COSE_Key: 1=kty(2 EC2), 3=alg(-7 ES256), -1=crv(1 P-256), -2=x, -3=y */
export function coseToP256(cose: Uint8Array): { x: Hex; y: Hex } {
  const map = decoder.decode(cose) as Map<number, unknown>;
  if (!(map instanceof Map)) throw new Error('COSE_NOT_A_MAP');
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) throw new Error('COSE_NOT_P256');
  return { x: toHex32(map.get(-2), 'COSE_BAD_COORDINATE'), y: toHex32(map.get(-3), 'COSE_BAD_COORDINATE') };
}

/** Coinbase Smart Wallet 은 패스키 소유자를 x||y 64바이트로 받는다(비압축 점에서 0x04 접두를 뺀 형태). */
export function ownerBytes(x: Hex, y: Hex): Hex {
  return `0x${x.slice(2)}${y.slice(2)}` as Hex;
}

export function challengeFromClientData(clientDataJSONBase64Url: string): string {
  const json = Buffer.from(clientDataJSONBase64Url, 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as { challenge?: string };
  if (!parsed.challenge) throw new Error('NO_CHALLENGE');
  return parsed.challenge;
}
