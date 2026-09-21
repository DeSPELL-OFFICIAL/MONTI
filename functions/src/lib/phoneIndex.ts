import { createHmac } from 'node:crypto';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import type { Hex } from '@monti/shared';
import { PHONE_INDEX, db } from './db.js';

/**
 * 평문 번호를 Firestore 문서 id로 만들지 않는다. 키 없이는 역산이 불가능하다.
 * 같은 번호는 언제나 같은 id로 떨어지므로 "이미 가입한 번호"를 번호를 저장하지 않고도 안다.
 */
export function hmacPhone(phoneE164: string, key: string): string {
  if (!/^\+[0-9]{7,15}$/.test(phoneE164)) throw new Error('BAD_PHONE');
  if (!key) throw new Error('MISSING_PHONE_INDEX_KEY');
  return createHmac('sha256', key).update(phoneE164, 'utf8').digest('hex');
}

/** 색인 문서 자리. 트랜잭션 안에서 먼저 읽어야 하는 쪽이 이걸 쓴다. */
export function phoneIndexRef(phoneE164: string, key: string): DocumentReference {
  return db.collection(PHONE_INDEX).doc(hmacPhone(phoneE164, key));
}

/**
 * 한 번호에 한 personId. `tx` 를 주면 호출자의 트랜잭션 안에서 함께 커밋된다
 * — 사람·사용자 문서와 색인이 따로 남는 반쪽 가입을 막는다.
 */
export async function upsertPhoneIndex(
  phoneE164: string,
  personId: Hex,
  key: string,
  tx?: Transaction,
): Promise<string> {
  const ref = phoneIndexRef(phoneE164, key);
  if (tx) tx.set(ref, { personId }, { merge: true });
  else await ref.set({ personId }, { merge: true });
  return ref.id;
}
