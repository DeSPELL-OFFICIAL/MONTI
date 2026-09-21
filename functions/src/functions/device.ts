import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DEVICE_COOLDOWN_SECONDS, identityAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK, PHONE_INDEX_KEY } from '../config.js';
import { sendSerialized } from '../lib/attesterLock.js';
import { deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { DEVICES, USERS, db } from '../lib/db.js';
import { hmacPhone } from '../lib/phoneIndex.js';

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = `0x${'00'.repeat(32)}`;
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * `lockDevice` 의 결과. 평소에는 `{ txHash }` 다.
 * `alreadyLocked: true` 는 **성공**이다 — 체인이 이미 잠겨 있어서 이번에 보낼 것이 없었다는 뜻이고,
 * 그때 `txHash` 는 없다. 웹 래퍼는 이 값을 오류가 아니라 "잠김"으로 다뤄야 한다.
 */
export type LockDeviceResult = { txHash?: Hex; alreadyLocked?: true };

export type DeviceChangeMethod = 'sms' | 'kyc';

/**
 * `startDeviceChange` 의 결과. 세 숫자는 전부 초 단위 epoch 다.
 * `allowed` 가 false 면 웹은 `allowedAt` 까지 기다리라고 보여 준다.
 * `allowed` 가 true 면 **웹이 자기 스마트 계정으로** `Identity.setActiveDevice(x, y)` 를 보낸다
 * (스폰서 유저옵). 서버는 그 트랜잭션을 대신 보낼 수 없다 — 컨트랙트가 `msg.sender` 를 본다.
 */
export interface DeviceChangeResult {
  allowedAt: number;
  now: number;
  cooldownSeconds: number;
  allowed: boolean;
  pending?: { deviceX: Hex; deviceY: Hex; requestedAt: number };
}

/**
 * 호출자의 사람과 계정이 체인에서도 같은 짝인지 본다. 원본은 언제나 체인이다(스펙 §9.4).
 *
 * `personOf` 만으로는 부족하다 — 계정이 교체된 뒤에도 옛 계정의 `personOf` 는 그대로 남는다
 * (`Ticket.migrate` 가 옛 티켓에서 새 계정을 찾아야 한다, `Identity.sol` `rotateAccount`).
 * `isMember` 까지 봐야 교체되어 버려진 계정에 기기 교체를 걸어 두는 일이 없다 — 그런 계정으로
 * 보낸 `setActiveDevice` 는 웹에서 `NotRegistered` 로 되돌아간다.
 */
async function requireCallerOwnsAccount(uid: string, account: Hex): Promise<void> {
  const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
  if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

  const contracts = deployment();
  const pc = publicClient();
  const [onChain, member] = await Promise.all([
    pc.readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'personOf',
      args: [account],
    }) as Promise<Hex>,
    pc.readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'isMember',
      args: [account],
    }) as Promise<boolean>,
  ]);
  if (!member || onChain.toLowerCase() !== personId.toLowerCase()) {
    throw new HttpsError('permission-denied', 'PERSON_MISMATCH');
  }
}

/**
 * 잠금은 즉시다. 어테스터가 `Identity.lockDevice(account)` 를 보내고, 그 순간부터
 * `Ticket.checkIn` 이 이 계정을 거부한다(스펙 §5.5 / §9.3).
 *
 * **Firestore 에는 아무것도 쓰지 않는다** — 잠금 상태의 원본은 체인이다(스펙 §10.4 규칙 1).
 * 이미 잠겨 있으면 보내지 않고 성공으로 돌려준다. 되돌아간 트랜잭션은 오류로 올린다:
 * "잠갔다"고 답해 놓고 실제로는 안 잠긴 상태가 이 함수에서 가장 위험한 실패다.
 */
export const lockDevice = onCall(
  { secrets: [ATTESTER_PK] },
  async (request): Promise<LockDeviceResult> => {
    const account = await resolveCallerAccount(request);
    const contracts = deployment();
    const pc = publicClient();

    const locked = (await pc.readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'isLocked',
      args: [account],
    })) as boolean;
    if (locked) return { alreadyLocked: true };

    // 어테스터 EOA 는 하나다. 리스를 잡고 한 번에 하나만 보낸다(Task 19).
    const txHash = await sendSerialized(() =>
      sendAttesterTx({
        address: contracts.identity,
        abi: identityAbi,
        functionName: 'lockDevice',
        args: [account],
      }),
    );

    const receipt = await pc.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') throw new HttpsError('internal', 'LOCK_REVERTED');

    return { txHash };
  },
);

/**
 * 새 기기 등록의 서버 몫. 복구 증명을 확인하고, 체인이 언제부터 교체를 허용하는지 알려주고,
 * 새 기기 키를 대기 상태로 적어 둔다.
 *
 * **서버는 `setActiveDevice` 를 대신 보내지 않는다.** 컨트랙트의
 * `setActiveDevice(bytes32 x, bytes32 y)` 는 `msg.sender` 가 등록된 계정이어야 해서
 * 어테스터가 보내면 `NotRegistered` 로 되돌아간다. 서버의 체인 쓰기는 `register` /
 * `rotateAccount` / `lockDevice` 세 개뿐이고(sub-plan 02 §서버 권한), 기기 교체는
 * 관객 웹이 자기 스마트 계정으로 보내는 스폰서 유저옵이다(sub-plan 03).
 *
 * 복구 증명은 두 가지다.
 *  - `sms` — Firebase 전화번호 재인증 세션(`sign_in_provider === 'phone'`)으로 들어와서,
 *    넘긴 번호의 HMAC 이 `users/{uid}.phoneHmac` 과 같아야 한다. 평문 번호는 HMAC 비교
 *    한 번 외에 어디에도 남지 않는다(저장·로그·응답 전부).
 *  - `kyc` — 체인의 `kycLevelOf(account)` 가 1이어야 한다. 아직 0이면 `startKyc` 로
 *    Didit 재검증을 먼저 끝내고 다시 온다.
 *
 * 쿨타임은 언제나 체인의 `deviceUpdatedAt` 에서 읽는다. Firestore 의 값은 참고용 사본이라
 * 여기에 쓰지 않는다(스펙 §9.3).
 */
