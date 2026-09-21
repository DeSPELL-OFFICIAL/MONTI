import { randomBytes } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import { AUTH_CHALLENGE_TTL_SECONDS, type Hex } from '@monti/shared';
import { RP_ID, expectedOrigins } from '../config.js';
import { AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS, authAdmin, db } from '../lib/db.js';
import { decryptField, piiAad } from '../lib/kms.js';
import { CHALLENGE_RE, challengeFromClientData } from '../lib/webauthn.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * credential id 는 그대로 `passkeys/{id}` 문서 id 가 된다. 클라이언트가 보내는 값이므로
 * `/` 나 `..` 가 섞이면 문서 경로가 깨져 매핑되지 않은 500 이 된다. 경로로 쓰기 **전에** 막는다.
 */
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * 어설션은 전적으로 클라이언트가 만든 값이다. 모양이 깨진 입력을 라이브러리까지 흘려보내면
 * 클라이언트가 INTERNAL 만 보게 되므로 여기서 `invalid-argument` 로 끝낸다(Task 18 과 같은 방식).
 */
function requireAssertion(value: unknown): AuthenticationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'BAD_ASSERTION');
  }
  const candidate = value as Partial<AuthenticationResponseJSON>;
  const response = candidate.response;
  if (
    typeof candidate.id !== 'string' ||
    !CREDENTIAL_ID_RE.test(candidate.id) ||
    candidate.type !== 'public-key' ||
    !response ||
    typeof response.clientDataJSON !== 'string' ||
    typeof response.authenticatorData !== 'string' ||
    typeof response.signature !== 'string'
  ) {
    throw new HttpsError('invalid-argument', 'BAD_ASSERTION');
  }
  return candidate as AuthenticationResponseJSON;
}

/**
 * 로그인 전에 부르는 유일한 함수라 인증을 요구하지 않는다. 한 번 부를 때 문서 하나만 쓴다.
 * 등록(`registerPasskey`)도 챌린지를 여기서 받아 가므로 `purpose: 'register'` 를 지정할 수 있다.
 * 두 용도를 문서에 못 박아 두면 등록용 챌린지로 로그인하거나 그 반대를 하는 교차 프로토콜 재사용이 막힌다.
 */
