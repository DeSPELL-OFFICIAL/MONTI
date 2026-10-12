import { getMessaging } from 'firebase-admin/messaging';
import { onRequest } from 'firebase-functions/v2/https';
import {
  EVENT_STATUS_BY_CODE,
  ticketAbi,
  type CheckInPush,
  type Hex,
  type PersonStatus,
} from '@monti/shared';
import { TENDERLY_WEBHOOK_SECRET } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import {
  DEVICES,
  EVENT_CHATS,
  INVITES,
  PENDING_GATES,
  PERSONS,
  TRANSFER_INVITES,
  assertStatusTransition,
  db,
} from '../lib/db.js';
import { decodeMontiLogs, verifyTenderlySignature, type TenderlyLog } from '../lib/tenderly.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** 구조화 로그 한 줄. 개인정보도 본문도 들어가지 않는다 — 이벤트 이름과 식별자뿐이다. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

/** 결정된 이벤트 목록. 같은 트랜잭션의 형제 로그를 보려면 이 모양이 필요하다. */
interface DecodedEvent {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 입장 완료 푸시. 소유자는 체인에서 읽는다(우리 DB 에는 티켓이 없다, 스펙 §10.4 규칙 1).
 * 기기 문서 id 는 `ownerOf` 가 돌려주는 체크섬 주소 그대로고, 읽는 필드는 `pushToken` 하나다.
 * 토큰이 없으면 조용히 끝낸다. FCM 이 거절하면(죽은 토큰) 기록만 남기고 넘어간다 —
 * 푸시 하나 때문에 같은 트랜잭션의 나머지 이벤트가 재배달되면 안 된다.
 *
 * `late` 는 오프라인 큐를 뒤늦게 흘려보낸 입장(`Ticket.checkInLate`)이다. FCM `data` 의 값은
 * **언제나 문자열**이라 `CheckInPush` 는 `late?: '1'` 로 못 박혀 있다 — 늦지 않은 입장은
 * `'0'` 이 아니라 **키가 아예 없는 것**이다. 클라이언트는 키의 유무로만 갈라야 한다.
 */
async function pushCheckedIn(tokenId: bigint, late = false): Promise<void> {
  const owner = await publicClient().readContract({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName: 'ownerOf',
    args: [tokenId],
  });
  const device = await db.collection(DEVICES).doc(owner as string).get();
  const token = device.get('pushToken') as string | undefined;
  if (!token) return;
  // 모양은 `CheckInPush` 로 고정한다 — 값은 언제나 문자열이고, "늦지 않음"은 `'0'` 이 아니라
  // **키가 없는 것**이다. FCM 의 `data` 는 인덱스 시그니처를 요구하므로 보낼 때만 그 맵으로 넓힌다.
  const data: CheckInPush = { tokenId: tokenId.toString(), ...(late ? { late: '1' as const } : {}) };
  try {
    await getMessaging().send({
      token,
      notification: { title: 'Checked in', body: 'Your ticket is now checked in.' },
      data: { ...data } as Record<string, string>,
    });
  } catch (error) {
    log({ tenderly: 'push_failed', tokenId: tokenId.toString(), error: (error as Error).message });
  }
}

/**
 * 웹훅 입력으로 사람 문서를 만들지 않는다. 이미 있는 문서의 진행 표시만 올린다.
 * 전이는 `diditWebhook` 과 같은 표를 지난다 — 막힌 전이는 던지고, 바깥 루프가 기록만 남긴다.
 */
async function markRegistered(personId: Hex): Promise<void> {
  const ref = db.collection(PERSONS).doc(personId);
  const person = await ref.get();
  if (!person.exists) return;
  const current = person.get('status') as PersonStatus | undefined;
  if (current === 'active') return;
  assertStatusTransition(current ?? 'pending', 'active');
  await ref.set({ status: 'active' }, { merge: true });
}

/**
 * 티켓을 넘긴 사람이 그 공연 티켓을 하나도 안 가졌으면 채팅방에서 내보낸다.
 * 민팅(`from` 이 0주소)은 볼 것이 없고, 소각(`to` 가 0주소)은 보낸 사람을 그대로 검사한다.
 * 남은 수량은 언제나 eth_call 이다 — 인덱서는 인가에 쓰지 않는다.
 */
async function dropChatMemberIfTicketless(from: Hex, tokenId: bigint): Promise<void> {
  if (from.toLowerCase() === ZERO_ADDRESS) return;
  const contracts = deployment();
  const eventId = await publicClient().readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOf',
    args: [tokenId],
  });
  const remaining = await publicClient().readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'balanceOfEvent',
    args: [from, eventId as bigint],
  });
  if ((remaining as bigint) > 0n) return;
  const members = await db
    .collection(`${EVENT_CHATS}/${String(eventId)}/members`)
    .where('account', '==', from)
    .get();
  await Promise.all(members.docs.map((doc) => doc.ref.delete()));
}

