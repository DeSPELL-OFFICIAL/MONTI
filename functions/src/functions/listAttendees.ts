import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type AttendeeRow, type Hex } from '@monti/shared';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { envioPage } from '../lib/envio.js';
import { nicknamesByAccount } from '../lib/nicknames.js';

const DIGITS_RE = /^[0-9]+$/;

/** Hasura 는 역할마다 행 수 상한이 있다. 한 쪽씩 커서로 끝까지 읽어야 목록이 잘리지 않는다. */
export const ATTENDEE_PAGE_SIZE = 500;

interface EnvioAttendeeRow {
  id: string;
  tier: number;
  owner: string;
  checkIn: { id: string } | null;
  identity: { kycLevel: number } | null;
}

/**
 * 인덱서의 `kycLevel` 을 `AttendeeRow.kycLevel`(0 | 1)로 좁힌다.
 *
 * 인덱서에 계정 행이 없으면 0 이다 — 아직 아무것도 확인되지 않은 계정과 같다.
 * 0 도 1 도 아닌 값은 인덱서나 컨트랙트가 어긋났다는 뜻이라 **목록 전체를 세운다**.
 * 그 줄만 조용히 빼면 주최자 화면에서 표를 가진 사람이 사라진다 —
 * 잘린 목록은 게이트의 잘린 스냅샷과 같은 종류의, 가장 나쁜 실패다.
 */
function narrowKycLevel(value: number | undefined): 0 | 1 {
  if (value === undefined) return 0;
  if (value !== 0 && value !== 1) throw new HttpsError('internal', 'BAD_KYC_LEVEL');
  return value;
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
 * 주최자용 참석자 목록.
 *
 * 인덱서는 목록용이다 — 체인 이벤트 말고는 아무것도 들고 있지 않아서
 * 여기서 새어 나갈 개인정보가 애초에 없다. 닉네임은 v2 에서 체인에도 인덱서에도 없고
 * Firestore `nicknames` 장부에만 있다(P5) — 소유 계정으로 한 번에 모아 읽는다.
 *
 * 쪽 수에 상한이 없으므로 기본 60 초·256 MiB 로는 큰 공연에서 불투명하게 죽는다.
 * `issueSnapshot` 과 같은 이유로 한도를 명시한다.
 */
export const listAttendees = onCall(
  { memory: '512MiB', timeoutSeconds: 120 },
  async (request): Promise<AttendeeRow[]> => {
    // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
    // (인가는 `eventOrg(eventId)` 로 조직을 찾아야 해서 값 검증 뒤에 온다.)
    const caller = await resolveCallerAccount(request);
    const raw = (request.data ?? {}) as { eventId?: unknown };
    const eventId = requireEventId(raw.eventId);
    await requireOrganizer(BigInt(eventId), caller);

    // `eventId` 는 schema.graphql 의 `BigInt!` → Hasura `numeric`. `String!` 로 선언하면 거절된다.
    // 값은 문자열로 보낸다(자바스크립트 number 는 2^53 에서 깨진다).
    // `eventId`·`revoked` 는 서버 쪽 필터일 뿐이라 골라 받지 않는다.
    const rows = await envioPage<EnvioAttendeeRow>(
      'Ticket',
      'id tier owner checkIn { id } identity { kycLevel }',
      ATTENDEE_PAGE_SIZE,
      {
        vars: '$eventId: numeric!',
        where: 'eventId: {_eq: $eventId}, revoked: {_eq: false}',
        values: { eventId },
      },
    );
    const names = await nicknamesByAccount(rows.map((row) => row.owner));
    return rows.map((row) => ({
      tokenId: row.id,
      nickname: names.get(row.owner.toLowerCase()) ?? '',
      checkedIn: row.checkIn !== null,
      tier: row.tier,
      kycLevel: narrowKycLevel(row.identity?.kycLevel),
    }));
  },
);
