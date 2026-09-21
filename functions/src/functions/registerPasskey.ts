import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getAddress, parseAbi } from 'viem';
import type { Hex } from '@monti/shared';
import { RP_ID, expectedOrigins } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import { AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS, db } from '../lib/db.js';
import { challengeFromClientData, coseToP256, ownerBytes } from '../lib/webauthn.js';

/**
 * Task 3 이 `@monti/shared` 에 팩토리 ABI 를 넣기 전까지 이 한 조각이 유일한 ABI 텍스트다.
 * `CoinbaseSmartWalletFactory.getAddress(bytes[] owners, uint256 nonce)` 시그니처를 그대로 옮겼다.
 */
const coinbaseFactoryAbi = parseAbi([
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);

/** 사람마다 계정은 하나뿐이라 팩토리 nonce 는 항상 0이다. 기기 추가는 소유자 추가지 새 계정이 아니다. */
const ACCOUNT_NONCE = 0n;

/** ES256(P-256) 외의 알고리즘은 받지 않는다. 스마트 계정 검증기가 P-256 밖에 못 쓴다. */
const SUPPORTED_ALGORITHMS = [-7];

/** 어테스테이션 CA 는 신뢰하지 않는다. 자기 서명(`packed`)과 무증명(`none`)만 받는다. */
const ALLOWED_FORMATS = new Set(['none', 'packed']);

/**
 * 웹 클라이언트는 지원하지 않는 엔진에서 `{}` 를 그대로 올려 보낸다.
 * 그런 입력을 조용히 넘기면 뒤에서 "검증 실패"로 뭉개지므로 여기서 크게 튕긴다.
 */
function requireAttestation(value: unknown): RegistrationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'BAD_ATTESTATION');
  }
  const candidate = value as Partial<RegistrationResponseJSON>;
  const response = candidate.response;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    candidate.type !== 'public-key' ||
    !response ||
    typeof response.clientDataJSON !== 'string' ||
    typeof response.attestationObject !== 'string'
  ) {
    throw new HttpsError('invalid-argument', 'BAD_ATTESTATION');
  }
  return candidate as RegistrationResponseJSON;
}

/**
 * 전화번호 가입이 끝난 사람에게 패스키 하나를 붙이고, 그 패스키가 소유자인
 * Coinbase Smart Wallet 주소를 팩토리에서 미리 계산해 사람 문서에 적는다.
 * 계정은 아직 배포되지 않는다 — 주소만 반사실적으로 확정된다(스펙 §4).
 *
 * 개인정보·보안: 어테스테이션 원본은 어디에도 저장하지 않는다. COSE 공개키·credential id·
 * transports·counter 만 남긴다. 챌린지는 Firestore 트랜잭션으로 단 한 번만 소비된다.
 */
export const registerPasskey = onCall(
  async (request): Promise<{ ok: true; account: Hex; credentialId: string }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { personId, attestation } = (request.data ?? {}) as { personId?: Hex; attestation?: unknown };
    if (!personId || !/^0x[0-9a-fA-F]{64}$/.test(personId)) {
      throw new HttpsError('invalid-argument', 'BAD_PERSON_ID');
    }
    const registration = requireAttestation(attestation);

    // 남의 personId 에 자기 패스키를 붙이지 못하게 호출자와 사람을 묶는다.
    const user = await db.collection(USERS).doc(uid).get();
    if (user.get('personId') !== personId) throw new HttpsError('permission-denied', 'PERSON_MISMATCH');

    const personRef = db.collection(PERSONS).doc(personId);
    const person = await personRef.get();
    if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
    // 가입에 본인인증이 없으므로 pending 이 정상 상태다. KYC 레벨은 여기서 보지 않는다.
    if (person.get('status') !== 'pending') throw new HttpsError('failed-precondition', 'BAD_SIGNUP_STATE');

    // 챌린지를 한 번만 쓰도록 트랜잭션으로 소비한다.
    const challenge = challengeFromClientData(registration.response.clientDataJSON);
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) throw new HttpsError('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) throw new HttpsError('failed-precondition', 'CHALLENGE_USED');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        throw new HttpsError('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    // 라이브러리는 실패를 예외로 던진다. 그대로 올리면 클라이언트가 INTERNAL 만 보므로 여기서 바꿔 준다.
    const verification = await verifyRegistrationResponse({
      response: registration,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID.value(),
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    }).catch(() => ({ verified: false }) as const);
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpsError('permission-denied', 'ATTESTATION_REJECTED');
    }
    if (!ALLOWED_FORMATS.has(verification.registrationInfo.fmt)) {
      throw new HttpsError('permission-denied', 'ATTESTATION_REJECTED');
    }

    const credential = verification.registrationInfo.credential;
    const { x, y } = coseToP256(credential.publicKey);
    const contracts = deployment();
    const predicted = await publicClient().readContract({
      address: contracts.coinbaseFactory,
      abi: coinbaseFactoryAbi,
      functionName: 'getAddress',
      args: [[ownerBytes(x, y)], ACCOUNT_NONCE],
    });
    const account = getAddress(predicted as string);

    // 패스키와 계정 주소는 같이 태어난다. 둘 중 하나만 남는 상태는 없다.
    await db.runTransaction(async (tx) => {
      const passkeyRef = db.collection(PASSKEYS).doc(credential.id);
      const existing = await tx.get(passkeyRef);
      const current = await tx.get(personRef);
      if (existing.exists) throw new HttpsError('already-exists', 'CREDENTIAL_EXISTS');
      // 사람당 패스키는 하나다. 기기 추가·복구는 별도 함수가 다룬다.
      if (current.get('account')) throw new HttpsError('already-exists', 'PASSKEY_ALREADY_REGISTERED');

      tx.set(passkeyRef, {
        personId,
        publicKeyCose: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: registration.response.transports ?? [],
        rpId: RP_ID.value(),
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(personRef, { account, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    return { ok: true, account, credentialId: credential.id };
  },
);
