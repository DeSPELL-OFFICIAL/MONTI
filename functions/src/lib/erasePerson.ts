import { FieldValue } from 'firebase-admin/firestore';
import { error } from 'firebase-functions/logger';
import type { Hex, PersonStatus } from '@monti/shared';
import {
  DEVICES,
  NICKNAMES,
  PASSKEYS,
  PERSONS,
  PHONE_INDEX,
  USERS,
  assertStatusTransition,
  authAdmin,
  db,
} from './db.js';
import { deleteDiditSession } from './didit.js';

/**
 * 사람 한 명분의 개인정보 파기. **이 파일이 파기의 유일한 정의다** — 매일 도는
 * `processDeletions`(유예 7일 뒤)와 운영자가 손으로 돌리는 `scripts/reset-persons.ts`(즉시)가
 * 같은 함수를 부른다. 두 경로가 각자 지우면 한쪽만 고쳐진 채 남는 컬렉션이 생긴다.
 *
 * **체인은 지우지 않는다.** `Identity` 항목과 발급된 티켓은 그대로 남는다 — `personId` 는
 * 아무 의미 없는 난수이고 계정 주소·기기 키에는 개인정보가 없다(스펙 §10.2).
 */

/** Didit 파기 시도 횟수(같은 실행 안에서). 그래도 안 되면 던진다 — 부르는 쪽이 판단한다. */
const DIDIT_ATTEMPTS = 2;

/**
 * Didit 파기 실패에만 붙이는 표시. 연속 실패 카운터는 이것만 센다 — Auth 나 Firestore 가
 * 흔들린 날까지 같이 세면 "Didit 이 막혔다" 는 신호가 잡음에 묻힌다.
 *
 * `cause` 를 **받아서 넘긴다**. 메시지만 베껴 오면 스택이 여기서 끊겨, 막힌 것이 HTTP 인지
 * JSON 인지 키인지 로그만 보고는 끝내 알 수 없다.
 */
export class DiditErasureFailed extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** 한 사람을 지우고 남긴 영수증. 운영 스크립트가 사람에게 보여 주는 줄이 이 셋이다. */
export interface ErasureResult {
  /** Didit 에 파기를 보낸 세션 수(404 = 이미 없음도 성공으로 센다). */
  diditSessions: number;
  /** 실제로 지운 Firestore 문서 수. 사람 문서는 남기고 털기만 하므로 여기 들어가지 않는다. */
  firestoreDocs: number;
  /** Auth 사용자를 이번 실행이 지웠는가. 이미 없었으면 `false` 다. */
  authDeleted: boolean;
}

/**
 * Auth 사용자 삭제. **이미 없으면 성공이다.**
 *
 * `deleteUser` 는 없는 uid 에 `auth/user-not-found` 를 던진다. 이 줄 뒤에서 한 번이라도
 * 실패하면(또는 누가 콘솔에서 먼저 지웠으면) 요청은 `pending` 으로 남고, 다음 날 실행은
 * 같은 자리에서 또 던진다 — 그 요청은 영원히 `done` 이 되지 못한다. 파기의 모든 단계는
 * 멱등이어야 하고, 여기가 유일하게 그렇지 않았다.
 */
async function eraseAuthUser(uid: string): Promise<boolean> {
  try {
    await authAdmin.deleteUser(uid);
    return true;
  } catch (cause) {
    if ((cause as { code?: string }).code !== 'auth/user-not-found') throw cause;
    return false;
  }
}

/**
 * Didit 세션 파기. 실패하면 **던진다** — 부르는 쪽이 우리 DB 를 지우기 전에 멈춰야 한다.
 * 여기서 삼키면 Didit 에 얼굴 템플릿이 남은 채로 "파기 완료" 도장이 찍히고, 그때는
 * `sessionId` 를 들고 있던 사람 문서가 이미 없어 다시 시도할 방법도 사라진다.
 */
async function eraseDiditSession(sessionId: string, apiKey: string): Promise<void> {
  for (let attempt = 1; attempt <= DIDIT_ATTEMPTS; attempt += 1) {
    try {
      await deleteDiditSession(sessionId, apiKey);
      return;
    } catch (cause) {
      // 메시지는 그대로 두고(운영이 `deletion.failed` 에서 보던 줄이다) 원인만 실어 보낸다.
      if (attempt === DIDIT_ATTEMPTS) throw new DiditErasureFailed((cause as Error).message, { cause });
      error('deletion.didit.retry', { attempt, reason: (cause as Error).message });
    }
  }
}

