import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { warn } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import { ROTATION_COOLDOWN_SECONDS, coinbaseFactoryAbi, identityAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK, PHONE_INDEX_KEY, RP_ID, expectedOrigins } from '../config.js';
import { sendSerialized } from '../lib/attesterLock.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { mintSessionClaims } from '../lib/claims.js';
import {
  AUTH_CHALLENGES,
  DEVICES,
  PASSKEYS,
  PERSONS,
  RECOVERY_QUOTA,
  USERS,
  authAdmin,
  db,
} from '../lib/db.js';
import { predeployAccount } from '../lib/predeployAccount.js';
import { hmacPhone } from '../lib/phoneIndex.js';
import { CHALLENGE_RE, challengeFromClientData, coseToP256, ownerBytes } from '../lib/webauthn.js';

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = `0x${'00'.repeat(32)}`;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
/** 사람마다 계정은 하나뿐이라 팩토리 nonce 는 항상 0이다(registerPasskey 와 같은 값). */
const ACCOUNT_NONCE = 0n;
/** ES256(P-256) 외의 알고리즘은 받지 않는다. 스마트 계정 검증기가 P-256 밖에 못 쓴다. */
const SUPPORTED_ALGORITHMS = [-7];
/** 어테스테이션 CA 는 신뢰하지 않는다. 자기 서명(`packed`)과 무증명(`none`)만 받는다. */
const ALLOWED_FORMATS = new Set(['none', 'packed']);
const RECEIPT_TIMEOUT_MS = 30_000;
/** 한 사람이 하루에 시도할 수 있는 복구 횟수. 실패도 세어 어테스터 부하를 막는다. */
const RECOVERY_LIMIT_PER_DAY = 3;

/**
 * 호출 결과. 평소에는 `{ token, personId, account, txHash }` 다.
 * `alreadyRotated: true` 는 **성공**이고 — 체인이 이미 새 계정을 가리키고 있어서 이번에 보낼
 * 것이 없었다는 뜻이다. 그때 `txHash` 는 없다(우리가 보낸 적이 없으므로). 웹 래퍼는 이 값을
 * 오류가 아니라 "복구 완료"로 다뤄야 한다.
 */
export type RecoverAccessResult = {
  token: string;
  personId: Hex;
  account: Hex;
  txHash?: Hex;
  alreadyRotated?: true;
};

/**
 * 거절을 **로그에 남기고** 던진다(`login.ts` 의 `reject` 와 같은 규칙).
 *
 * 복구 실패는 여러 원인이 같은 HTTP 코드로 내려가므로 코드 하나만 보고는 어디서 막혔는지 알 수
 * 없다. gRPC 코드와 짧은 기계용 사유를 한 줄로 남긴다 — 전화번호는 물론 어떤 개인정보도 넣지
 * 않는다(NO-PII). `details` 는 클라이언트로도 나가는 값이라 개인정보 없는 숫자만 싣는다.
 */
function reject(code: FunctionsErrorCode, reason: string, details?: unknown): never {
  warn('recovery.rejected', { code, reason });
  throw new HttpsError(code, reason, details);
}

/**
 * 어테스테이션 모양 검증. `registerPasskey.ts` 의 `requireAttestation` 을 그대로 옮긴 것이다
 * (그 파일은 건드리지 않는다). 지원하지 않는 엔진이 올려 보내는 `{}` 같은 입력을 조용히
 * 넘기면 뒤에서 "검증 실패"로 뭉개지므로 여기서 크게 튕긴다.
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
 * 패스키를 잃어버린 사람의 복구 경로(스펙 §5.5). 새 기기에서 SMS(Firebase 전화번호) 재인증을
 * 거쳐 **새 패스키 + 새 기기 키**를 만들고, 서버가 어테스터로 온체인 계정을 새 패스키의 계정으로
 * 회전(`Identity.rotateAccount`)한다.
 *
 * 회전 자체가 옛 기기를 잠그고(Identity.sol I2), 24시간 되돌리기 창(`cancelRotation`)과 티켓
 * 이관은 체인이 따로 다룬다 — 서버는 그 둘을 부르지 않는다. 기기 교체(`setActiveDevice`)도
 * 관객 웹이 자기 스마트 계정으로 보내므로, 서버는 새 기기 키를 대기 사본으로만 적어 둔다.
 *
 * 개인정보·보안: 평문 번호는 **토큰에서만** 읽고 HMAC 비교 한 번 뒤 버린다(요청 본문에 싣지
 * 않는다). 어테스테이션 원본은 저장하지 않고, 챌린지는 트랜잭션으로 단 한 번만 소비한다.
 * 거절은 전부 `reject` 로 로그에 코드·사유만 남긴다.
 */
