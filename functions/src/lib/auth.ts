import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import type { Hex } from '@monti/shared';
import { PERSONS, USERS, db } from './db.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 호출자의 스마트 계정 주소.
 * 1순위: `loginVerify`가 커스텀 토큰에 넣어 준 `account` 클레임.
 * 2순위: users/{uid} → persons/{personId}.account.
 * 어느 경로로 왔든 EIP-55 체크섬 형태로 통일해서 돌려준다.
 */
export async function resolveCallerAccount(request: CallableRequest): Promise<Hex> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  const claim = request.auth?.token?.account;
  if (typeof claim === 'string' && ADDRESS_RE.test(claim)) return getAddress(claim);

  const user = await db.collection(USERS).doc(uid).get();
  const personId = user.get('personId') as string | undefined;
  if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

  const person = await db.collection(PERSONS).doc(personId).get();
  const account = person.get('account') as string | undefined;
  if (!account || !ADDRESS_RE.test(account)) throw new HttpsError('failed-precondition', 'NO_ACCOUNT');
  return getAddress(account);
}

export const PERM_MANAGE_GATES = 2;
export const PERM_APPROVE_OVERRIDE = 4;
