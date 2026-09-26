import { FieldValue } from 'firebase-admin/firestore';
import { error, warn } from 'firebase-functions/logger';
import { getAddress } from 'viem';
import { coinbaseFactoryAbi, type Hex } from '@monti/shared';
import { sendSerialized } from './attesterLock.js';
import { deployment, publicClient, sendAttesterTx } from './chain.js';
import { PASSKEYS, db } from './db.js';
import { coseToP256, ownerBytes } from './webauthn.js';

/** 사람마다 계정은 하나뿐이라 팩토리 nonce 는 항상 0이다(registerPasskey 와 같은 값). */
const ACCOUNT_NONCE = 0n;

/**
 * 사람의 패스키 소유자(x‖y 64바이트)를 되살린다. `registerPasskey` 가 계정 주소를 계산할 때
 * 팩토리에 넘긴 것과 **한 바이트도 다르지 않은** 값이어야 한다 — 그래야 createAccount 가
 * 기록된 `account` 와 같은 주소에 떨어진다. 원본은 `passkeys/{credentialId}.publicKeyCose` 다.
 */
async function ownerForPerson(personId: Hex): Promise<Hex | null> {
  const snapshot = await db.collection(PASSKEYS).where('personId', '==', personId).limit(1).get();
  const cose = snapshot.docs[0]?.get('publicKeyCose') as string | undefined;
  if (!cose) return null;
  const { x, y } = coseToP256(Buffer.from(cose, 'base64'));
  return ownerBytes(x, y);
}

/**
 * 사람의 스마트 계정을 **가입 시점에 미리 배포한다**. 새 계정에서 나가는 첫 스폰서 op 는
 * `initCode` 를 실어 번들러 선충전이 2배 수수료에서 op 당 ≈0.78 MON 까지 뛰고, 동시 가입이
 * 겹치면 페이마스터 예치금이 바닥난다. 가입 때 계정을 배포해 두면 이후 모든 op 에서 `initCode`
 * 가 사라지고(선충전 ≈0.15 MON) 미스테이크 팩토리 규칙도 피한다.
 *
 * 세 겹으로 안전하다. ① 이미 코드가 있으면 아무것도 보내지 않는다(멱등). ② 팩토리에 물어본
 * 예측 주소가 기록된 `account` 와 다르면 우리가 엉뚱한 소유자를 쓴 것이므로 **절대 보내지 않고**
 * 오류만 남긴다. ③ 어떤 실패도 가입을 막지 않는다 — `accountDeployPending` 딱지를 남겨
 * `reconcilePending` 이 다음 틱에 다시 시도한다.
 *
 * 호출자는 결과를 기다리지 않아도 된다. `settle` 이 끝난 뒤(사람은 이미 `active`) 불린다.
 */
export async function predeployAccount(params: {
  personRef: FirebaseFirestore.DocumentReference;
  personId: Hex;
  account: Hex;
}): Promise<void> {
  const { personRef, personId, account } = params;
  try {
    const pc = publicClient();
    const code = await pc.getCode({ address: account });
    if (code && code !== '0x') {
      // 이미 배포돼 있다. 스윕이 붙여 둔 딱지가 있으면 걷는다.
      await clearPending(personRef);
      return;
    }

    const owner = await ownerForPerson(personId);
    if (!owner) {
      // 패스키와 계정 주소는 registerPasskey 에서 함께 태어난다 — 여기 오면 데이터가 깨진 것이다.
      error('account.predeploy.nopasskey', { personId });
      await clearPending(personRef);
      return;
    }

    const contracts = deployment();
    const predicted = getAddress(
      (await pc.readContract({
        address: contracts.coinbaseFactory,
        abi: coinbaseFactoryAbi,
        functionName: 'getAddress',
        args: [[owner], ACCOUNT_NONCE],
      })) as string,
    );
    // createAccount 는 CREATE2 라 (owner, nonce) 가 같으면 반드시 이 주소에 떨어진다. 예측이
    // 기록된 계정과 다르면 소유자를 잘못 되살린 것이므로, 엉뚱한 곳에 계약을 심지 않도록 멈춘다.
    if (predicted !== getAddress(account)) {
      error('account.predeploy.mismatch', { personId, predicted, account });
      await clearPending(personRef);
      return;
    }

    // 어테스터 EOA 는 하나다. 리스를 잡고 한 번에 하나만 보낸다(register 와 같은 규칙).
    const txHash = await sendSerialized(() =>
      sendAttesterTx({
        address: contracts.coinbaseFactory,
        abi: coinbaseFactoryAbi,
        functionName: 'createAccount',
        args: [[owner], ACCOUNT_NONCE],
      }),
    );
    // 딱지를 남긴다 — 다음 대사(reconcilePending)가 코드가 실제로 올라왔는지 확인하고 걷는다.
    await personRef.set(
      {
        chain: { accountDeployPending: true, accountDeployTx: txHash },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (cause) {
    // 가입은 막지 않는다. 딱지를 남겨 대사 스윕이 다시 시도하게 한다.
    warn('account.predeploy.failed', { personId, reason: (cause as Error).message });
    try {
      await personRef.set(
        { chain: { accountDeployPending: true }, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    } catch {
      /* 딱지 쓰기까지 실패하면 다음 가입 재시도나 운영이 줍는다. */
    }
  }
}

/** 배포가 확인된 자리에서 재시도 딱지를 걷는다. */
async function clearPending(personRef: FirebaseFirestore.DocumentReference): Promise<void> {
  await personRef.set(
    {
      chain: { accountDeployPending: FieldValue.delete() },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
