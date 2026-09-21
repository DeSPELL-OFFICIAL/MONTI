import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { error } from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { TransactionReceiptNotFoundError } from 'viem';
import { identityAbi, type Hex, type PersonStatus } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import { mintSessionClaims } from '../lib/claims.js';
import {
  AUTH_CHALLENGES,
  PERSONS,
  TRANSFER_INVITES,
  USERS,
  assertStatusTransition,
  db,
} from '../lib/db.js';
import { sendSetKycLevel } from '../lib/kycLevel.js';

const ZERO = '0x0000000000000000000000000000000000000000';
/** 이보다 오래 그대로인 문서만 본다. 살아 있는 호출이 마무리 중인 문서는 건드리지 않는다. */
const STALE_MS = 2 * 60 * 1000;
/**
 * 스윕 하나가 한 번에 볼 문서 수. 상한이 없으면 한 컬렉션의 밀린 문서가 5분을 다 먹고
 * 나머지 스윕은 영영 돌지 않는다. 상한을 넘긴 문서는 다음 실행이 가져간다.
 */
const SWEEP_LIMIT = 200;
const SCHEDULE = 'every 5 minutes';

type PublicClient = ReturnType<typeof publicClient>;
type Doc = FirebaseFirestore.QueryDocumentSnapshot;

/**
 * 고칠 수 없는 문서를 **질의의 꼬리로 돌린다**. persons 질의는 `updatedAt` 에 부등호가 걸려
 * 있어 Firestore 가 오름차순으로 암묵 정렬한다. 포기한 문서가 `updatedAt` 을 그대로 두면
 * 영원히 앞 200칸을 점유해, 그런 문서가 200개를 넘는 순간 새로 낀 사람은 영영 복구되지 않는다.
 *
 * 상태도 새 필드도 만들지 않는다 — `persons.updatedAt` 을 읽는 곳은 이 질의뿐이고,
 * 2분 컷오프가 바로 다음 실행의 중복 방문도 막아 준다.
 */
