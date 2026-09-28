import { getAddress } from 'viem';
import type { Hex } from '@monti/shared';
import { authAdmin } from './db.js';

/**
 * 가입을 마친 세션에 `personId`·`account` 를 심는다. 전화번호로 만든 uid 의 토큰은 아직
 * 이 둘을 모르는데 보안 규칙이 그 클레임을 읽으므로, 심어 주지 않으면 사람은 가입을 끝내고도
 * 자기 문서를 못 읽는다.
 *
 * **모양의 원본은 이 함수 하나뿐이다.** `loginVerify` 가 만드는 커스텀 토큰과 정확히 같아야
 * 하고(`{ personId, account }`, 주소는 체크섬, 개인정보 없음), 심는 곳이 둘로 갈라지면
 * (`registerIdentity` 의 성공 경로와 `reconcilePending` 의 복구 경로) 토큰 두 개가 갈라져
 * 규칙이 갈라진다. 다시 불러도 같은 값을 덮어쓸 뿐이라 재실행이 싸고 안전하다.
 */
export async function mintSessionClaims(uid: string, personId: Hex, account: Hex): Promise<void> {
  await authAdmin.setCustomUserClaims(uid, { personId, account: getAddress(account) as Hex });
}