export const startDeviceChange = onCall(
  // 이 함수는 체인을 읽기만 한다. 어테스터 키는 필요 없고, 받지도 않는다.
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<DeviceChangeResult> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const { method, phone, deviceX, deviceY } = (request.data ?? {}) as {
      method?: string;
      phone?: string;
      deviceX?: Hex;
      deviceY?: Hex;
    };
    if (method !== 'sms' && method !== 'kyc') throw new HttpsError('invalid-argument', 'BAD_METHOD');

    // 새 기기 키는 선택이다 — 웹은 쿨타임만 물어보기도 한다. 하나라도 오면 둘 다 제대로 와야 한다.
    const wantsKey = deviceX !== undefined || deviceY !== undefined;
    if (wantsKey) {
      for (const [value, label] of [
        [deviceX, 'BAD_DEVICE_X'],
        [deviceY, 'BAD_DEVICE_Y'],
      ] as const) {
        // 0 좌표는 컨트랙트가 InvalidDeviceKey 로 되돌린다. 7일을 기다린 뒤에 알게 할 이유가 없다.
        if (!value || !B32_RE.test(value) || value.toLowerCase() === ZERO32) {
          throw new HttpsError('invalid-argument', label);
        }
      }
    }

    const account = await resolveCallerAccount(request);
    await requireCallerOwnsAccount(uid, account);

    if (method === 'sms') {
      const provider = (request.auth?.token as { firebase?: { sign_in_provider?: string } })?.firebase
        ?.sign_in_provider;
      if (provider !== 'phone') throw new HttpsError('failed-precondition', 'PHONE_REAUTH_REQUIRED');

      // 평문 번호가 닿는 유일한 자리. 여기서 HMAC 으로 바뀌고 그대로 버려진다.
      let provided: string;
      try {
        provided = hmacPhone(phone ?? '', PHONE_INDEX_KEY.value());
      } catch (error) {
        // 키가 묶이지 않은 것은 우리 설정 사고다. 그걸 "번호가 틀렸다" 로 답하면
        // 모든 SMS 복구가 조용히 막히고 아무도 원인을 못 찾는다.
        if ((error as Error).message === 'MISSING_PHONE_INDEX_KEY') {
          throw new HttpsError('internal', 'MISSING_PHONE_INDEX_KEY');
        }
        throw new HttpsError('invalid-argument', 'BAD_PHONE');
      }
      const stored = (await db.collection(USERS).doc(uid).get()).get('phoneHmac') as string | undefined;
      if (!stored) throw new HttpsError('failed-precondition', 'NO_PHONE_INDEX');
      if (stored !== provided) throw new HttpsError('permission-denied', 'PHONE_MISMATCH');
    } else {
      const level = (await publicClient().readContract({
        address: deployment().identity,
        abi: identityAbi,
        functionName: 'kycLevelOf',
        args: [account],
      })) as number;
      // "최소한 신분 확인은 끝난 사람" 이 조건이다. 나중에 레벨 2가 생겨도
      // 가장 많이 검증된 사람이 복구 경로를 잃으면 안 된다.
      if (Number(level) < 1) throw new HttpsError('failed-precondition', 'KYC_REQUIRED');
    }

    const updatedAt = (await publicClient().readContract({
      address: deployment().identity,
      abi: identityAbi,
      functionName: 'deviceUpdatedAt',
      args: [account],
    })) as bigint;

    const now = Math.floor(Date.now() / 1000);
    const allowedAt = Number(updatedAt) + DEVICE_COOLDOWN_SECONDS;

    let pending: DeviceChangeResult['pending'];
    if (wantsKey) {
      // 같은 키로 다시 부르면 처음의 `requestedAt` 을 지킨다 — 재시도가 대기 시각을 밀지 않는다.
      // 체인 호출은 전부 위에서 끝났다. 트랜잭션 안에는 Firestore 읽기·쓰기만 있다.
      pending = await db.runTransaction(async (tx) => {
        const ref = db.collection(DEVICES).doc(account);
        const current = await tx.get(ref);
        const same =
          current.get('pendingChange.deviceX') === deviceX &&
          current.get('pendingChange.deviceY') === deviceY;
        const requestedAt = same
          ? (current.get('pendingChange.requestedAt') as number)
          : Date.now();
        const record = { deviceX: deviceX as Hex, deviceY: deviceY as Hex, method, requestedAt };
        tx.set(ref, { pendingChange: record }, { merge: true });
        return { deviceX: record.deviceX, deviceY: record.deviceY, requestedAt };
      });
    }

    return {
      allowedAt,
      now,
      cooldownSeconds: DEVICE_COOLDOWN_SECONDS,
      allowed: now >= allowedAt,
      ...(pending ? { pending } : {}),
    };
  },
);
