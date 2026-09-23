import { FieldValue } from 'firebase-admin/firestore';
import { warn } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { parseEventLogs } from 'viem';
import { organizersAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { sendSerialized } from '../lib/attesterLock.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { ORG_PROFILES, PERSONS, USERS, db } from '../lib/db.js';

/** 이름의 길이는 **코드 포인트**로 센다. `'가'.length` 는 1 이지만 이모지는 2 다. */
const MIN_NAME_CHARS = 2;
const MAX_NAME_CHARS = 40;
/** C0·DEL·C1 제어문자. 화면·로그·CSV 를 한 번에 망가뜨리므로 이름에 들어올 이유가 없다. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 한 사람이 만들 수 있는 주최사의 수. 어테스터가 **대신** 보내 주는 트랜잭션이라
 * 상한이 없으면 한 사람이 우리 가스를 끝없이 태운다. MVP 의 창업자 판단은 3 이다.
 */
export const MAX_ORGS_PER_PERSON = 3;

const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * 거절을 **로그에 남기고** 던진다(`startKyc` 와 같은 규칙).
 *
 * Callable 은 `invalid-argument` 와 `failed-precondition` 을 똑같이 HTTP 400 으로 내려보낸다.
 * 코드와 대문자 사유를 한 줄로 남겨 두어야 400 하나만 들고도 어디서 막혔는지 안다.
 * 남기는 것은 gRPC 코드·사유·사람의 `status` 뿐이다 — uid·personId·계정 주소·이름은 넣지 않는다.
 */
function reject(code: FunctionsErrorCode, reason: string, extra?: Record<string, unknown>): never {
  warn('organizer.create.rejected', { code, reason, ...extra });
  throw new HttpsError(code, reason);
}

/** 주최사 이름. 앞뒤 공백을 떼고 2–40 글자, 제어문자는 받지 않는다. */
function requireName(value: unknown): string {
  if (typeof value !== 'string') reject('invalid-argument', 'BAD_NAME');
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < MIN_NAME_CHARS || length > MAX_NAME_CHARS || CONTROL_CHARS.test(trimmed)) {
    reject('invalid-argument', 'BAD_NAME');
  }
  return trimmed;
}

/**
 * 로그인한 사람이 이름 하나로 **자기 주최사**를 만든다(MVP 창업자 판단).
 *
 * 어테스터가 그 사람을 **오너로 지정해** 대신 보낸다. `createOrganizer(address owner)` 는
 * 누구나 부를 수 있고 오너를 인자로 받으므로(contracts/src/Organizers.sol), 어테스터가 보내도
 * 주최사의 주인은 언제나 그 사람이다.
 *
 * **2026-09-23 01b 재배포로 전제 두 가지가 바뀌었다(abi-delta-01b.md §4·§10).**
 *  1. `Organizers` 는 바이트 단위로 그대로다(§4). `createOrganizer(address)` 의 시그니처가
 *     같으므로 이 어테스터 경로는 새 배포본에서도 그대로 동작한다.
 *  2. 새 페이마스터(`0xBDDB…28B2`)가 이 셀렉터를 **후원한다** — `0x49cd9846`, ArgKind 1
 *     (Platform), word 0. 배포된 페이마스터에서 `argKindOf`/`argWordOf` 를 되읽어 확인한 값이다(§10).
 *     즉 관객 키로 직접 보내는 길(클라이언트 전송)이 열렸다.
 *
 * 그래도 이 callable 은 **일부러 남겨 둔다.** 지우는 것은 클라이언트가 UserOperation 을
 * 보내도록 고치는 일과 함께 따로 판단할 변경이지, 이 파일의 부수 효과로 일어날 일이 아니다.
 * 지금은 동작을 바꾸지 않는다.
 *
 * 체인에는 **이름이 없다**. `orgProfiles/{orgId}` 한 줄이 화면에 그릴 이름의 원본이고,
 * 권한·소유권의 원본은 그대로 체인이다(스펙 §9.4).
 */
export const createOrganizerForMe = onCall(
  { secrets: [ATTESTER_PK], timeoutSeconds: 120 },
  async (request): Promise<{ orgId: string }> => {
    const uid = request.auth?.uid;
    if (!uid) reject('unauthenticated', 'AUTH_REQUIRED');

    // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
    const name = requireName((request.data ?? {}).name);

    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) reject('not-found', 'NO_SIGNUP');

    const person = await db.collection(PERSONS).doc(personId).get();
    if (!person.exists) reject('not-found', 'NO_SIGNUP');

    // `startKyc` 와 같은 관문. 계정이 체인에 등록된 사람만 주최사의 오너가 될 수 있다 —
    // 아직 `pending` 인 사람을 오너로 박으면 그 주최사는 영영 주인 없는 것이 된다.
    const status = person.get('status') as string;
    const ownerAccount = person.get('account') as Hex | undefined;
    if (status !== 'active') reject('failed-precondition', 'NOT_ACTIVE', { status });
    if (!ownerAccount) reject('failed-precondition', 'NOT_ACTIVE', { status, hasAccount: false });

    // 상한은 전송 **전에** 센다. 어테스터가 가스를 내는 트랜잭션이라, 통과한 뒤에 세면
    // 이미 태운 뒤다. `limit` 이 있어 문서를 무한정 읽지 않는다.
    const mine = await db
      .collection(ORG_PROFILES)
      .where('ownerPersonId', '==', personId)
      .limit(MAX_ORGS_PER_PERSON)
      .get();
    if (mine.size >= MAX_ORGS_PER_PERSON) reject('resource-exhausted', 'ORG_LIMIT');

    // 어테스터 EOA 는 하나뿐이라 리스를 잡고 한 번에 하나만 보낸다(`registerIdentity` 와 같은 규칙).
    const txHash = await sendSerialized(() =>
      sendAttesterTx({
        address: deployment().organizers,
        abi: organizersAbi,
        functionName: 'createOrganizer',
        args: [ownerAccount],
      }),
    );

    const receipt = await publicClient().waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    if (receipt.status !== 'success') throw new HttpsError('internal', 'CREATE_ORG_REVERTED');

    // `orgId` 는 컨트랙트가 정한다(`_nextOrgId++`). 반환값을 믿을 수 없으니 영수증의
    // `OrganizerCreated` 로그에서 읽는다 — ABI 는 shared 것을 그대로 쓴다.
    const [created] = parseEventLogs({
      abi: organizersAbi,
      eventName: 'OrganizerCreated',
      logs: receipt.logs,
    });
    const orgId = (created?.args as { orgId?: bigint } | undefined)?.orgId;
    if (orgId === undefined) throw new HttpsError('internal', 'NO_ORG_EVENT');

    // 스펙 §10.4 규칙 3: 체인과 DB 를 함께 건드리는 일은 finalized 뒤에 완료 처리한다.
    await awaitFinalized(receipt.blockNumber);

    const id = orgId.toString();
    await db.collection(ORG_PROFILES).doc(id).set({
      orgId: id,
      name,
      ownerPersonId: personId,
      ownerAccount,
      txHash,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { orgId: id };
  },
);
