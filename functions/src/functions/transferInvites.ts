import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { ReadContractReturnType } from 'viem';
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

/**
 * `abi/Ticket.json` 의 `eventMeta` 항목을 **그대로** 베낀 조각. `@monti/shared` 의 `ticketAbi` 는
 * `as Abi` 로 나가 리터럴 타입이 지워지고, 그 위의 `ReadContractReturnType` 은 `unknown` 이 된다 —
 * 그래서 반환 구조체 타입을 여기서 다시 깐다. 조각이 원본과 어긋나면
 * `transferInvites.test.ts` 의 드리프트 테스트가 먼저 깨진다.
 */
export const eventMetaAbi = [
  {
    type: 'function',
    name: 'eventMeta',
    inputs: [{ name: 'eventId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct Ticket.EventMeta',
        components: [
          { name: 'orgId', type: 'uint256', internalType: 'uint256' },
          { name: 'titleHash', type: 'bytes32', internalType: 'bytes32' },
          { name: 'descHash', type: 'bytes32', internalType: 'bytes32' },
          { name: 'imageCid', type: 'string', internalType: 'string' },
          { name: 'startsAt', type: 'uint64', internalType: 'uint64' },
          { name: 'endsAt', type: 'uint64', internalType: 'uint64' },
          { name: 'venueHash', type: 'bytes32', internalType: 'bytes32' },
          { name: 'saleStart', type: 'uint64', internalType: 'uint64' },
          { name: 'saleEnd', type: 'uint64', internalType: 'uint64' },
          { name: 'transferable', type: 'bool', internalType: 'bool' },
          { name: 'transferCutoffSeconds', type: 'uint32', internalType: 'uint32' },
          { name: 'maxTransfers', type: 'uint8', internalType: 'uint8' },
          { name: 'approvalRequired', type: 'bool', internalType: 'bool' },
          { name: 'category', type: 'uint8', internalType: 'uint8' },
          { name: 'regionCode', type: 'bytes32', internalType: 'bytes32' },
          { name: 'requireKyc', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

/** `Ticket.eventMeta` 의 반환 구조체. 손으로 적지 않는다 — 위 조각에서 컴파일러가 만든다. */
type ChainEventMeta = ReadContractReturnType<typeof eventMetaAbi, 'eventMeta'>;

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
 *
 * 본인인증이 필요한 공연이면 한 문장을 더 붙인다. 받는 사람은 링크를 누르기 전에 무엇이
 * 기다리는지 알아야 한다 — 가입을 마치고 나서야 알게 되면 거기서 멈춘다.
 * 링크는 언제나 맨 뒤다(문자 앱이 끝에 오는 URL 을 가장 잘 집어낸다).
 */
function inviteText(locale: Locale, inviteId: string, requireKyc: boolean): string {
  const link = `https://${RP_ID.value()}/i/${inviteId}`;
  if (locale === 'en') {
    const kyc = requireKyc ? " You'll need to verify your identity after signing up." : '';
    return `[MONTI] A ticket is waiting for you. Open the link and tap Receive.${kyc} ${link}`;
  }
  const kyc = requireKyc ? ' 가입 후 본인인증이 필요해요.' : '';
  return `[MONTI] 티켓을 보냈습니다. 앱에서 받기를 눌러 주세요.${kyc} ${link}`;
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

    // 본인인증이 필요한 공연인지는 **공연 메타**에만 있다. 티켓은 공연 id 만 알고 있으므로
    // 읽기가 두 번 더 든다(`eventOf` → `eventMeta`). 쓰기 전에 읽어 두어야 초대장만
    // 남고 문구는 틀린 상태가 생기지 않는다.
    const eventId = (await pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventOf',
      args: [BigInt(tokenId)],
    })) as bigint;
    const meta = (await pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventMeta',
      args: [eventId],
    })) as ChainEventMeta;

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

    const smsText = inviteText(locale, inviteId, meta.requireKyc);
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
 * 서명은 **호출자 계정**으로 묶는다. 컨트랙트가 검증하는 값은 `Ticket.offerDigest(...)` —
 * EIP-712 `TransferApproval(uint256 tokenId, bytes32 recipientCommitment, address recipient)` 이고,
 * 도메인이 `chainId` 와 **Ticket 주소**까지 함께 묶는다(EIP-191 접두사는 붙지 않는다).
 * 그래서 이 서명은 다른 계정도, 다른 체인도, 옛 배포본의 Ticket 도 쓸 수 없다.
 * 서명은 저장하지 않고 호출마다 다시 만든다.
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
        chainId: contracts.chainId,
        ticket: contracts.ticket,
        tokenId: BigInt(tokenId),
        recipientCommitment: commitment,
        recipientAccount: account,
      });
      // 접두사 없는 원본 다이제스트 서명. `signMessage` 를 쓰면 EIP-191 접두사가 붙어
      // 컨트랙트의 ECDSA.recover 가 다른 주소를 얻는다. 다이제스트 자체는 이제 EIP-712 라
      // 배포 기록의 `chainId` 와 Ticket 주소에 묶인다 — 옛 배포본(또는 다른 체인)에 대고
      // 만든 서명은 새 Ticket 에서 `BadAttesterSig` 로 죽는다.
      offers.push({ tokenId, attesterSig: await attester.sign({ hash: digest }), inviteId: doc.id });
      seen.add(tokenId);
    }

    return { offers };
  },
);