export const loginChallenge = onCall(async (request): Promise<{ challenge: string; expiresAt: number }> => {
  const purpose = ((request.data ?? {}) as { purpose?: unknown }).purpose === 'register' ? 'register' : 'login';
  // 32바이트 → base64url 43자. 문서 id 로 바로 쓸 수 있는 문자만 나온다.
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CHALLENGE_TTL_SECONDS;
  await db.collection(AUTH_CHALLENGES).doc(challenge).set({
    purpose,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { challenge, expiresAt };
});

/**
 * 패스키 어설션 하나로 세션을 만든다. 로그인은 **패스키 전용**이다 — 이메일도 비밀번호도 없다(스펙 §5.1).
 * 세션의 신원은 사람의 스마트 계정 주소이고, 그 주소는 커스텀 토큰 클레임으로 실려 규칙 파일이 읽는다.
 *
 * 개인정보·보안: 어설션 원본은 어디에도 저장하지 않는다. 챌린지는 트랜잭션으로 단 한 번만 소비되고,
 * 라이브러리가 던지는 예외는 전부 4xx 로 바꿔서 돌려준다(클라이언트가 INTERNAL 을 보지 않는다).
 */
export const loginVerify = onCall(
  async (request): Promise<{ token: string; personId: Hex; account: Hex }> => {
    const { assertion } = (request.data ?? {}) as { assertion?: unknown };
    const authentication = requireAssertion(assertion);

    // clientDataJSON 은 클라이언트가 만든 바이트다. base64·JSON·필드가 깨진 입력은 여기서 끝낸다.
    let challenge: unknown;
    try {
      challenge = challengeFromClientData(authentication.response.clientDataJSON);
    } catch {
      throw new HttpsError('invalid-argument', 'BAD_ASSERTION');
    }
    // 숫자·배열 challenge 는 `RegExp.test` 가 문자열로 강제 변환해 통과시킨 뒤 문서 id 에서 터진다.
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
      throw new HttpsError('invalid-argument', 'BAD_CHALLENGE');
    }

    // 챌린지를 한 번만 쓰도록 트랜잭션으로 소비한다. 검증이 실패해도 이미 태워진 상태다.
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) throw new HttpsError('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) throw new HttpsError('failed-precondition', 'CHALLENGE_USED');
      // 등록용 챌린지를 로그인에 돌려쓰지 못하게 한다(교차 프로토콜 재사용).
      if (doc.get('purpose') !== 'login') throw new HttpsError('permission-denied', 'BAD_CHALLENGE');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        throw new HttpsError('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    const credentialRef = db.collection(PASSKEYS).doc(authentication.id);
    const credential = await credentialRef.get();
    if (!credential.exists) throw new HttpsError('not-found', 'CREDENTIAL_NOT_FOUND');
    const storedCounter = (credential.get('counter') as number) ?? 0;

    /**
     * 카운터 판정은 **우리가** 한다. 라이브러리에 저장된 카운터를 넘기면 새 카운터가 0 일 때도 무조건 던지는데,
     * 애플 패스키는 언제나 0 을 보고한다(마스터 계획 Global Constraints). 그래서 0 을 주고 검사는 아래에서 한다.
     * 라이브러리는 실패를 예외로 던진다. 그대로 올리면 클라이언트가 INTERNAL 만 보므로 4xx 로 바꿔 준다.
     */
    const verification = await verifyAuthenticationResponse({
      response: authentication,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID.value(),
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: authentication.id,
        publicKey: Buffer.from(credential.get('publicKeyCose') as string, 'base64'),
        counter: 0,
        transports: credential.get('transports') as AuthenticatorTransportFuture[] | undefined,
      },
    }).catch(() => ({ verified: false }) as const);
    if (!verification.verified) throw new HttpsError('permission-denied', 'ASSERTION_REJECTED');

    const newCounter = verification.authenticationInfo.newCounter;
    // 인증기가 카운터를 쓰지 않으면 항상 0이다. 0이 아닌데 늘지 않았으면 복제 신호다.
    if (newCounter !== 0 && newCounter <= storedCounter) {
      throw new HttpsError('permission-denied', 'COUNTER_REPLAY');
    }

    const personId = credential.get('personId') as Hex;
    const person = await db.collection(PERSONS).doc(personId).get();
    // `rotated` 는 종착 상태다 — 계정이 이미 새 계정으로 넘어갔으므로 옛 패스키로 세션을 만들면 안 된다.
    if (person.get('status') === 'rotated') throw new HttpsError('failed-precondition', 'BAD_SIGNUP_STATE');
    const stored = person.get('account') as string | undefined;
    if (!stored || !ADDRESS_RE.test(stored)) throw new HttpsError('failed-precondition', 'NO_ACCOUNT');
    const account = getAddress(stored) as Hex;

    // uid 는 전화번호 가입 때 만들어진 그대로 쓴다. 로그인은 새 uid 를 만들지 않는다.
    const users = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
    const userDoc = users.docs[0];
    if (!userDoc) throw new HttpsError('not-found', 'USER_NOT_FOUND');
    const uid = userDoc.id;

    /**
     * `phone_number` 까지 실어야 startDeviceChange / pendingOffers / getSignupStatus 가 패스키 세션에서도 돈다.
     * 번호 평문은 `users/{uid}.phoneEnc`(KMS 봉투)에만 있으므로 여기서 풀어서 클레임에 싣는다 —
     * 전화 로그인 세션이 주는 `phone_number` 클레임과 같은 값이라야 아래 함수들이 두 세션을 구분하지 않는다.
     */
    const phoneEnc = userDoc.get('phoneEnc') as string | undefined;
    const phoneNumber = phoneEnc ? await decryptField(phoneEnc, piiAad(personId, 'phoneE164')) : '';

    await credentialRef.update({ counter: newCounter, lastUsedAt: FieldValue.serverTimestamp() });
    const token = await authAdmin.createCustomToken(uid, { personId, account, phone_number: phoneNumber });
    return { token, personId, account };
  },
);
