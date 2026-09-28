import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { identityAbi, type Hex, type PersonStatus } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { sendSerialized } from '../lib/attesterLock.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { mintSessionClaims } from '../lib/claims.js';
import { DEVICES, PERSONS, USERS, assertStatusTransition, db } from '../lib/db.js';
import { predeployAccount } from '../lib/predeployAccount.js';

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const PLATFORMS = ['ios', 'android', 'web'] as const;
type Platform = (typeof PLATFORMS)[number];
const RECEIPT_TIMEOUT_MS = 30_000;
/**
 * `registerPending` 딱지의 수명. 전송 도중 인스턴스가 죽으면(OOM·타임아웃·배포 교체)
 * 딱지만 남고 해시는 없어서, 만료가 없으면 그 사람은 영영 가입을 못 한다.
 * 함수 자체의 최대 수명이 60초(config.ts `timeoutSeconds`)이므로 이보다 오래된 딱지는
 * 살아 있는 인스턴스의 것일 수 없다.
 */
const PENDING_TTL_MS = 60_000;

/**
 * 호출 결과. 평소에는 `{ txHash }` 다.
 * `alreadyRegistered: true` 는 **성공**이고 — 체인이 이미 그 계정을 알고 있어서
 * 이번에 보낼 것이 없었다는 뜻이다. 그때 `txHash` 는 없다(우리가 보낸 적이 없으므로).
 * 웹 래퍼는 이 값을 오류가 아니라 "가입 완료"로 다뤄야 한다.
 *
 * `claimsUpdated` 는 언제나 붙는다 — 성공으로 돌아온 순간 세션 클레임은 이미 심어져 있으니
 * 웹은 `getIdToken(true)` 를 **한 번만** 부르면 된다.
 */
export type RegisterIdentityResult = {
  txHash?: Hex;
  alreadyRegistered?: true;
  claimsUpdated: true;
};

