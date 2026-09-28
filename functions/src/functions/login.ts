import { randomBytes } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { warn } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import { AUTH_CHALLENGE_TTL_SECONDS, type Hex } from '@monti/shared';
import { RP_ID, expectedOrigins } from '../config.js';
import { AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS, authAdmin, db } from '../lib/db.js';
import { CHALLENGE_RE, challengeFromClientData } from '../lib/webauthn.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * credential id 는 그대로 `passkeys/{id}` 문서 id 가 된다. 클라이언트가 보내는 값이므로
 * `/` 나 `..` 가 섞이면 문서 경로가 깨져 매핑되지 않은 500 이 된다. 경로로 쓰기 **전에** 막는다.
 */
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * 거절을 **로그에 남기고** 던진다(`createOrganizer` 의 `reject` 와 같은 규칙).
 *
 * 로그인 실패는 여러 원인이 같은 HTTP 코드(400/403/404)로 내려가므로, 코드 하나만 보고는
 * 어디서 막혔는지 알 수 없다. gRPC 코드와 짧은 기계용 사유를 한 줄로 남겨 두면 그 한 줄로
 * 경로를 짚는다. 남기는 것은 코드와 사유뿐이다 — 전화번호는 물론, credential id 도 로그에
 * 통째로 넣지 않는다(NO-PII). 사유 문자열은 그대로 클라이언트로도 나가는 값이라 이미 개인정보가 없다.
 */
function reject(code: FunctionsErrorCode, reason: string): never {
  warn('login.verify.rejected', { code, reason });
  throw new HttpsError(code, reason);
}

/**
 * 어설션은 전적으로 클라이언트가 만든 값이다. 모양이 깨진 입력을 라이브러리까지 흘려보내면
 * 클라이언트가 INTERNAL 만 보게 되므로 여기서 `invalid-argument` 로 끝낸다(Task 18 과 같은 방식).
 */
function requireAssertion(value: unknown): AuthenticationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('invalid-argument', 'BAD_ASSERTION');
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
    reject('invalid-argument', 'BAD_ASSERTION');
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
      reject('invalid-argument', 'BAD_ASSERTION');
    }
    // 숫자·배열 challenge 는 `RegExp.test` 가 문자열로 강제 변환해 통과시킨 뒤 문서 id 에서 터진다.
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
      reject('invalid-argument', 'BAD_CHALLENGE');
    }

    // 챌린지를 한 번만 쓰도록 트랜잭션으로 소비한다. 검증이 실패해도 이미 태워진 상태다.
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) reject('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) reject('failed-precondition', 'CHALLENGE_USED');
      // 등록용 챌린지를 로그인에 돌려쓰지 못하게 한다(교차 프로토콜 재사용).
      if (doc.get('purpose') !== 'login') reject('permission-denied', 'BAD_CHALLENGE');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        reject('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    const credentialRef = db.collection(PASSKEYS).doc(authentication.id);
    const credential = await credentialRef.get();
    if (!credential.exists) reject('not-found', 'CREDENTIAL_NOT_FOUND');
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
    if (!verification.verified) reject('permission-denied', 'ASSERTION_REJECTED');

    const newCounter = verification.authenticationInfo.newCounter;
    // 인증기가 카운터를 쓰지 않으면 항상 0이다. 0이 아닌데 늘지 않았으면 복제 신호다.
    if (newCounter !== 0 && newCounter <= storedCounter) {
      reject('permission-denied', 'COUNTER_REPLAY');
    }

    const personId = credential.get('personId') as Hex;
    const person = await db.collection(PERSONS).doc(personId).get();
    /**
     * `rotated` 는 종착 상태고(계정이 이미 새 계정으로 넘어갔다), `rejected` 는 거절된 사람이다.
     * 둘 다 옛 패스키로 세션을 만들어 주면 안 된다.
     */
    const status = person.get('status') as string | undefined;
    if (status === 'rotated' || status === 'rejected') {
      reject('failed-precondition', 'BAD_SIGNUP_STATE');
    }
    const stored = person.get('account') as string | undefined;
    if (!stored || !ADDRESS_RE.test(stored)) reject('failed-precondition', 'NO_ACCOUNT');
    const account = getAddress(stored) as Hex;

    // uid 는 전화번호 가입 때 만들어진 그대로 쓴다. 로그인은 새 uid 를 만들지 않는다.
    const users = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
    const userDoc = users.docs[0];
    if (!userDoc) reject('not-found', 'USER_NOT_FOUND');
    const uid = userDoc.id;

    /**
     * 카운터는 한 번 올라가면 내려오지 않는다. 0 을 보고하는 인증기(애플 패스키) 하나가
     * 물려 있다고 해서 눈금을 0 으로 되돌리면 그 뒤로 1..N 이 전부 다시 통과한다.
     */
    await credentialRef.update({
      counter: Math.max(storedCounter, newCounter),
      lastUsedAt: FieldValue.serverTimestamp(),
    });
    /**
     * 클레임은 `personId` 와 `account` 뿐이다. 커스텀 토큰은 클라이언트가 읽을 수 있으므로 개인정보를 싣지 않는다 —
     * 번호가 필요한 함수는 호출자를 `personId`·`account` 로 찾고 `users/{uid}.phoneHmac` 색인을 읽는다.
     */
    const token = await authAdmin.createCustomToken(uid, { personId, account });
    return { token, personId, account };
  },
);
