import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { error } from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getAddress } from 'viem';
import { identityAbi, type Hex, type PersonStatus } from '@monti/shared';
import { deployment, publicClient } from '../lib/chain.js';
import {
  AUTH_CHALLENGES,
  PERSONS,
  TRANSFER_INVITES,
  USERS,
  assertStatusTransition,
  authAdmin,
  db,
} from '../lib/db.js';

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
 * 가입을 마친 세션에 `personId`·`account` 를 심는다. 모양은 `registerIdentity` 와
 * `loginVerify` 가 만드는 것과 **정확히 같다**(`{ personId, account }`, 주소는 체크섬,
 * 개인정보 없음) — 토큰 두 개가 갈라지면 보안 규칙이 갈라진다.
 *
 * 등록 도중 인스턴스가 죽으면 체인에는 계정이 올라갔는데 클레임만 없는 사람이 남는다.
 * 그 사람은 가입을 끝내고도 자기 문서를 못 읽는다. 여기가 그 구멍을 메우는 유일한 곳이다.
 * uid 는 `registerIdentity` 가 묶어 둔 `users/{uid}.personId` 를 거꾸로 찾아 쓴다
 * (`loginVerify` 와 같은 질의). 묶인 uid 가 없으면 심을 세션도 없으니 조용히 넘어간다.
 */
async function mintSessionClaims(personId: Hex, account: Hex): Promise<void> {
  const users = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
  const uid = users.docs[0]?.id;
  if (!uid) return;
  await authAdmin.setCustomUserClaims(uid, { personId, account: getAddress(account) as Hex });
}

/**
 * `kyc_ok` = Didit 이 승인했지만 `setKycLevel` 이 아직 확정되지 않은 중간 상태
 * (diditWebhook 4번 주석). 그 트랜잭션 하나만 따라간다.
 */
async function reconcileKycLevel(doc: Doc, pc: PublicClient): Promise<void> {
  const levelTx = doc.get('chain.kycLevelTx') as Hex | undefined;
  // 보낸 적이 없으면 따라갈 해시도 없다. 재전송은 어테스터 키가 필요한 별도 작업이다.
  if (!levelTx) return;

  const receipt = await pc.getTransactionReceipt({ hash: levelTx }).catch(() => null);
  if (!receipt) {
    // 드롭된 트랜잭션. 해시를 지워 "이미 보냈다" 로 읽히지 않게 한다.
    await doc.ref.set({ chain: { kycLevelTx: FieldValue.delete() } }, { merge: true });
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
  const txHash = doc.get('chain.registerTx') as Hex | undefined;

  if (txHash) {
    const receipt = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) {
      // 드롭된 트랜잭션. 해시와 딱지를 함께 풀어야 클라이언트가 다시 보낼 수 있다.
      await doc.ref.set(
        {
          chain: {
            registerTx: FieldValue.delete(),
            registerPending: FieldValue.delete(),
            registerPendingAt: FieldValue.delete(),
          },
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
        },
        { merge: true },
      );
      return;
    }
    const finalized = await pc.getBlock({ blockTag: 'finalized' });
    if ((finalized.number ?? 0n) < receipt.blockNumber) return;

    assertStatusTransition(status, 'active');
    await doc.ref.set(
      { status: 'active', chain: { block: Number(receipt.blockNumber) }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    const account = doc.get('account') as Hex | undefined;
    if (account) await mintSessionClaims(doc.id as Hex, account);
    return;
  }

  // 트랜잭션 기록이 없어도 체인이 이미 알고 있으면 DB 를 맞춘다.
  const onChain = (await pc.readContract({
    address: identity,
    abi: identityAbi,
    functionName: 'accountOf',
    args: [doc.id as Hex],
  })) as Hex;
  if (onChain === ZERO) return;

  assertStatusTransition(status, 'active');
  await doc.ref.set({ status: 'active', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  // 계정 주소의 원본은 체인이다 — DB 에 `account` 가 없어도 여기서 세션을 살릴 수 있다.
  await mintSessionClaims(doc.id as Hex, onChain);
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
 */
export const reconcilePending = onSchedule(
  { schedule: SCHEDULE, timeZone: 'Asia/Seoul', timeoutSeconds: 300 },
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
