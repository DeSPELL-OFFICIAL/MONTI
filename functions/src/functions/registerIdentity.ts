import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { identityAbi, type Hex, type PersonStatus } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { sendSerialized } from '../lib/attesterLock.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { DEVICES, PERSONS, assertStatusTransition, db } from '../lib/db.js';

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const PLATFORMS = ['ios', 'android', 'web'] as const;
type Platform = (typeof PLATFORMS)[number];
const RECEIPT_TIMEOUT_MS = 30_000;

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
 * **다시 보내지 않고 기다린다**. ② 체인이 이미 그 계정을 알고 있으면 DB 만 맞춘다.
 * ③ 전송 직전 Firestore 트랜잭션으로 `registerPending` 딱지를 붙여 동시 호출을 막는다.
 */
export const registerIdentity = onCall(
  { secrets: [ATTESTER_PK] },
  async (request): Promise<{ txHash: Hex }> => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
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
      if (person.get('chain.block') !== undefined) return { txHash: existingTx };
      return { txHash: await settle({ personRef, txHash: existingTx, status, account, ...device }) };
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
      throw new HttpsError('already-exists', 'ALREADY_REGISTERED_ON_CHAIN');
    }

    // 멱등 ③: 동시 호출 잠금. Firestore 트랜잭션이 직렬화를 보장한다.
    await db.runTransaction(async (tx) => {
      const current = await tx.get(personRef);
      if (current.get('chain.registerTx')) throw new HttpsError('aborted', 'ALREADY_SENT');
      if (current.get('chain.registerPending')) {
        throw new HttpsError('aborted', 'REGISTER_IN_FLIGHT');
      }
      tx.set(
        personRef,
        { chain: { registerPending: true }, updatedAt: FieldValue.serverTimestamp() },
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
      await personRef.set({ chain: { registerPending: FieldValue.delete() } }, { merge: true });
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', `REGISTER_SEND_FAILED:${(error as Error).message}`);
    }

    await personRef.set(
      {
        chain: { registerTx: txHash, registerPending: FieldValue.delete() },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { txHash: await settle({ personRef, txHash, status, account, ...device }) };
  },
);