export const recoverAccess = onCall(
  { secrets: [ATTESTER_PK, PHONE_INDEX_KEY] },
  async (request): Promise<RecoverAccessResult> => {
    // 1. 로그인한 세션이어야 한다.
    const uid = request.auth?.uid;
    if (!uid) reject('unauthenticated', 'AUTH_REQUIRED');

    // 2. 방금 SMS 로 재인증한 세션이어야 한다. 패스키를 잃은 사람은 옛 세션이 없다.
    const provider = (request.auth?.token as { firebase?: { sign_in_provider?: string } })?.firebase
      ?.sign_in_provider;
    if (provider !== 'phone') reject('failed-precondition', 'PHONE_REAUTH_REQUIRED');

    // 3. 번호는 토큰에서만 읽는다. 요청 본문으로 받으면 전송 중에 개인정보가 흐른다.
    const phoneE164 = request.auth?.token?.phone_number as string | undefined;
    if (!phoneE164) reject('failed-precondition', 'PHONE_REQUIRED');

    // 4. 입력. 호출자 계정은 본문에서 읽지 않는다 — 새 계정은 새 패스키에서 유도한다.
    const { personId, attestation, deviceX, deviceY } = (request.data ?? {}) as {
      personId?: Hex;
      attestation?: unknown;
      deviceX?: Hex;
      deviceY?: Hex;
      platform?: string;
    };
    if (!personId || !B32_RE.test(personId)) reject('invalid-argument', 'BAD_PERSON_ID');

    // 5. 어테스테이션 모양(registerPasskey 와 같은 잣대).
    const registration = requireAttestation(attestation);

    // 6. 새 기기 키는 선택이다. 하나라도 오면 둘 다 제대로 와야 한다.
    const wantsKey = deviceX !== undefined || deviceY !== undefined;
    if (wantsKey) {
      for (const [value, label] of [
        [deviceX, 'BAD_DEVICE_X'],
        [deviceY, 'BAD_DEVICE_Y'],
      ] as const) {
        // 0 좌표는 컨트랙트가 InvalidDeviceKey 로 되돌린다. 여기서 미리 막는다.
        if (!value || !B32_RE.test(value) || value.toLowerCase() === ZERO32) {
          reject('invalid-argument', label);
        }
      }
    }

    // 7. 남의 personId 를 복구하지 못하게 호출자와 사람을 묶는다(registerPasskey 와 같은 규칙).
    const userRef = db.collection(USERS).doc(uid);
    const user = await userRef.get();
    if (user.get('personId') !== personId) reject('permission-denied', 'PERSON_MISMATCH');

    // 8. 번호 확인. 평문 번호가 닿는 유일한 자리 — 여기서 HMAC 으로 바뀌고 버려진다(device.ts 와 동일).
    let provided: string;
    try {
      provided = hmacPhone(phoneE164, PHONE_INDEX_KEY.value());
    } catch (error) {
      // 키가 묶이지 않은 것은 우리 설정 사고다. "번호가 틀렸다" 로 답하면 원인을 아무도 못 찾는다.
      if ((error as Error).message === 'MISSING_PHONE_INDEX_KEY') {
        reject('internal', 'MISSING_PHONE_INDEX_KEY');
      }
      reject('invalid-argument', 'BAD_PHONE');
    }
    const stored = user.get('phoneHmac') as string | undefined;
    if (!stored) reject('failed-precondition', 'NO_PHONE_INDEX');
    if (stored !== provided) reject('permission-denied', 'PHONE_MISMATCH');

    // 9. 사람 상태. 계정이 없으면 애초에 가입을 끝낸 적이 없고, active/kyc_ok 만 복구 대상이다.
    const personRef = db.collection(PERSONS).doc(personId);
    const person = await personRef.get();
    if (!person.exists) reject('not-found', 'PERSON_NOT_FOUND');
    const status = person.get('status') as string | undefined;
    const oldAccount = person.get('account') as Hex | undefined;
    if (!oldAccount) reject('failed-precondition', 'NO_ACCOUNT');
    if (status !== 'active' && status !== 'kyc_ok') reject('failed-precondition', 'BAD_SIGNUP_STATE');

    // 10. 속도 제한(사람당 하루 3회). 비싼 검증·체인 쓰기 **앞에서** 소비해 실패도 세고
    //     어테스터 부하를 막는다. 트랜잭션 안에서 던지고 바깥에서 reject 로 로그를 남긴다.
    const quotaRef = db.collection(RECOVERY_QUOTA).doc(personId);
    try {
      await db.runTransaction(async (tx) => {
        const day = new Date().toISOString().slice(0, 10);
        const doc = await tx.get(quotaRef);
        const count = (doc.get('count') as number | undefined) ?? 0;
        if (doc.get('day') === day && count >= RECOVERY_LIMIT_PER_DAY) {
          throw new Error('RECOVERY_RATE_LIMIT');
        }
        tx.set(quotaRef, { day, count: doc.get('day') === day ? count + 1 : 1 }, { merge: true });
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'RECOVERY_RATE_LIMIT') {
        reject('resource-exhausted', 'RECOVERY_RATE_LIMIT');
      }
      throw error;
    }

    // 11. 챌린지를 한 번만 쓰도록 트랜잭션으로 소비한다(registerPasskey 와 같은 방식).
    let challenge: unknown;
    try {
      challenge = challengeFromClientData(registration.response.clientDataJSON);
    } catch {
      reject('invalid-argument', 'BAD_ATTESTATION');
    }
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
      reject('invalid-argument', 'BAD_CHALLENGE');
    }
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) reject('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) reject('failed-precondition', 'CHALLENGE_USED');
      // 로그인용 챌린지를 등록에 돌려쓰지 못하게 한다(교차 프로토콜 재사용).
      if (doc.get('purpose') !== 'register') reject('permission-denied', 'BAD_CHALLENGE');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        reject('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    // 12. 어테스테이션 검증. 라이브러리 예외는 4xx 로 바꾼다. P-256 좌표는 우리가 다시 본다.
    const verification = await verifyRegistrationResponse({
      response: registration,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID.value(),
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    }).catch(() => ({ verified: false }) as const);
    if (!verification.verified || !verification.registrationInfo) {
      reject('permission-denied', 'ATTESTATION_REJECTED');
    }
    if (!ALLOWED_FORMATS.has(verification.registrationInfo.fmt)) {
      reject('permission-denied', 'ATTESTATION_REJECTED');
    }
    const credential = verification.registrationInfo.credential;
    let owner: Hex;
    try {
      const { x, y } = coseToP256(credential.publicKey);
      owner = ownerBytes(x, y);
    } catch {
      reject('permission-denied', 'ATTESTATION_REJECTED');
    }

    // 13. 새 패스키가 소유자인 스마트 계정 주소를 팩토리에서 계산한다(registerPasskey 와 동일).
    const contracts = deployment();
    const newAccount = getAddress(
      (await publicClient().readContract({
        address: contracts.coinbaseFactory,
        abi: coinbaseFactoryAbi,
        functionName: 'getAddress',
        args: [[owner], ACCOUNT_NONCE],
      })) as string,
    ) as Hex;

    // 14. 같은 계정으로의 회전은 의미가 없다 — 새 패스키가 옛 패스키와 같은 키였다는 뜻이다.
    if (newAccount.toLowerCase() === oldAccount.toLowerCase()) {
      reject('failed-precondition', 'SAME_ACCOUNT');
    }

    // 15. credential id 중복. 다른 사람 것이든 우리 것이든, 이미 있으면 회전을 시작하지 않는다.
    const credentialRef = db.collection(PASSKEYS).doc(credential.id);
    if ((await credentialRef.get()).exists) reject('already-exists', 'CREDENTIAL_EXISTS');

    // 16. 체인 상태. 회전은 되돌릴 수 없으므로 보내기 전에 전부 확인한다.
    let txHash: Hex | undefined;
    let rotateBlock: number | undefined;
    let alreadyRotated = false;

    const onChainAccount = (await publicClient().readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'accountOf',
      args: [personId],
    })) as Hex;

    if (onChainAccount.toLowerCase() === newAccount.toLowerCase()) {
      // 멱등: 체인은 이미 새 계정을 가리킨다. 전송 뒤 DB 반영 전에 죽은 인스턴스를 대신해 재시도한
      // 경우다 — 회전을 다시 보내지 않고 DB 만 맞춘다.
      alreadyRotated = true;
    } else {
      const personOfNew = (await publicClient().readContract({
        address: contracts.identity,
        abi: identityAbi,
        functionName: 'personOf',
        args: [newAccount],
      })) as Hex;
      // 새 계정이 이미 다른 사람에게 묶여 있으면 컨트랙트가 AccountAlreadyRegistered 로 되돌린다.
      if (personOfNew.toLowerCase() !== ZERO_ADDR) reject('failed-precondition', 'ACCOUNT_TAKEN');

      // 7일 쿨다운은 SIM 스왑 방어다(스펙 §18). 컨트랙트가 CooldownActive 로 되돌리기 전에 막는다.
      const rotatedAtVal = (await publicClient().readContract({
        address: contracts.identity,
        abi: identityAbi,
        functionName: 'rotatedAt',
        args: [personId],
      })) as bigint;
      const now = Math.floor(Date.now() / 1000);
      const allowedAt = Number(rotatedAtVal) + ROTATION_COOLDOWN_SECONDS;
      if (now < allowedAt) {
        reject('failed-precondition', 'ROTATION_COOLDOWN', {
          allowedAt,
          now,
          cooldownSeconds: ROTATION_COOLDOWN_SECONDS,
        });
      }

      // 17. 회전 전송. 어테스터 EOA 는 하나라 리스를 잡고 한 번에 하나만 보낸다.
      txHash = await sendSerialized(() =>
        sendAttesterTx({
          address: contracts.identity,
          abi: identityAbi,
          functionName: 'rotateAccount',
          args: [personId, newAccount],
        }),
      );
      const receipt = await publicClient().waitForTransactionReceipt({
        hash: txHash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      // 되돌아간 회전은 계정을 바꾸지 않는다. DB 를 새 계정으로 적으면 안 된다.
      if (receipt.status !== 'success') reject('internal', 'ROTATE_REVERTED');
      await awaitFinalized(receipt.blockNumber);
      rotateBlock = Number(receipt.blockNumber);
    }

    // 18. DB 반영: 옛 패스키를 지우고 새 패스키를 넣고 사람의 계정을 바꾼다. 사람당 패스키는
    //     하나이므로 옛 것을 남기면 옛 계정으로 로그인이 계속된다. 트랜잭션은 읽기가 먼저이므로
    //     옛 패스키 조회는 바깥에서 미리 한다.
    const oldPasskeys = await db.collection(PASSKEYS).where('personId', '==', personId).get();
    const oldIds = oldPasskeys.docs.map((doc) => doc.id);
    await db.runTransaction(async (tx) => {
      for (const id of oldIds) tx.delete(db.collection(PASSKEYS).doc(id));
      tx.set(credentialRef, {
        personId,
        publicKeyCose: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: registration.response.transports ?? [],
        rpId: RP_ID.value(),
        createdAt: FieldValue.serverTimestamp(),
      });
      // 상태는 그대로 둔다 — 같은 사람이 새 계정으로 이어 가는 것이지 'rotated'(종착 상태)가 아니다.
      tx.set(
        personRef,
        alreadyRotated
          ? { account: newAccount, updatedAt: FieldValue.serverTimestamp() }
          : {
              account: newAccount,
              chain: { rotateTx: txHash, rotateBlock },
              updatedAt: FieldValue.serverTimestamp(),
            },
        { merge: true },
      );
    });

    // 19. 새 기기 키는 대기 사본으로만 적는다(device.ts startDeviceChange 와 같은 모양). 네이티브
    //     앱이 나중에 이 값으로 자기 스마트 계정에서 setActiveDevice 를 보낸다 — 서버는 안 보낸다.
    if (wantsKey) {
      await db
        .collection(DEVICES)
        .doc(newAccount)
        .set(
          {
            pendingChange: {
              deviceX: deviceX as Hex,
              deviceY: deviceY as Hex,
              method: 'sms',
              requestedAt: Date.now(),
            },
          },
          { merge: true },
        );
    }

    // 20. 세션 클레임·토큰을 새 계정으로 심는다(loginVerify·registerIdentity 와 같은 모양).
    await mintSessionClaims(uid, personId, newAccount);
    await predeployAccount({ personRef, personId, account: newAccount }).catch(() => {});
    const token = await authAdmin.createCustomToken(uid, { personId, account: newAccount });

    // 21.
    return {
      token,
      personId,
      account: newAccount,
      txHash,
      ...(alreadyRotated ? { alreadyRotated: true } : {}),
    };
  },
);
