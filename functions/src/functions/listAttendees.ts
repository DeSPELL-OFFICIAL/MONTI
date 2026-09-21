import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { envioQuery } from '../lib/envio.js';

const DIGITS_RE = /^[0-9]+$/;

/** Hasura 는 역할마다 행 수 상한이 있다. 한 쪽씩 커서로 끝까지 읽어야 목록이 잘리지 않는다. */
export const ATTENDEE_PAGE_SIZE = 500;

/**
 * 주최자 화면의 참석자 한 줄.
 *
 * **닉네임 말고는 사람을 가리키는 것이 하나도 없다.** 전화번호·실명·사진은 물론
 * 지갑 주소조차 싣지 않는다 — 얼굴 사진은 게이트 스냅샷(`issueSnapshot`)에서만,
 * 그것도 스태프 인가를 통과한 뒤에만 평문이 된다.
 */
export interface AttendeeRow {
  tokenId: string;
  nickname: string;
  checkedIn: boolean;
  tier: number;
  kycLevel: number;
}

interface EnvioAttendeeRow {
  id: string;
  tier: number;
  checkIn: { id: string } | null;
  identity: { nickname: string | null; kycLevel: number } | null;
}

/**
 * 10진수 문자열 하나로 정규화한다. `"011"` 과 `"11"` 은 체인에서는 같은 공연인데
 * 문자열로는 다르다 — 인가에 쓴 값과 질의에 실은 값이 어긋나면 안 된다.
 */
function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  }
  return BigInt(value).toString();
}

/**
 * 참석자 목록을 볼 수 있는 사람인지 **체인에서** 판정한다. 우리 DB 에는 역할이 없다(스펙 §9.4).
 *
 * 공연 주최 조직의 **오너**이거나, 그 조직의 **매니저**이거나,
 * `PERM_CREATE_EVENT` 비트를 가진 **관리자**면 통과다. 인덱서는 이 판정에 쓰지 않는다 —
 * 인덱싱이 밀리는 동안 권한이 뒤처지면 그대로 인가 구멍이 된다.
 */
async function requireOrganizer(eventId: bigint, caller: Hex): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;

  const [owner, manager, canCreateEvent] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [orgId],
    }) as Promise<Hex>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'managerOf',
      args: [orgId, caller],
    }) as Promise<readonly [boolean, boolean]>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, caller, PERM_CREATE_EVENT],
    }) as Promise<boolean>,
  ]);

  const isOwner = owner.toLowerCase() === caller.toLowerCase();
  if (!isOwner && !manager[0] && !canCreateEvent) {
    throw new HttpsError('permission-denied', 'NOT_ORGANIZER');
  }
}

/**
 * 한 쪽.
 *
 * `eventId` 는 schema.graphql 의 `BigInt!` → Hasura `numeric`. `String!` 로 선언하면 거절된다.
 * 값은 문자열로 보낸다(자바스크립트 number 는 2^53 에서 깨진다).
 * `eventId`·`revoked` 는 서버 쪽 필터일 뿐이라 골라 받지 않는다.
 */
async function attendeePage(eventId: string, cursor: string): Promise<EnvioAttendeeRow[]> {
  const data = await envioQuery<{ rows: EnvioAttendeeRow[] }>(
    `query Attendees($eventId: numeric!, $cursor: String!, $limit: Int!) {
      rows: Ticket(
        where: {eventId: {_eq: $eventId}, revoked: {_eq: false}, id: {_gt: $cursor}}
        order_by: {id: asc}
        limit: $limit
      ) { id tier checkIn { id } identity { nickname kycLevel } }
    }`,
    { eventId, cursor, limit: ATTENDEE_PAGE_SIZE },
  );
  return data.rows;
}

/**
 * 주최자용 참석자 목록.
 *
 * 인덱서는 목록용이다 — 체인 이벤트 말고는 아무것도 들고 있지 않아서
 * 여기서 새어 나갈 개인정보가 애초에 없다. 닉네임은 체인에서 읽을 수 없고
 * (`Identity.nicknameOf` 는 해시만 돌려준다) `NicknameSet` 이벤트를 받은
 * 인덱서에만 평문이 있다.
 */
export const listAttendees = onCall(async (request): Promise<AttendeeRow[]> => {
  const raw = (request.data ?? {}) as { eventId?: unknown };
  const eventId = requireEventId(raw.eventId);

  const caller = await resolveCallerAccount(request);
  await requireOrganizer(BigInt(eventId), caller);

  const attendees: AttendeeRow[] = [];
  let cursor = '';
  for (;;) {
    const rows = await attendeePage(eventId, cursor);
    for (const row of rows) {
      attendees.push({
        tokenId: row.id,
        nickname: row.identity?.nickname ?? '',
        checkedIn: row.checkIn !== null,
        tier: row.tier,
        kycLevel: row.identity?.kycLevel ?? 0,
      });
    }
    if (rows.length < ATTENDEE_PAGE_SIZE) return attendees;
    cursor = rows[rows.length - 1]!.id;
  }
});
