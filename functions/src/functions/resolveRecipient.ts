import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import { identityAbi, recipientCommitment, type Hex, type ResolveRecipientResult } from '@monti/shared';
import { PHONE_INDEX_KEY } from '../config.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { NICKNAMES, PERSONS, db } from '../lib/db.js';
import { parseNickname } from '../lib/nicknames.js';
import { hmacPhone, personIdByPhone } from '../lib/phoneIndex.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** `hmacPhone` 이 받는 모양 그대로. 먼저 걸러야 키 설정 오류가 BAD_PHONE 으로 둔갑하지 않는다. */
const PHONE_RE = /^\+[0-9]{7,15}$/;

/** 자기 자신에게 보내는 양도는 컨트랙트에 닿기 전에 끊는다. */
function denySelf(caller: Hex, recipient: Hex): void {
  if (recipient.toLowerCase() === caller.toLowerCase()) {
    throw new HttpsError('invalid-argument', 'SELF_TRANSFER');
  }
}

/**
 * 티켓을 받을 사람을 찾는다. 셋 중 하나로 찾는다 — 전화번호·닉네임·계정 주소.
 *
 * **응답에 전화번호도 이름도 색인 HMAC 도 담지 않는다.** 번호로 찾을 때 나가는 것은
 * 회원이면 계정 주소, 아니면 `recipientCommitment = keccak256(HMAC)` 하나다. 커밋먼트는
 * `Ticket.createOffer` 가 그대로 받는 값이고, 키 없이는 번호로 되돌릴 수 없다.
 *
 * **닉네임은 Firestore 장부에서 찾는다**(v2 P5). `nicknames/{정규형}` → `persons/{personId}.account`
 * — 계정이 회전해도 사람 문서가 현재 계정을 가리키므로 자동으로 따라간다. `nickname` 은
 * 닉네임 경로에서만, 주인이 정한 표시형으로 되돌려 준다.
 *
 * 회원이 아닌 주소는 막는다 — 번호는 초대장이라는 후속 경로가 있지만, 주소는 오타 하나로
 * 티켓이 영영 잠기는 길이라 그대로 거절한다.
 */
export const resolveRecipient = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<ResolveRecipientResult> => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { type, value } = (request.data ?? {}) as { type?: string; value?: string };
    if (!value || typeof value !== 'string') throw new HttpsError('invalid-argument', 'BAD_VALUE');
    if (type !== 'phone' && type !== 'nickname' && type !== 'address') {
      throw new HttpsError('invalid-argument', 'BAD_TYPE');
    }

    // 호출자는 언제나 세션 클레임에서 나온다. 요청 본문의 주소는 읽지 않는다.
    const caller = await resolveCallerAccount(request);
    const contracts = deployment();
    const pc = publicClient();

    if (type === 'phone') {
      if (!PHONE_RE.test(value)) throw new HttpsError('invalid-argument', 'BAD_PHONE');
      const key = PHONE_INDEX_KEY.value();
      const commitment = recipientCommitment(hmacPhone(value, key));

      const personId = await personIdByPhone(value, key);
      if (!personId) return { member: false, commitment };

      const account = (await db.collection(PERSONS).doc(personId).get()).get('account') as
        | string
        | undefined;
      // 사람 문서는 있는데 계정이 아직 없다(가입 진행 중). 초대장 경로로 보낸다.
      if (!account || !ADDRESS_RE.test(account)) return { member: false, commitment };

      const recipient = getAddress(account);
      denySelf(caller, recipient);
      return { member: true, account: recipient, commitment };
    }

    if (type === 'nickname') {
      if (!value.trim()) throw new HttpsError('invalid-argument', 'EMPTY_NICKNAME');
      // 모양이 틀린 이름은 누구의 것도 아니다 — 문서를 읽을 것도 없이 "없는 이름"이다.
      const parsed = parseNickname(value);
      if (!parsed) throw new HttpsError('not-found', 'NICKNAME_UNKNOWN');
      const nick = await db.collection(NICKNAMES).doc(parsed.key).get();
      const personId = nick.exists ? (nick.get('personId') as string | undefined) : undefined;
      if (!personId) throw new HttpsError('not-found', 'NICKNAME_UNKNOWN');
      // 계정은 사람 문서에서 읽는다 — 회전 뒤에도 언제나 현재 계정이다.
      const account = (await db.collection(PERSONS).doc(personId).get()).get('account') as string | undefined;
      if (!account || !ADDRESS_RE.test(account)) throw new HttpsError('not-found', 'NICKNAME_UNKNOWN');
      const recipient = getAddress(account);
      denySelf(caller, recipient);
      return { member: true, account: recipient, nickname: (nick.get('display') as string | undefined) ?? parsed.key };
    }

    if (!ADDRESS_RE.test(value)) throw new HttpsError('invalid-argument', 'BAD_ADDRESS');
    const recipient = getAddress(value);
    denySelf(caller, recipient);
    const member = (await pc.readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'isMember',
      args: [recipient],
    })) as boolean;
    if (!member) throw new HttpsError('failed-precondition', 'NOT_A_MEMBER');
    return { member: true, account: recipient };
  },
);