/**
 * 한 사람의 개인정보를 실제로 지운다. 순서에 뜻이 있다.
 *
 *  1. **Didit 이 먼저다.** 우리 문서를 먼저 지우면 `kyc.sessionId` 가 사라져 남의 서버에 남은
 *     얼굴 자료를 영영 못 지운다. 여기서 실패하면 아무것도 지우지 않은 채로 던지고, 부르는 쪽은
 *     다시 시도할 수 있다.
 *  2. 전화 색인 → 사용자 → 자격증명 → 기기. 색인을 먼저 지워야 같은 번호로 새로 가입할 수 있다.
 *  3. 사람 문서는 **남기고** 개인정보 필드만 턴다. 체인이 이 personId 를 가리키고 있다.
 *  4. Auth 사용자 삭제.
 *
 * 모든 단계가 멱등이다 — 이미 지워진 사람에게 다시 돌려도 아무 일도 일어나지 않고 0 을 센다.
 *
 * `uid` 는 **없을 수 있다**. `users/{uid}` 가 먼저 지워진 반쪽 상태에서는 사람 문서만 남고,
 * 그때도 남은 것(자격증명·기기·사람 문서)은 지워져야 한다.
 *
 * `afterDidit` 는 Didit 을 전부 넘긴 **직후**, 우리 문서를 건드리기 전에 한 번 불린다.
 * 스케줄 작업은 여기서 연속 실패 카운터를 턴다 — 그 자리가 아니면 Firestore 가 흔들린 날의
 * 실패가 다음 장애의 횟수에 더해져 경보가 하루 일찍 운다.
 */
export async function erasePerson(input: {
  uid?: string;
  personId: Hex;
  diditApiKey: string;
  afterDidit?: () => Promise<void>;
}): Promise<ErasureResult> {
  const { uid, personId, diditApiKey } = input;

  const personRef = db.collection(PERSONS).doc(personId);
  const person = await personRef.get();
  const account = person.get('account') as Hex | undefined;

  // **연 적 있는 세션을 전부** 지운다. 열린 세션 하나만 지우면, 복귀 주소가 달라 새로 연
  // 세션에 밀려난 옛 세션의 얼굴 템플릿이 Didit 서버에 영원히 남는다(`kycSession.ts`).
  const sessions = new Set<string>((person.get('kycSessionIds') as string[] | undefined) ?? []);
  const current = person.get('kyc.sessionId') as string | undefined;
  if (current) sessions.add(current);
  for (const sessionId of sessions) await eraseDiditSession(sessionId, diditApiKey);
  await input.afterDidit?.();

  let firestoreDocs = 0;

  if (uid !== undefined) {
    const user = await db.collection(USERS).doc(uid).get();
    const phoneHmac = user.get('phoneHmac') as string | undefined;
    if (phoneHmac) {
      // `delete()` 는 없는 문서에도 성공한다. 영수증에 적을 숫자가 진짜이려면 읽고 세야 한다.
      const index = db.collection(PHONE_INDEX).doc(phoneHmac);
      if ((await index.get()).exists) {
        await index.delete();
        firestoreDocs += 1;
      }
    }
    if (user.exists) {
      await user.ref.delete();
      firestoreDocs += 1;
    }
  }

  // 닉네임 장부(v2 P5)는 personId 로 묶여 있다. 놓아줘야 그 이름을 다른 사람이 쓸 수 있고,
  // 이름→사람 조회(resolveRecipient)가 파기된 사람에게 닿지 않는다. users.nickname 사본은
  // 위에서 users 문서와 함께 사라졌다.
  const nicknames = await db.collection(NICKNAMES).where('personId', '==', personId).get();
  for (const nickname of nicknames.docs) {
    await nickname.ref.delete();
    firestoreDocs += 1;
  }

  const passkeys = await db.collection(PASSKEYS).where('personId', '==', personId).get();
  for (const passkey of passkeys.docs) {
    await passkey.ref.delete();
    firestoreDocs += 1;
  }

  if (account) {
    const device = db.collection(DEVICES).doc(account);
    if ((await device.get()).exists) {
      await device.delete();
      firestoreDocs += 1;
    }
  }

  if (person.exists) {
    // 얼굴 사진은 `persons.photoEnc` 안의 KMS 봉투 하나뿐이라 이 문서를 털면 같이 사라진다.
    // `functions/src` 에서 Cloud Storage 에 쓰는 곳은 `dailyExport.ts`(`EXPORT_BUCKET`) 하나뿐이고
    // `persons/{personId}/` 에는 아무도 쓰지 않으므로, 지금은 지울 스토리지 객체가 없다.
    // C4: storage sweep when photos land in Storage
    //
    // 지금은 어떤 상태에서도 `deleted` 로 갈 수 있으므로 이 줄은 던지지 않는다.
    // 그래도 남겨 둔다 — 전이표가 언젠가 좁아지면 조용히 어긋나는 대신 여기서 크게 깨진다.
    assertStatusTransition((person.get('status') as PersonStatus | undefined) ?? 'pending', 'deleted');
    await personRef.set(
      {
        status: 'deleted',
        // 개인정보 봉투는 전부 없앤다. 남는 것은 personId·계정 주소·체인 기록뿐이고,
        // 그 셋은 체인에도 같은 값이 있어 여기서 지운다고 사라지지 않는다.
        enc: FieldValue.delete(),
        photoEnc: FieldValue.delete(),
        kyc: FieldValue.delete(),
        kycSessionIds: FieldValue.delete(),
        deletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const authDeleted = uid === undefined ? false : await eraseAuthUser(uid);

  return { diditSessions: sessions.size, firestoreDocs, authDeleted };
}
