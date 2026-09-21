import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  TRANSFER_INVITE_TTL_SECONDS,
  offerDigest,
  recipientCommitment,
  ticketAbi,
  type Hex,
  type Locale,
} from '@monti/shared';
import { ATTESTER_PK, PHONE_INDEX_KEY, RP_ID } from '../config.js';
import { getAttesterAccount } from '../lib/attester.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { TRANSFER_INVITES, USERS, db } from '../lib/db.js';
import { hmacPhone } from '../lib/phoneIndex.js';

/** uint256 十진수. `BigInt()` 에 들어가기 전에 모양부터 고정한다. */
const TOKEN_ID_RE = /^[0-9]{1,78}$/;
const PHONE_RE = /^\+[0-9]{7,15}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** 한 번에 서명해 주는 초대 수. 한 사람이 받을 티켓이 이보다 많을 일은 없다. */
const PENDING_LIMIT = 50;

/** `Ticket.offerOf` 의 반환 구조체. ABI 가 JSON import 라 리터럴 타입이 없어 여기서 붙인다. */
interface ChainOffer {
  from: Hex;
  recipientCommitment: Hex;
  expiresAt: bigint;
}

export interface TransferInviteResult {
  inviteId: string;
  commitment: Hex;
  expiresAt: number;
  smsText: string;
  smsUri: string;
}

export interface PendingOffer {
  tokenId: string;
  attesterSig: Hex;
  inviteId: string;
}

/**
 * 받는 사람이 읽는 문구. 크립토 낱말을 쓰지 않는다(`BANNED_ATTENDEE_WORDS`).
 * 링크에는 초대 id 말고 아무것도 없다 — 번호도 티켓 번호도 보내는 사람도 들어가지 않는다.
 */