/**
 * 역할이 체인에 올라간 순간 **그 역할의** 초대장을 닫는다. `acceptInvite` 가 `accepted` 로
 * 두고 간 것만 `done` 이 된다 — 다시 배달돼도 고를 문서가 없어 멱등이다.
 *
 * `role` 까지 맞춰야 한다. 한 사람이 같은 조직에 admin·manager 두 장을 받아 두면 세 필드
 * (`orgId`·`acceptedBy`·`status`)가 똑같아서, 먼저 오는 이벤트가 **둘 다** 닫아 버린다.
 * `done` 이 된 초대장은 `acceptInvite` 가 `INVITE_NOT_OPEN` 으로 막으므로, 아직 체인에
 * 올리지 않은 역할의 calldata 를 다시 받을 길이 영영 사라진다(`invites.ts`).
 *
 * 체인 인자는 체크섬 주소고 저장된 값은 그렇지 않을 수 있으므로 대소문자를 가리지 않고 맞춘다.
 */
async function markOrganizerInviteDone(orgId: bigint, account: Hex, role: 'admin' | 'manager'): Promise<void> {
  const invites = await db.collection(INVITES).where('orgId', '==', String(orgId)).get();
  const wanted = account.toLowerCase();
  const mine = invites.docs.filter(
    (doc) =>
      doc.get('status') === 'accepted' &&
      doc.get('role') === role &&
      String(doc.get('acceptedBy') ?? '').toLowerCase() === wanted,
  );
  await Promise.all(mine.map((doc) => doc.ref.update({ status: 'done' })));
}

/**
 * 공연 상태가 바뀌면 채팅 문서를 연다·닫는다. 필드 이름은 Task 26 `joinEventChat` 이
 * 읽는 것과 같아야 한다(`closed` / `endsAt` / `orgId`).
 * `createEvent` 도 `EventStatusChanged(0=Draft)` 를 낸다 — 그때는 방을 만들지 않는다.
 * 모르는 코드는 기록만 남기고 넘어간다(절대 던지지 않는다).
 */
async function applyEventStatus(eventIdArg: bigint, statusCode: number): Promise<void> {
  const eventId = String(eventIdArg);
  const status = EVENT_STATUS_BY_CODE[statusCode];
  if (status === undefined) {
    log({ tenderly: 'unknown_event_status', eventId, statusCode });
    return;
  }
  if (status === 'Published') {
    const meta = await publicClient().readContract({
      address: deployment().ticket,
      abi: ticketAbi,
      functionName: 'eventMeta',
      args: [eventIdArg],
    });
    await db.collection(EVENT_CHATS).doc(eventId).set(
      {
        closed: false,
        endsAt: Number((meta as { endsAt: bigint }).endsAt),
        orgId: String((meta as { orgId: bigint }).orgId),
      },
      { merge: true },
    );
    return;
  }
  if (status === 'Cancelled' || status === 'Ended') {
    await db.collection(EVENT_CHATS).doc(eventId).set({ closed: true }, { merge: true });
  }
  // Draft 는 아무것도 하지 않는다.
}

