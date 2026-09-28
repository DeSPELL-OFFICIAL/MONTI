import { withLease } from './txLease.js';

/** 어테스터 리스는 문서 하나다(`system/attester`). 어테스터 EOA 도 하나뿐이라 그 이상은 필요 없다. */
const LEASE_DOC = 'attester';
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
 * 어테스터 EOA 의 nonce 를 지키는 직렬화 리스. `system/attester` 문서를 쓰는
 * 공용 리스(`txLease.ts`)의 얇은 래퍼다 — 릴레이어와 같은 구현을 리스 문서만 달리해 공유한다.
 *
 * **체인 호출은 리스 밖에서 준비하고 리스 안에서 보낸다.** Firestore 트랜잭션은 충돌 시 본문을
 * 통째로 다시 실행하므로, 안에서 전송하면 같은 등록이 두 번 나갈 수 있다.
 */
export async function withAttesterLease<T>(run: () => Promise<T>): Promise<T> {
  return withLease(LEASE_DOC, run);
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