/** 체인에 올라간 뒤의 마무리. 성공 경로와 "이미 보낸 트랜잭션" 경로가 같이 쓴다. */
async function settle(input: {
  personRef: FirebaseFirestore.DocumentReference;
  txHash: Hex;
  status: PersonStatus;
  account: Hex;
  deviceX: Hex;
  deviceY: Hex;
  platform: Platform;
}): Promise<Hex> {
  const { personRef, txHash, status, account, deviceX, deviceY, platform } = input;

  const receipt = await publicClient().waitForTransactionReceipt({
    hash: txHash,
    timeout: RECEIPT_TIMEOUT_MS,
  });
  // 되돌아간 트랜잭션은 상태를 올리지 않는다. 해시는 남아 있으니 reconcilePending 이 고친다.
  if (receipt.status !== 'success') throw new HttpsError('internal', 'REGISTER_REVERTED');

  // 스펙 §10.4 규칙 3: finalized 뒤에만 완료 처리한다.
  await awaitFinalized(receipt.blockNumber);
  assertStatusTransition(status, 'active');

  // 기기 문서는 보안 규칙이 클라이언트 생성을 막는다(웹은 `pushToken` 만 갱신한다).
  // 체인 등록이 확정된 지금 서버가 만든다. 개인정보는 들어가지 않는다.
  await db
    .collection(DEVICES)
    .doc(account)
    .set({ deviceX, deviceY, platform, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  await personRef.set(
    {
      status: 'active',
      chain: { registerTx: txHash, block: Number(receipt.blockNumber) },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return txHash;
}

/**
 * 어테스터가 `Identity.register(personId, account, deviceX, deviceY, kycLevel)` 를 보낸다.
 * 서버가 가진 유일한 체인 쓰기 권한이고, 관객 키는 어디에도 없다.
 *
 * **같은 `personId` 로 두 번 불러도 체인 쓰기는 한 번**이다(스펙 §10.4 규칙 3).
 * 세 겹으로 막는다. ① 이미 기록된 트랜잭션이 있으면 그 해시를 쓰고, 아직 확정 전이면
 * **다시 보내지 않고 기다린다**. ② 체인이 이미 그 계정을 알고 있으면 DB 만 맞추고
 * `{ alreadyRegistered: true }` 로 **성공** 반환한다(보낸 적이 없으니 `txHash` 는 없다).
 * ③ 전송 직전 Firestore 트랜잭션으로 `registerPending` 딱지를 붙여 동시 호출을 막고,
 * 그 딱지는 `PENDING_TTL_MS` 가 지나면 죽은 인스턴스가 남긴 것으로 보고 무시한다.
 *
 * 호출자는 언제나 자기 자신만 등록한다 — `users/{uid}.personId` 와 인자가 같아야 한다.
 */
export const registerIdentity = onCall(
  { secrets: [ATTESTER_PK] },
  async (request): Promise<RegisterIdentityResult> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { personId, deviceX, deviceY, platform } = (request.data ?? {}) as {
      personId?: Hex;
      deviceX?: Hex;
      deviceY?: Hex;
      platform?: string;
    };
    for (const [value, label] of [
      [personId, 'BAD_PERSON_ID'],
      [deviceX, 'BAD_DEVICE_X'],
      [deviceY, 'BAD_DEVICE_Y'],
    ] as const) {
      if (!value || !B32_RE.test(value)) throw new HttpsError('invalid-argument', label);
    }
    if (platform !== undefined && !PLATFORMS.includes(platform as Platform)) {
      throw new HttpsError('invalid-argument', 'BAD_PLATFORM');
    }
    const device = {
      deviceX: deviceX as Hex,
      deviceY: deviceY as Hex,
      platform: (platform ?? 'web') as Platform,
    };

    // 남의 personId 로 자기 기기 키를 체인에 박지 못하게 호출자와 사람을 묶는다
    // (registerPasskey 와 같은 규칙). 이 함수는 공격자가 준 키를 체인 쓰기에 그대로 넘긴다.
    const user = await db.collection(USERS).doc(uid).get();
    if (user.get('personId') !== personId) {
      throw new HttpsError('permission-denied', 'PERSON_MISMATCH');
    }

    const personRef = db.collection(PERSONS).doc(personId as Hex);
    const person = await personRef.get();
    if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
    const status = person.get('status') as PersonStatus;
    if (status !== 'pending' && status !== 'active') {
      throw new HttpsError('failed-precondition', 'BAD_SIGNUP_STATE');
    }
    const account = person.get('account') as Hex | undefined;
    if (!account) throw new HttpsError('failed-precondition', 'PASSKEY_REQUIRED');
    // 가입은 언제나 0이다. 본인인증을 이미 통과한 사람을 다시 등록하는 경우만 1이 된다.
    const kycLevel = person.get('kycLevel') === 1 ? 1 : 0;

    // 멱등 ①: 이미 보낸 트랜잭션. 확정됐으면 해시만, 아니면 그 트랜잭션을 기다린다.
    const existingTx = person.get('chain.registerTx') as Hex | undefined;
    if (existingTx) {
      if (person.get('chain.block') !== undefined) {
        await mintSessionClaims(uid, personId as Hex, account);
        return { txHash: existingTx, claimsUpdated: true };
      }
      const txHash = await settle({ personRef, txHash: existingTx, status, account, ...device });
      await mintSessionClaims(uid, personId as Hex, account);
      await predeployAccount({ personRef, personId: personId as Hex, account }).catch(() => {});
      return { txHash, claimsUpdated: true };
    }

    // 멱등 ②: 체인이 이미 알고 있으면 보내지 않고 DB 만 맞춘다.
    const contracts = deployment();
    const member = (await publicClient().readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'isMember',
      args: [account],
    })) as boolean;
    if (member) {
      assertStatusTransition(status, 'active');
      await personRef.set(
        { status: 'active', updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      // 등록은 이미 끝났다. 이것은 오류가 아니라 성공이다 — 오류로 올리면 일반적인
      // 콜러블 래퍼가 멀쩡히 가입된 사람에게 실패 화면을 보여 준다.
      // 전송 뒤 죽은 인스턴스를 대신해 재시도한 경우이므로 세션도 여기서 쓸 수 있게 만든다.
      await mintSessionClaims(uid, personId as Hex, account);
      await predeployAccount({ personRef, personId: personId as Hex, account }).catch(() => {});
      return { alreadyRegistered: true, claimsUpdated: true };
    }

    // 멱등 ③: 동시 호출 잠금. Firestore 트랜잭션이 직렬화를 보장한다.
    await db.runTransaction(async (tx) => {
      const current = await tx.get(personRef);
      if (current.get('chain.registerTx')) throw new HttpsError('aborted', 'ALREADY_SENT');
      // 살아 있는 딱지만 막는다. 전송 중 죽은 인스턴스가 남긴 딱지는 없는 것으로 본다.
      const pendingSince = (current.get('chain.registerPendingAt') as number | undefined) ?? 0;
      if (current.get('chain.registerPending') && Date.now() - pendingSince < PENDING_TTL_MS) {
        throw new HttpsError('aborted', 'REGISTER_IN_FLIGHT');
      }
      tx.set(
        personRef,
        {
          chain: { registerPending: true, registerPendingAt: Date.now() },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    let txHash: Hex;
    try {
      // 어테스터 EOA 는 하나다. 리스를 잡고 한 번에 하나만 보낸다.
      txHash = await sendSerialized(() =>
        sendAttesterTx({
          address: contracts.identity,
          abi: identityAbi,
          functionName: 'register',
          args: [personId as Hex, account, device.deviceX, device.deviceY, kycLevel],
        }),
      );
    } catch (error) {
      // 딱지를 남기면 이 사람은 영원히 가입을 못 한다. 어떤 실패든 반드시 지운다.
      await personRef.set(
        { chain: { registerPending: FieldValue.delete(), registerPendingAt: FieldValue.delete() } },
        { merge: true },
      );
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', `REGISTER_SEND_FAILED:${(error as Error).message}`);
    }

    await personRef.set(
      {
        chain: {
          registerTx: txHash,
          registerPending: FieldValue.delete(),
          registerPendingAt: FieldValue.delete(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const settled = await settle({ personRef, txHash, status, account, ...device });
    await mintSessionClaims(uid, personId as Hex, account);
    await predeployAccount({ personRef, personId: personId as Hex, account }).catch(() => {});
    return { txHash: settled, claimsUpdated: true };
  },
);