/**
 * 게이트가 체인에 올라간 순간 대기열은 끝난다(`submitPendingGate` 가 올린 제안).
 * 문서 id 는 그 함수가 적은 **소문자** 주소고 이벤트 인자는 체크섬이라, 맞춰서 내린다.
 *
 * 아무도 큐에 올린 적 없는 게이트(관리자가 화면을 거치지 않고 바로 등록했다)는 기록만 남기고
 * 넘어간다 — 웹훅 입력으로 문서를 새로 만들지 않는다. 같은 알림이 다시 배달돼도 같은 값을 덮어쓴다.
 */
async function closePendingGate(gateAccount: Hex, gateId: bigint, eventId: bigint): Promise<void> {
  log({ cacheInvalidate: 'GateRegistered', args: String(eventId) });
  const ref = db.collection(PENDING_GATES).doc(gateAccount.toLowerCase());
  const pending = await ref.get();
  if (!pending.exists) {
    log({ tenderly: 'pending_gate_absent', gateId: String(gateId) });
    return;
  }
  await ref.set({ status: 'registered', gateId: String(gateId) }, { merge: true });
}

/**
 * 늦은 입장(`Ticket.checkInLate`)은 체인이 `CheckedInLate` 를 낸 **바로 다음 줄에서**
 * 같은 트랜잭션의 `CheckedIn` 도 낸다(`contracts/src/Ticket.sol:468-469`, abi-delta-01b.md §2).
 * 스위치가 둘을 따로 처리하면 한 번의 입장에 푸시가 **두 개** 나간다.
 *
 * 그래서 `CheckedIn` 은 처리하기 전에 **같은 트랜잭션 안에 같은 tokenId 의 `CheckedInLate` 가
 * 있는지**부터 본다. 있으면 그쪽이 `late: '1'` 을 달고 보내 주므로 여기서는 아무것도 하지 않는다.
 * 타이머도 Firestore 읽기도 쓰지 않는다 — 웹훅이 이미 그 트랜잭션의 로그 전부를 `events` 로
 * 디코드해 두었고, 판단에 필요한 것은 그 배열 하나뿐이다. 로그 순서에도 기대지 않는다.
 *
 * 입장 **집계**는 여전히 `CheckedIn` 하나만 센다(§2). 여기서 거르는 것은 푸시뿐이다.
 */
function hasLateSibling(events: readonly DecodedEvent[], tokenId: unknown): boolean {
  return events.some(
    (other) => other.name === 'CheckedInLate' && String(other.args.tokenId) === String(tokenId),
  );
}

async function applyEvent(event: DecodedEvent, events: readonly DecodedEvent[]): Promise<void> {
  switch (event.name) {
    case 'CheckedIn':
      // 늦은 입장이면 같은 트랜잭션의 `CheckedInLate` 가 `late: '1'` 로 보낸다. 두 번 보내지 않는다.
      if (hasLateSibling(events, event.args.tokenId)) break;
      await pushCheckedIn(event.args.tokenId as bigint);
      break;
    case 'CheckedInLate':
      await pushCheckedIn(event.args.tokenId as bigint, true);
      break;
    case 'Registered':
      await markRegistered(event.args.personId as Hex);
      break;
    case 'Transfer':
      await dropChatMemberIfTicketless(event.args.from as Hex, event.args.tokenId as bigint);
      break;
    case 'OfferAccepted': {
      // OfferAccepted(tokenId, from, to) 에는 커밋먼트가 없다. tokenId 로 초대를 찾는다.
      // 한 컬럼만 걸러 새 복합 색인을 만들지 않는다 — 나머지는 메모리에서 본다(한 티켓의 초대는 몇 장뿐).
      // Task 25 의 수락 경로가 이미 바꿔 놨을 수 있으므로 `sent` 인 것만 고른다(멱등).
      const invites = await db
        .collection(TRANSFER_INVITES)
        .where('tokenId', '==', String(event.args.tokenId as bigint))
        .get();
      const open = invites.docs.filter((doc) => doc.get('status') === 'sent');
      await Promise.all(open.map((doc) => doc.ref.update({ status: 'accepted' })));
      break;
    }
    case 'EventStatusChanged':
      await applyEventStatus(event.args.eventId as bigint, Number(event.args.status));
      break;
    case 'AdminSet':
    case 'ManagerSet': {
      // 권한 판정은 항상 eth_call 이다. 여기서는 클라이언트 캐시 무효화 신호만 남기고,
      // 그 역할을 올려 준 초대장을 닫는다.
      const orgId = event.args.orgId as bigint;
      log({ cacheInvalidate: event.name, args: String(orgId ?? '') });
      const isAdmin = event.name === 'AdminSet';
      // 같은 이벤트가 **권한을 거둘 때도** 나온다(`setManager(..., false, false)` /
      // `setAdmin(..., 0)`). 그때 초대장을 닫으면 아직 실행되지 않은 calldata 를 잃는다.
      const removal = isAdmin ? Number(event.args.bits) === 0 : event.args.exists === false;
      if (removal) break;
      const account = (isAdmin ? event.args.admin : event.args.manager) as Hex | undefined;
      if (account) await markOrganizerInviteDone(orgId, account, isAdmin ? 'admin' : 'manager');
      break;
    }
    case 'GateRegistered':
      await closePendingGate(
        event.args.gateAccount as Hex,
        event.args.gateId as bigint,
        event.args.eventId as bigint,
      );
      break;
    default:
      break;
  }
}