function inviteText(locale: Locale, inviteId: string): string {
  const link = `https://${RP_ID.value()}/i/${inviteId}`;
  return locale === 'en'
    ? `[MONTI] A ticket is waiting for you. Open the link and tap Receive. ${link}`
    : `[MONTI] 티켓을 보냈습니다. 앱에서 받기를 눌러 주세요. ${link}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 아직 회원이 아닐 수도 있는 번호로 티켓을 넘길 초대를 만든다.
 *
 * **서버는 문자를 보내지 않는다.** 문구(`smsText`)와 `sms:` URI 만 만들어 주고, 보내는
 * 사람의 폰이 자기 문자 앱을 열어 직접 보낸다(문자 비용 0원, 문자 제공자 의존 0개).
 * **서버는 티켓도 움직이지 않는다.** 실제 `Ticket.createOffer` 는 소유자가 웹에서 보낸다.
 *
 * **전화번호는 저장하지 않는다.** 남는 것은 `startSignup` 이 쓰는 것과 같은 HMAC 색인
 * (`hmacPhone`)과 그 위의 `commitment = keccak256(hmacPhone)` 뿐이다. 평문 번호는 응답의
 * `smsUri` 안에만 있고(호출자가 방금 직접 입력한 값) 어디에도 기록되지 않는다.
 *
 * 검증 순서: ① 호출자가 `Ticket.ownerOf(tokenId)` 인가 ② 다른 사람 앞으로 열린 오퍼가
 * 이미 있지 않은가. 둘 다 eth_call 이다 — 우리 DB 에는 티켓 상태가 없다(스펙 §10.4 규칙 1).
 */
export const createTransferInvite = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<TransferInviteResult> => {
    const { tokenId, phoneE164 } = (request.data ?? {}) as { tokenId?: string; phoneE164?: string };
    if (typeof tokenId !== 'string' || !TOKEN_ID_RE.test(tokenId)) {
      throw new HttpsError('invalid-argument', 'BAD_TOKEN_ID');
    }
    if (typeof phoneE164 !== 'string' || !PHONE_RE.test(phoneE164)) {
      throw new HttpsError('invalid-argument', 'BAD_PHONE');
    }

    // 호출자는 언제나 세션 클레임에서 나온다. 요청 본문의 주소는 읽지 않는다.
    const caller = await resolveCallerAccount(request);
    const uid = request.auth?.uid as string;
    const phoneIndex = hmacPhone(phoneE164, PHONE_INDEX_KEY.value());
    const commitment = recipientCommitment(phoneIndex);

    // 자기 자신에게 보내는 양도는 컨트랙트에 닿기 전에 끊는다. 비교는 HMAC 끼리만 한다.
    const user = await db.collection(USERS).doc(uid).get();
    if (user.get('phoneHmac') === phoneIndex) {
      throw new HttpsError('invalid-argument', 'SELF_TRANSFER');
    }
    const locale: Locale = user.get('locale') === 'en' ? 'en' : 'ko';

    const contracts = deployment();
    const pc = publicClient();
    const owner = (await pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    })) as Hex;
    if (owner.toLowerCase() !== caller.toLowerCase()) {
      throw new HttpsError('permission-denied', 'NOT_TOKEN_OWNER');
    }

    const offer = (await pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'offerOf',
      args: [BigInt(tokenId)],
    })) as ChainOffer;
    // 같은 번호로 다시 보내는 것은 막지 않는다 — 문자를 한 번 더 보내는 길이다.
    // 막는 것은 **다른 사람 앞으로** 열려 있는 오퍼뿐이다. 그 사람이 먼저 받아 가면
    // 이 초대는 영영 쓸 수 없는 종이가 된다.
    const openForSomebodyElse =
      offer.from.toLowerCase() !== ZERO_ADDRESS &&
      offer.expiresAt >= BigInt(nowSeconds()) &&
      offer.recipientCommitment.toLowerCase() !== commitment.toLowerCase();
    if (openForSomebodyElse) throw new HttpsError('failed-precondition', 'OFFER_ALREADY_OPEN');

    const inviteId = randomUUID();
    const expiresAt = nowSeconds() + TRANSFER_INVITE_TTL_SECONDS;
    await db.collection(TRANSFER_INVITES).doc(inviteId).set({
      tokenId,
      fromAccount: caller,
      hmacPhone: phoneIndex,
      commitment,
      status: 'sent',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    const smsText = inviteText(locale, inviteId);
    return {
      inviteId,
      commitment,
      expiresAt,
      smsText,
      // 번호는 여기까지만 산다. 응답으로 나가고 끝이다.
      smsUri: `sms:${phoneE164}?body=${encodeURIComponent(smsText)}`,
    };
  },
);

/**
 * 가입을 마친 사람이 자기 앞으로 와 있는 초대를 받아 가는 길.
 * `Ticket.acceptOffer(tokenId, attesterSig)` 에 그대로 넣을 어테스터 서명을 만들어 준다.
 *
 * 묶는 방법은 `acceptInvite` 와 같다 — 초대장의 `hmacPhone` 과 호출자의
 * `users/{uid}.phoneHmac`(Task 20 `startSignup` 이 써 둔 값)이 같아야 한다. 번호를 인자로
 * 받지 않으므로 남의 번호를 써넣어 볼 자리가 없다.
 *
 * 서명은 **호출자 계정**으로 묶는다. 컨트랙트가 검증하는 다이제스트는
 * `keccak256(abi.encode(tokenId, commitment, msg.sender))` 라서(EIP-191 접두사 없음),
 * 이 서명은 다른 계정이 주워도 쓸 수 없다. 서명은 저장하지 않고 호출마다 다시 만든다.
 *
 * 체인이 진실이다 — `offerOf(tokenId)` 의 커밋먼트가 초대장의 것과 같고 아직 살아 있을 때만
 * 서명한다. 초대 상태(`accepted`)는 인덱서가 `OfferAccepted` 를 보고 바꾼다. 여기서는 쓰지 않는다.
 */
export const pendingOffers = onCall(
  { secrets: [ATTESTER_PK] },
  async (request): Promise<{ offers: PendingOffer[] }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const account = await resolveCallerAccount(request);

    const phoneHmac = (await db.collection(USERS).doc(uid).get()).get('phoneHmac') as
      | string
      | undefined;
    if (!phoneHmac) throw new HttpsError('failed-precondition', 'PHONE_INDEX_MISSING');

    const snapshot = await db
      .collection(TRANSFER_INVITES)
      .where('hmacPhone', '==', phoneHmac)
      .where('status', '==', 'sent')
      .limit(PENDING_LIMIT)
      .get();
    if (snapshot.empty) return { offers: [] };

    const attester = getAttesterAccount();
    const contracts = deployment();
    const pc = publicClient();
    const now = nowSeconds();
    const offers: PendingOffer[] = [];
    // 같은 티켓에 초대가 여러 장 와 있어도 받는 사람에게는 티켓 하나로 보인다.
    const seen = new Set<string>();

    for (const doc of snapshot.docs) {
      const tokenId = doc.get('tokenId') as string | undefined;
      const commitment = doc.get('commitment') as Hex | undefined;
      const expiresAt = doc.get('expiresAt') as number | undefined;
      if (!tokenId || !commitment || typeof expiresAt !== 'number') continue;
      if (expiresAt < now || seen.has(tokenId)) continue;

      const offer = (await pc.readContract({
        address: contracts.ticket,
        abi: ticketAbi,
        functionName: 'offerOf',
        args: [BigInt(tokenId)],
      })) as ChainOffer;
      // 오퍼가 없으면 커밋먼트가 0 이라 이 비교 하나에 "없음"까지 걸린다.
      if (offer.recipientCommitment.toLowerCase() !== commitment.toLowerCase()) continue;
      // 컨트랙트와 같은 경계: `block.timestamp > o.expiresAt` 이면 만료다.
      if (offer.expiresAt < BigInt(now)) continue;

      const digest = offerDigest({
        tokenId: BigInt(tokenId),
        recipientCommitment: commitment,
        recipientAccount: account,
      });
      // 접두사 없는 원본 다이제스트 서명. `signMessage` 를 쓰면 컨트랙트가 다른 주소를 얻는다.
      offers.push({ tokenId, attesterSig: await attester.sign({ hash: digest }), inviteId: doc.id });
      seen.add(tokenId);
    }

    return { offers };
  },
);
