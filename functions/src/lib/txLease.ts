import { randomUUID } from 'node:crypto';
import { warn } from 'firebase-functions/logger';
import { HttpsError } from 'firebase-functions/v2/https';
import { SYSTEM, db } from './db.js';

/**
 * EOA 하나의 nonce 를 지키는 직렬화 리스. 어테스터(`attester`)와 릴레이어(`relayer`)가
 * **서로 다른 리스 문서**(`system/<leaseDoc>`)로 이 한 구현을 공유한다. EOA 를 분리하는
 * 이유는 블래스트 반경·nonce 레인을 나누기 위해서다(설계 §5) — 리스 로직 자체는 같다.
 */

/** 인스턴스가 죽어도 이 시간 뒤에는 다음 호출이 리스를 가져간다. 최대 전송 시간보다 넉넉하다. */
const LEASE_TTL_MS = 30_000;
/**
 * 리스가 잡혀 있으면 곧바로 429 를 던지지 않고 **풀릴 때까지 기다린다**. EOA 는 하나뿐이라
 * 동시 요청이 겹치면 리스 경합은 예외가 아니라 일상이다. `LEASE_WAIT_TOTAL_MS` 동안
 * `LEASE_POLL_INTERVAL_MS` 마다 다시 잡아 보고(지터를 얹어 여러 인스턴스가 같은 순간에
 * 몰리는 것을 흩는다), 그래도 못 잡으면 그때 `<LEASE>_BUSY` 를 올린다. 상호 배제는 그대로다.
 */
const LEASE_WAIT_TOTAL_MS = 12_000;
const LEASE_POLL_INTERVAL_MS = 500;
const LEASE_POLL_JITTER_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 리스를 **한 번** 잡아 본다. 비어 있거나 TTL 로 만료됐으면 잡고 `true`, 아직 남이 들고 있으면
 * `false`. 검사와 쓰기를 한 Firestore 트랜잭션에 묶어, 두 인스턴스가 같은 순간에 같은 리스를
 * 잡는 일을 막는다 — 상호 배제의 핵심은 이 트랜잭션 하나다.
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
 * 리스를 잡을 때까지 유한 시간 기다린다. 그 안에 못 잡으면 `<LEASE>_BUSY` 를 올린다 —
 * 남은 것은 정말로 오래 붙잡힌 리스뿐이다.
 */
async function acquireLeaseWithWait(
  ref: FirebaseFirestore.DocumentReference,
  holder: string,
  leaseDoc: string,
): Promise<void> {
  const deadline = Date.now() + LEASE_WAIT_TOTAL_MS;
  for (;;) {
    if (await tryAcquireLease(ref, holder)) return;
    if (Date.now() >= deadline) {
      warn(`${leaseDoc}.lease.timeout`, { waitMs: LEASE_WAIT_TOTAL_MS });
      throw new HttpsError('resource-exhausted', `${leaseDoc.toUpperCase()}_BUSY`);
    }
    await sleep(LEASE_POLL_INTERVAL_MS + Math.floor(Math.random() * LEASE_POLL_JITTER_MS));
  }
}

/**
 * `system/<leaseDoc>` 리스를 잡고 `run` 을 한 번 돌린다. EOA 의 nonce 를 지키는 직렬화 장치다.
 *
 * Functions 인스턴스는 여러 개가 동시에 뜬다. 두 인스턴스가 같은 순간에 같은 EOA 로
 * 트랜잭션을 보내면 둘 다 같은 nonce 를 읽어 하나가 `nonce too low` 로 떨어진다.
 * Firestore 문서 하나를 리스로 삼아 한 번에 하나만 보내게 한다.
 *
 * **체인 호출은 리스 안에서만 nonce+서명+브로드캐스트로 좁힌다.** estimate·시뮬 같은 느린
 * RPC 는 리스 밖에서 하라(설계 §5) — 임계구역이 짧을수록 버스트 처리량이 오른다.
 */
export async function withLease<T>(leaseDoc: string, run: () => Promise<T>): Promise<T> {
  const ref = db.collection(SYSTEM).doc(leaseDoc);
  const holder = randomUUID();

  await acquireLeaseWithWait(ref, holder, leaseDoc);

  try {
    return await run();
  } finally {
    // 반납이 실패해도 원래 결과·오류를 덮어쓰면 안 된다. 반납이 끝내 안 되면 `LEASE_TTL_MS`
    // 뒤 다음 호출이 가져간다. 리스가 만료돼 이미 남이 가져갔다면 남의 리스를 풀면 안 된다.
    try {
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