/**
 * Tenderly 알림을 받아 MONTI 쪽 부수효과로 옮긴다.
 *
 *  1. POST 가 아니면 405. 그다음 `X-Tenderly-Signature` 를 `req.rawBody` 바이트 + `Date`
 *     헤더에 대해 상수 시간으로 맞춰 본다.
 *  2. Tenderly 가 붙인 이벤트 이름은 믿지 않는다. **우리 세 컨트랙트 주소에서 나온** 로그만
 *     골라 **우리 ABI 로 직접** 디코드하고, 어느 ABI 에도 맞지 않으면 조용히 버린다.
 *  3. 이벤트 하나가 터져도 나머지는 계속 돈다. 응답은 언제나 200 이다 —
 *     2xx 가 아니면 Tenderly 가 같은 페이로드를 통째로 재배달해 **이미 끝난 이벤트까지 다시 돈다.**
 *
 * 체인 상태를 DB 에 복제하지 않는다. 여기서 쓰는 것은 푸시·진행 표시·채팅 문서·초대 상태뿐이고,
 * 티켓·권한·입장 기록의 원본은 언제나 체인이다(스펙 §10.4 규칙 1).
 */
export const tenderlyWebhook = onRequest(
  { secrets: [TENDERLY_WEBHOOK_SECRET], cors: false, invoker: 'public' },
  async (req, res) => {
    // 웹훅은 POST 하나뿐이다. 본문 없는 메서드로 빈 문자열에 서명을 맞춰 보는 길 자체를 막는다.
    if (req.method !== 'POST') {
      res.status(405).send('method not allowed');
      return;
    }

    const raw = req.rawBody?.toString('utf8') ?? '';
    const ok = verifyTenderlySignature({
      raw,
      signature: String(req.get('X-Tenderly-Signature') ?? ''),
      date: String(req.get('Date') ?? ''),
      secret: TENDERLY_WEBHOOK_SECRET.value(),
    });
    if (!ok) {
      res.status(401).send('bad signature');
      return;
    }

    let body: { transaction?: { logs?: TenderlyLog[] } };
    try {
      body = JSON.parse(raw) as { transaction?: { logs?: TenderlyLog[] } };
    } catch {
      res.status(400).send('bad json');
      return;
    }

    // 알림 페이로드에는 그 트랜잭션의 로그가 전부 실려 온다. 우리 세 컨트랙트에서 나온 것만 본다.
    const contracts = deployment();
    const events = decodeMontiLogs(body.transaction?.logs ?? [], [
      contracts.ticket,
      contracts.identity,
      contracts.organizers,
    ]);
    for (const event of events) {
      try {
        await applyEvent(event, events);
      } catch (error) {
        // 한 이벤트의 실패가 같은 트랜잭션의 나머지를 막지 않는다.
        log({ tenderly: 'side_effect_failed', event: event.name, error: (error as Error).message });
      }
    }

    res.status(200).send(`ok:${events.length}`);
  },
);
