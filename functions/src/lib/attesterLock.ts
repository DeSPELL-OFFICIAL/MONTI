import { randomUUID } from 'node:crypto';
import { warn } from 'firebase-functions/logger';
import { HttpsError } from 'firebase-functions/v2/https';
import { SYSTEM, db } from './db.js';

/** 어테스터 리스는 문서 하나다. 어테스터 EOA 도 하나뿐이라 그 이상은 필요 없다. */
const LEASE_DOC = 'attester';
/** 인스턴스가 죽어도 이 시간 뒤에는 다음 호출이 리스를 가져간다. 최대 전송 시간보다 넉넉하다. */
const LEASE_TTL_MS = 30_000;
/**
 * 리스가 잡혀 있으면 곧바로 429 를 던지지 않고 **풀릴 때까지 기다린다**. 어테스터 EOA 는
 * 하나뿐이라 동시 가입·주최사 생성이 겹치면 리스 경합은 예외가 아니라 일상이다. 바로
 * 떨어뜨리면 멀쩡한 요청이 남의 트랜잭션 한 번에 실패한다. `LEASE_WAIT_TOTAL_MS` 동안
 * `LEASE_POLL_INTERVAL_MS` 마다 다시 잡아 보고(각 대기에 지터를 얹어 여러 인스턴스가 같은
 * 순간에 몰리는 것을 흩는다), 그래도 못 잡으면 그때 `ATTESTER_BUSY` 를 올린다.
 * 상호 배제는 그대로다 — 잡기 자체는 예전과 똑같은 트랜잭션이고, 그 앞에 유한한 대기열만 세웠다.
 */
const LEASE_WAIT_TOTAL_MS = 12_000;
const LEASE_POLL_INTERVAL_MS = 500;
const LEASE_POLL_JITTER_MS = 250;
/**
 * 재전송해도 안전한 **유일한** 거절 문구. `nonce too low` 는 우리 트랜잭션이 아예
 * 거절됐다는 뜻이라 다시 보내도 쓰기는 한 번이다.
 * `already known` / `replacement transaction underpriced` 는 정반대 — 그 nonce 의
 * 트랜잭션이 **이미 풀에 있다**. `sendAttesterTx` 는 nonce 를 명시하지 않으므로
 * 재전송하면 viem 이 다음 nonce 를 읽어 `register` 가 두 번 나간다. 그쪽은 그대로 올린다.
 */
const NONCE_TOO_LOW = /nonce (is )?too low/i;
const NONCE_RETRY_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 리스를 **한 번** 잡아 본다. 비어 있거나 TTL 로 만료됐으면 잡고 `true`, 아직 남이 들고 있으면
 * `false`. 검사와 쓰기를 한 Firestore 트랜잭션에 묶어, 두 인스턴스가 같은 순간에 같은 리스를
 * 잡는 일을 막는다 — 상호 배제의 핵심은 예전과 똑같이 이 트랜잭션 하나다.
 */
async function tryAcquireLease(
  ref: FirebaseFirestore.DocumentReference,
  holder: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const lockedUntil = (current.get('lockedUntil') as number | undefined) ?? 0;
    if (lockedUntil > Date.now()) return false;
    tx.set(ref, { holder, lockedUntil: Date.now() + LEASE_TTL_MS }, { merge: true });
    return true;
  });
}

/**
 * 리스를 잡을 때까지 유한 시간 기다린다. 경합은 어테스터 EOA 가 하나라 생기는 일상이므로
 * 바로 429 로 떨어뜨리지 않고 `LEASE_WAIT_TOTAL_MS` 안에서 폴링한다. 그 안에 못 잡으면
 * 그때 `ATTESTER_BUSY` 를 올린다 — 남은 것은 정말로 오래 붙잡힌 리스뿐이다.
 */
async function acquireLeaseWithWait(
  ref: FirebaseFirestore.DocumentReference,
  holder: string,
): Promise<void> {
  const deadline = Date.now() + LEASE_WAIT_TOTAL_MS;
  for (;;) {
    if (await tryAcquireLease(ref, holder)) return;
    if (Date.now() >= deadline) {
      warn('attester.lease.timeout', { waitMs: LEASE_WAIT_TOTAL_MS });
      throw new HttpsError('resource-exhausted', 'ATTESTER_BUSY');
    }
    await sleep(LEASE_POLL_INTERVAL_MS + Math.floor(Math.random() * LEASE_POLL_JITTER_MS));
  }
}

/**
 * 어테스터 EOA 의 nonce 를 지키는 직렬화 장치.
 *
 * Functions 인스턴스는 여러 개가 동시에 뜬다. 두 인스턴스가 같은 순간에 어테스터로
 * 트랜잭션을 보내면 둘 다 같은 nonce 를 읽어 하나가 `nonce too low` 로 떨어진다.
 * Firestore 문서 하나를 리스로 삼아 한 번에 하나만 보내게 한다.
 *
 * 리스가 이미 잡혀 있으면 곧바로 실패하지 않고 `acquireLeaseWithWait` 로 **풀릴 때까지
 * 기다린다**. 상호 배제는 그대로 지켜진다 — 한 번에 하나만 잡고 한 번에 하나만 보낸다.
 *
 * **체인 호출은 트랜잭션 밖에서만 한다.** Firestore 트랜잭션은 충돌 시 본문을
 * 통째로 다시 실행하므로, 안에서 전송하면 같은 등록이 두 번 나갈 수 있다.
 */
export async function withAttesterLease<T>(run: () => Promise<T>): Promise<T> {
  const ref = db.collection(SYSTEM).doc(LEASE_DOC);
  const holder = randomUUID();

  await acquireLeaseWithWait(ref, holder);

  try {
    return await run();
  } finally {
    // 반납이 실패해도 원래 결과·오류를 덮어쓰면 안 된다. 보낸 트랜잭션 해시를
    // 이 자리에서 잃으면 세 겹 멱등 장치 중 어느 것도 복구하지 못한다.
    // 반납이 끝내 안 되면 `LEASE_TTL_MS` 뒤 다음 호출이 가져간다.
    try {
      // 리스가 만료돼 이미 남이 가져갔다면 남의 리스를 풀어 주면 안 된다.
      await db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (current.get('holder') !== holder) return;
        tx.set(ref, { holder: null, lockedUntil: 0 }, { merge: true });
      });
    } catch {
      /* 리스는 TTL 로 스스로 풀린다. */
    }
  }
}

/**
 * 리스를 잡고 어테스터 전송을 한 번 한다. nonce 충돌은 우리가 만든 경합이 아니라
 * 직전 전송이 아직 풀에 있는 상태라서, 한 박자 쉬고 한 번만 다시 보낸다
 * (viem 이 그때 다음 nonce 를 새로 읽어 온다). 그 밖의 오류는 그대로 올린다.
 */
export async function sendSerialized<T>(send: () => Promise<T>): Promise<T> {
  return withAttesterLease(async () => {
    try {
      return await send();
    } catch (error) {
      if (!NONCE_TOO_LOW.test((error as Error)?.message ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, NONCE_RETRY_DELAY_MS));
      return send();
    }
  });
}