async function rotate(doc: Doc): Promise<void> {
  await doc.ref.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/**
 * 영수증을 읽되 **"없다"는 답만** 드롭으로 읽는다. 네트워크 오류·타임아웃·429 까지 드롭으로
 * 오독하면 RPC 가 한 번 흔들릴 때 한 실행이 살아 있는 해시 200개를 지우고,
 * `registerIdentity` 의 멱등 ① 이 읽을 해시가 사라져 `register` 가 두 번 나간다.
 * 그 밖의 오류는 그대로 올려 문서별 catch 가 로그만 남기고 문서는 손대지 않게 한다.
 */
async function receiptOrDropped(pc: PublicClient, hash: Hex) {
  try {
    return await pc.getTransactionReceipt({ hash });
  } catch (cause) {
    if (cause instanceof TransactionReceiptNotFoundError) return null;
    throw cause;
  }
}

/** 사람의 계정 주소를 체인에서 읽는다. 등록 전이면 0 주소가 돌아온다. */
async function accountOnChain(pc: PublicClient, identity: Hex, personId: Hex): Promise<Hex> {
  return (await pc.readContract({
    address: identity,
    abi: identityAbi,
    functionName: 'accountOf',
    args: [personId],
  })) as Hex;
}

/**
 * 복구한 사람의 세션에 클레임을 심는다. uid 는 `registerIdentity` 가 묶어 둔
 * `users/{uid}.personId` 를 거꾸로 찾아 쓴다(`loginVerify` 와 같은 질의).
 * 묶인 uid 가 없으면 심을 세션 자체가 없다 — 기록만 남기고 넘어간다.
 */
async function mintClaimsForPerson(personId: Hex, account: Hex): Promise<void> {
  const users = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
  const uid = users.docs[0]?.id;
  if (!uid) {
    error('reconcile.claims.noUser', { personId });
    return;
  }
  await mintSessionClaims(uid, personId, account);
}

/**
 * `kyc_ok` 인데 해시가 없는 사람에게 `setKycLevel` 을 **다시 보낸다**.
 *
 * `diditWebhook` 은 성공했을 때만 `chain.kycLevelTx` 를 쓰고 그때 `status` 도 `active` 로
 * 올리므로, 운영에 남는 멈춘 `kyc_ok` 은 셋 다 해시가 없다 — 커밋 후 전송 전 사망,
 * revert(해시를 일부러 버린다), 전송 후 finalize 전 사망. 여기가 그 셋의 유일한 복구 경로다.
 *
 * 보낸 해시만 적고 이번 실행은 끝낸다. 방금 보낸 트랜잭션의 영수증은 아직 없어서
 * 바로 이어 읽으면 드롭으로 오독해 그 해시를 도로 지운다. 다음 실행(2분 컷오프 뒤)이
 * 기존 영수증 경로로 `active` 까지 끌고 간다.
 */
async function resendKycLevel(doc: Doc): Promise<void> {
  const personId = doc.id as Hex;
  let txHash: Hex;
  try {
    txHash = await sendSetKycLevel(personId);
  } catch (cause) {
    // 전송 실패는 여기서 끝이다. 사람은 `kyc_ok` 그대로 남아 다음 실행이 다시 집는다.
    error('reconcile.kycLevel.send', { personId, reason: (cause as Error).message });
    await rotate(doc);
    return;
  }
  await doc.ref.set(
    {
      chain: { kycLevelTx: txHash, kycLevelError: FieldValue.delete() },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * `kyc_ok` = Didit 이 승인했지만 `setKycLevel` 이 아직 확정되지 않은 중간 상태
 * (diditWebhook 4번 주석). 해시가 있으면 따라가고, 없으면 다시 보낸다.
 */
async function reconcileKycLevel(doc: Doc, pc: PublicClient): Promise<void> {
  const levelTx = doc.get('chain.kycLevelTx') as Hex | undefined;
  if (!levelTx) {
    await resendKycLevel(doc);
    return;
  }

  const receipt = await receiptOrDropped(pc, levelTx);
  if (!receipt) {
    // 드롭된 트랜잭션. 해시를 지우면 다음 실행이 재전송 경로로 집어 간다.
    await doc.ref.set(
      { chain: { kycLevelTx: FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return;
  }
  if (receipt.status !== 'success') {
    // 되돌아갔으면 레벨은 0 그대로다. 사람만 `active` 로 되돌려 중간 상태에서 꺼낸다.
    assertStatusTransition('kyc_ok', 'active');
    await doc.ref.set(
      {
        status: 'active',
        chain: { kycLevelTx: FieldValue.delete() },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return;
  }

  // 스펙 §10.4 규칙 3: finalized 뒤에만 완료 처리한다.
  const finalized = await pc.getBlock({ blockTag: 'finalized' });
  if ((finalized.number ?? 0n) < receipt.blockNumber) return;

  assertStatusTransition('kyc_ok', 'active');
  await doc.ref.set(
    {
      status: 'active',
      kycLevel: 1,
      chain: { block: Number(receipt.blockNumber) },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** `pending` = `Identity.register` 가 아직 확정되지 않은 상태. 해시가 있으면 따라가고, 없으면 체인에 물어본다. */
async function reconcileRegistration(
  doc: Doc,
  pc: PublicClient,
  identity: Hex,
  status: PersonStatus,
): Promise<void> {
  const personId = doc.id as Hex;
  const txHash = doc.get('chain.registerTx') as Hex | undefined;

  if (txHash) {
    const receipt = await receiptOrDropped(pc, txHash);
    if (!receipt) {
      // 드롭된 트랜잭션. 해시와 딱지를 함께 풀어야 클라이언트가 다시 보낼 수 있다.
      await doc.ref.set(
        {
          chain: {
            registerTx: FieldValue.delete(),
            registerPending: FieldValue.delete(),
            registerPendingAt: FieldValue.delete(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }
    if (receipt.status !== 'success') {
      await doc.ref.set(
        {
          chain: {
            registerTx: FieldValue.delete(),
            registerPending: FieldValue.delete(),
            registerPendingAt: FieldValue.delete(),
            lastFailedTx: txHash,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }
    const finalized = await pc.getBlock({ blockTag: 'finalized' });
    if ((finalized.number ?? 0n) < receipt.blockNumber) return;

    // 클레임을 **상태보다 먼저** 심는다. 순서가 뒤집히면 `setCustomUserClaims` 가 던졌을 때
    // 문서는 이미 `active` 라 질의에서 빠지고, 클레임 없는 사람이 영구히 남는다 —
    // 이 복구가 메우려던 바로 그 구멍이다. 다시 심어도 같은 값을 덮어쓸 뿐이라 재실행이 안전하다.
    const account =
      (doc.get('account') as Hex | undefined) ?? (await accountOnChain(pc, identity, personId));
    if (account && account !== ZERO) await mintClaimsForPerson(personId, account);
    else error('reconcile.claims.noAccount', { personId });

    assertStatusTransition(status, 'active');
    await doc.ref.set(
      {
        status: 'active',
        chain: { block: Number(receipt.blockNumber) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return;
  }

  // 트랜잭션 기록이 없어도 체인이 이미 알고 있으면 DB 를 맞춘다.
  const onChain = await accountOnChain(pc, identity, personId);
  if (onChain === ZERO) {
    // 고칠 것이 없다. 앞줄을 비켜 준다.
    await rotate(doc);
    return;
  }

  // 계정 주소의 원본은 체인이다 — DB 에 `account` 가 없어도 세션을 살릴 수 있다.
  await mintClaimsForPerson(personId, onChain);
  assertStatusTransition(status, 'active');
  await doc.ref.set({ status: 'active', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** 2분 넘게 `pending`·`kyc_ok` 에 멈춘 사람을 체인과 대조해 고친다(스펙 §10.4 규칙 3). */
async function sweepPersons(): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS);
  const snapshot = await db
    .collection(PERSONS)
    .where('status', 'in', ['pending', 'kyc_ok'])
    .where('updatedAt', '<', cutoff)
    .limit(SWEEP_LIMIT)
    .get();
  if (snapshot.empty) return;

  const pc = publicClient();
  const identity = deployment().identity;

  for (const doc of snapshot.docs) {
    // 문서 하나가 터져도 나머지는 계속 간다 — 깨진 문서 하나가 밀린 전부를 막지 않는다.
    try {
      const status = doc.get('status') as PersonStatus;
      if (status === 'kyc_ok') await reconcileKycLevel(doc, pc);
      else await reconcileRegistration(doc, pc, identity, status);
    } catch (cause) {
      error('reconcile.person', { personId: doc.id, reason: (cause as Error).message });
    }
  }
}

/**
 * 만료된 양도 초대를 `expired` 로 내린다. `pendingOffers` 는 `status == 'sent'` 를 50건까지만
 * 읽으므로, 죽은 초대가 쌓이면 살아 있는 초대가 그 50건 밖으로 밀려난다. 체인에는 손대지 않는다 —
 * 오퍼의 원본은 언제나 `Ticket.offerOf` 다.
 *
 * 만료 판정은 메모리에서 한다. `status` + `expiresAt` 복합 색인을 새로 만들지 않기 위해서다.
 * 내려간 문서는 `sent` 집합에서 빠지므로 다음 실행이 같은 문서를 다시 보지 않는다.
 */
async function sweepTransferInvites(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await db
    .collection(TRANSFER_INVITES)
    .where('status', '==', 'sent')
    .limit(SWEEP_LIMIT)
    .get();

  for (const doc of snapshot.docs) {
    const expiresAt = doc.get('expiresAt') as number | undefined;
    if (typeof expiresAt !== 'number' || expiresAt >= now) continue;
    try {
      await doc.ref.set({ status: 'expired' }, { merge: true });
    } catch (cause) {
      error('reconcile.invite', { inviteId: doc.id, reason: (cause as Error).message });
    }
  }
}

/**
 * 만료된 인증 챌린지를 지운다. `loginChallenge` 가 호출 한 번에 문서 하나를 만들고
 * (`loginVerify`·`registerPasskey` 가 소비한다) 누구도 지우지 않으므로, 청소가 없으면
 * 이 컬렉션만 영원히 자란다. **저장된 `expiresAt` 만 보고 지운다** — 나이로 추측하지 않는다.
 */
async function sweepAuthChallenges(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await db
    .collection(AUTH_CHALLENGES)
    .where('expiresAt', '<', now)
    .limit(SWEEP_LIMIT)
    .get();

  for (const doc of snapshot.docs) {
    try {
      await doc.ref.delete();
    } catch (cause) {
      error('reconcile.challenge', { reason: (cause as Error).message });
    }
  }
}

/**
 * 5분마다 도는 대사(對査) 함수. 체인과 DB 를 함께 건드리다 중간에 죽은 작업을 주워 고친다
 * (스펙 §10.4 규칙 3의 "주기적 대사 함수").
 *
 * 스윕은 서로 독립이다. 하나가 터져도 나머지는 돌고, **스케줄러 밖으로는 절대 던지지 않는다** —
 * 여기서 던지면 Cloud Scheduler 가 같은 실행을 재시도해 이미 고친 문서를 다시 훑는다.
 *
 * 어테스터 키가 필요한 이유는 하나뿐이다: 멈춘 `kyc_ok` 의 `setKycLevel` 재전송.
 */
export const reconcilePending = onSchedule(
  { schedule: SCHEDULE, timeZone: 'Asia/Seoul', timeoutSeconds: 300, secrets: [ATTESTER_PK] },
  async () => {
    const sweeps = [
      ['persons', sweepPersons],
      ['transferInvites', sweepTransferInvites],
      ['authChallenges', sweepAuthChallenges],
    ] as const;

    for (const [name, sweep] of sweeps) {
      try {
        await sweep();
      } catch (cause) {
        error('reconcile.sweep', { sweep: name, reason: (cause as Error).message });
      }
    }
  },
);
