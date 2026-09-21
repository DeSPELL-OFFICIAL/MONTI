import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex } from '@monti/shared';
import { PHONE_INDEX_KEY } from '../config.js';
import { PERSONS, USERS, db } from '../lib/db.js';
import { encryptField, piiAad } from '../lib/kms.js';
import { phoneIndexRef, upsertPhoneIndex } from '../lib/phoneIndex.js';

/**
 * 가입은 전화번호 인증 하나로 끝난다. 본인인증(KYC)은 공연별로 필요할 때 `startKyc` 가 올린다.
 * 그래서 사람 문서는 언제나 `kycLevel: 0`, `status: 'pending'` 으로 태어나고 Didit 은 부르지 않는다.
 *
 * 개인정보: 번호 평문은 **어디에도 저장하지 않는다.** 두 가지 파생물만 남는다.
 *  - `phoneIndex/{hmacPhone}` — 키 없이는 못 되돌리는 HMAC 색인. 한 번호당 한 계정을 강제한다.
 *  - `users/{uid}.phoneEnc` — `personId:phoneE164` 로 묶인 KMS 봉투. 다른 문서로 옮겨 붙이면 안 열린다.
 *  - `users/{uid}.phoneHmac` — 위 색인 문서 id 와 같은 값. 번호를 풀지 않고도 색인을 찾아갈 수 있다.
 */
export const startSignup = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<{ personId: Hex }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const phoneE164 = request.auth?.token?.phone_number as string | undefined;
    if (!phoneE164) throw new HttpsError('failed-precondition', 'PHONE_REQUIRED');

    const userRef = db.collection(USERS).doc(uid);
    const existingPersonId = (await userRef.get()).get('personId') as Hex | undefined;
    if (existingPersonId) return { personId: existingPersonId }; // 재시도·재설치는 아무것도 다시 쓰지 않는다

    const key = PHONE_INDEX_KEY.value();
    const indexRef = phoneIndexRef(phoneE164, key);

    // personId 는 아무 의미 없는 난수 32바이트다. 전화번호나 이름의 해시가 아니다.
    const newPersonId = `0x${randomBytes(32).toString('hex')}` as Hex;
    // KMS 왕복은 트랜잭션 **밖에서** 끝낸다. 트랜잭션 본문에 Firestore 아닌 네트워크 호출이 있으면
    // 경합으로 재시도될 때마다 KMS 를 다시 부르고 그만큼 트랜잭션을 오래 열어 둔다.
    // 여기서 만든 봉투는 아래 트랜잭션이 이 id 를 실제로 쓸 때만 저장된다 — 경합해서 졌으면 그냥 버린다.
    const phoneEnc = await encryptField(phoneE164, piiAad(newPersonId, 'phoneE164'));

    // 사람·사용자·색인은 한 트랜잭션에서 같이 태어난다. 셋 중 하나만 남는 상태는 없다.
    const personId = await db.runTransaction(async (tx) => {
      const user = await tx.get(userRef);
      const raced = user.get('personId') as Hex | undefined;
      if (raced) return raced;

      const index = await tx.get(indexRef);
      // 레벨 0 계정의 유일한 중복 방지: 한 번호에 한 계정. 번호만으로 남의 계정을 이어받지 못한다.
      if (index.get('personId')) throw new HttpsError('already-exists', 'PHONE_ALREADY_REGISTERED');

      tx.set(db.collection(PERSONS).doc(newPersonId), {
        status: 'pending',
        kycLevel: 0, // 본인인증은 공연별로 필요할 때 startKyc 가 올린다
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(userRef, {
        personId: newPersonId,
        phoneEnc,
        // `phoneIndex/{hmac}` 문서 id 와 같은 값. 번호가 필요한 함수는 봉투를 풀지 않고 이 색인으로 간다.
        phoneHmac: indexRef.id,
        locale: 'ko',
        chatOrder: [],
        createdAt: FieldValue.serverTimestamp(),
      });
      await upsertPhoneIndex(phoneE164, newPersonId, key, tx);
      return newPersonId;
    });

    return { personId };
  },
);
