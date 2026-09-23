import { randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { SYSTEM, db } from './db.js';

/** 어테스터 리스는 문서 하나다. 어테스터 EOA 도 하나뿐이라 그 이상은 필요 없다. */
const LEASE_DOC = 'attester';
/** 인스턴스가 죽어도 이 시간 뒤에는 다음 호출이 리스를 가져간다. 최대 전송 시간보다 넉넉하다. */
const LEASE_TTL_MS = 30_000;
/**
 * 재전송해도 안전한 **유일한** 거절 문구. `nonce too low` 는 우리 트랜잭션이 아예
 * 거절됐다는 뜻이라 다시 보내도 쓰기는 한 번이다.
 * `already known` / `replacement transaction underpriced` 는 정반대 — 그 nonce 의
 * 트랜잭션이 **이미 풀에 있다**. `sendAttesterTx` 는 nonce 를 명시하지 않으므로
 * 재전송하면 viem 이 다음 nonce 를 읽어 `register` 가 두 번 나간다. 그쪽은 그대로 올린다.
 */
const NONCE_TOO_LOW = /nonce (is )?too low/i;
const NONCE_RETRY_DELAY_MS = 300;

/**
 * 어테스터 EOA 의 nonce 를 지키는 직렬화 장치.
 *
 * Functions 인스턴스는 여러 개가 동시에 뜬다. 두 인스턴스가 같은 순간에 어테스터로
 * 트랜잭션을 보내면 둘 다 같은 nonce 를 읽어 하나가 `nonce too low` 로 떨어진다.
 * Firestore 문서 하나를 리스로 삼아 한 번에 하나만 보내게 한다.
 *
 * **체인 호출은 트랜잭션 밖에서만 한다.** Firestore 트랜잭션은 충돌 시 본문을
 * 통째로 다시 실행하므로, 안에서 전송하면 같은 등록이 두 번 나갈 수 있다.
 */
export async function withAttesterLease<T>(run: () => Promise<T>): Promise<T> {
  const ref = db.collection(SYSTEM).doc(LEASE_DOC);
  const holder = randomUUID();

  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const lockedUntil = (current.get('lockedUntil') as number | undefined) ?? 0;
    if (lockedUntil > Date.now()) throw new HttpsError('resource-exhausted', 'ATTESTER_BUSY');
    tx.set(ref, { holder, lockedUntil: Date.now() + LEASE_TTL_MS }, { merge: true });
  });

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
