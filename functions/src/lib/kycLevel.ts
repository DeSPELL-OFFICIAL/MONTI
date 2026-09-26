import { identityAbi, type Hex } from '@monti/shared';
import { sendSerialized } from './attesterLock.js';
import { deployment, sendAttesterTx } from './chain.js';

/**
 * `Identity.setKycLevel(personId, 1)` 을 어테스터로 보내고 해시만 돌려준다. finality 는 기다리지 않는다.
 *
 * 첫 전송(`diditWebhook`)과 재전송(`reconcilePending`)이 **같은 함수**를 쓴다. 인자가 갈라지면
 * 복구가 원래 웹훅과 다른 것을 체인에 쓰게 된다. `setKycLevel` 은 단순 대입이라 같은 사람에게
 * 두 번 보내도 결과가 같다 — 그래서 재전송이 안전하다.
 *
 * 어테스터 EOA 는 하나뿐이라 리스를 잡고 한 번에 하나만 보낸다(`registerIdentity` 와 같은 규칙).
 * 리스가 없으면 두 인스턴스가 같은 nonce 를 읽어 한쪽이 떨어진다.
 */
export async function sendSetKycLevel(personId: Hex): Promise<Hex> {
  return sendSerialized(() =>
    sendAttesterTx({
      address: deployment().identity,
      abi: identityAbi,
      functionName: 'setKycLevel',
      args: [personId, 1],
    }),
  );
}
