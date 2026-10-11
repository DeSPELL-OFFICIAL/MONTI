import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { info, warn } from 'firebase-functions/logger';
import { getAddress } from 'viem';
import {
  SNAPSHOT_TTL_SECONDS,
  identityAbi,
  snapshotDigest,
  ticketAbi,
  type Hex,
  type SnapshotTicket,
  type SnapshotWire,
  type UnsignedSnapshot,
} from '@monti/shared';
import { ATTESTER_PK, IPFS_GATEWAY } from '../config.js';
import { getAttesterAccount } from '../lib/attester.js';
import { requireStaffForGate, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PERSONS, db } from '../lib/db.js';
import { envioPageOnce } from '../lib/envio.js';
import { nicknamesByAccount } from '../lib/nicknames.js';
import { decryptField, piiAad } from '../lib/kms.js';
import { PORTRAIT_MAX_BASE64_BYTES } from '../lib/portrait.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_RE = /^[0-9]+$/;
/** Hasura 는 역할마다 행 수 상한이 있다. 한 쪽씩 커서로 끝까지 읽어야 스냅샷이 잘리지 않는다. */
const TICKET_PAGE_SIZE = 500;

/**
 * 스냅샷 한 장이 실을 수 있는 티켓 수 상한.
 *
 * 스냅샷은 통째로 서명되므로 쪼개 보낼 수 없다. 넘치는 공연은 조용히 잘라 보내는 대신
 * `failed-precondition SNAPSHOT_TOO_LARGE` 로 분명히 거절한다 —
 * 잘린 스냅샷은 게이트에서 "표가 없는 사람"을 만들어내는, 가장 나쁜 실패다.
 * (쪼개기는 나중 과제다.)
 */
export const SNAPSHOT_MAX_TICKETS = 500;

/**
 * 사진 한 장의 base64 길이 상한(32 KB).
 * 넘는 사진은 그 티켓만 건너뛴다 — 한 장 때문에 스냅샷 전체가 응답 한계에 걸리면 아무도 못 들어간다.
 *
 * 값의 원본은 `lib/portrait.ts` 다. 저장할 때 줄이는 쪽(`normalizePortrait`)과 읽을 때 거르는
 * 쪽(여기)이 같은 숫자를 봐야 "저장은 됐는데 게이트에서만 사라지는 사진" 이 생기지 않는다.
 */
export const SNAPSHOT_MAX_PHOTO_BYTES = PORTRAIT_MAX_BASE64_BYTES;

/** 직렬화된 스냅샷 전체 상한(8 MB). callable 응답 한계(10 MB) 아래에 여유를 두고 잡았다. */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

interface EnvioTicketRow {
  id: string;
  tier: number;
  owner: string;
  checkIn: { id: string } | null;
}

interface EventMeta {
  imageCid: string;
  requireKyc: boolean;
}

interface TierRow {
  name: string;
  seated: boolean;
}

/**
 * 개인정보 접근 감사 기록. **id 와 개수만** 담는다 — 평문도, 봉투도, 닉네임도 넣지 않는다.
 * 성공·실패를 가리지 않고 `finally` 에서 한 번 쓴다(중간에 터진 호출도 흔적을 남겨야 한다).
 */
interface PiiAccessRecord {
  fn: 'issueSnapshot' | 'getPhotoForGate';
  eventId: string;
  gateAccount: string;
  caller: string;
  requireKyc: boolean;
  photos: number;
  outcome: 'ok' | 'error';
  tokenId?: string;
  tickets?: number;
  degraded?: number;
  epoch?: number;
  errorCode?: string;
}

/** 감사 기록에 남길 에러 이름. HttpsError 의 메시지는 고정 코드라 그대로 쓰고, 나머지는 뭉뚱그린다. */
function errorCodeOf(error: unknown): string {
  return error instanceof HttpsError ? error.message : 'INTERNAL';
}

/** CID는 내용 지문이라 불변이다. 한 번 읽으면 프로세스가 살아 있는 동안 다시 읽지 않는다. */
const eventTitleCache = new Map<string, string>();

export async function eventTitleOf(imageCid: string): Promise<string> {
  if (!imageCid) return '';
  const cached = eventTitleCache.get(imageCid);
  if (cached !== undefined) return cached;

  let title = '';
  let status = 0;
  try {
    const response = await fetch(`${IPFS_GATEWAY.value()}/${imageCid}`, {
      signal: AbortSignal.timeout(5_000),
    });
    status = response.status;
    if (response.ok) {
      const metadata = (await response.json()) as { name?: string; title?: string };
      title = metadata.name ?? metadata.title ?? '';
    } else {
      // 게이트웨이가 죽어도 스냅샷 발급은 막지 않는다. 다만 조용히 넘어가지도 않는다.
      warn('ipfs.title_miss', { imageCid, status });
    }
  } catch {
    // 타임아웃·네트워크 실패·깨진 JSON. 응답 전에 끊겼으면 status 는 0 이다.
    warn('ipfs.title_miss', { imageCid, status });
    title = '';
  }
  // 빈 제목은 캐시하지 않는다 — 게이트웨이가 잠깐 죽은 것을 영구 결론으로 굳히면 안 된다.
  if (title) eventTitleCache.set(imageCid, title);
  return title;
}

/**
 * 한 계정의 얼굴 사진을 연다. **개인정보가 평문이 되는 유일한 지점이다.**
 * 호출 전에 `requireStaffForGate` 가 통과해 있어야 한다.
 *
 * 실명(`persons.enc.name`)은 복호화하지도 반환하지도 않는다 — 스태프는 사진으로 대조한다.
 * 복호화 결과는 응답으로만 나가고 Firestore 에 되쓰지 않는다.
 */
async function photoOf(account: Hex): Promise<string> {
  const contracts = deployment();
  const personId = (await publicClient().readContract({
    address: contracts.identity,
    abi: identityAbi,
    functionName: 'personOf',
    args: [account],
  })) as Hex;

  const person = await db.collection(PERSONS).doc(personId).get();
  if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
  const photoEnc = person.get('photoEnc') as string | undefined;
  if (!photoEnc) return '';
  // 봉투는 `personId:photo` 로 묶여 있다(Task 12·17). AAD 가 다르면 GCM 태그에서 터진다.
  return decryptField(photoEnc, piiAad(personId, 'photo'));
}

/**
 * 스냅샷에 실을 사진 한 장.
 *
 * 한 명이 빠졌다고 공연 전체를 못 여는 것이 오프라인 게이트에서는 최악이다.
 * 사람 문서가 없으면 그 티켓만 사진 없이 내려보내고(`degraded`) 경고를 남긴다.
 * 너무 큰 사진도 같은 이유로 건너뛴다.
 */
async function snapshotPhotoOf(
  tokenId: string,
  account: Hex,
): Promise<{ photo: string; degraded: boolean }> {
  let photo: string;
  try {
    photo = await photoOf(account);
  } catch (error) {
    if (error instanceof HttpsError && error.message === 'PERSON_NOT_FOUND') {
      warn('snapshot.person_missing', { tokenId });
      return { photo: '', degraded: true };
    }
    throw error;
  }
  if (photo.length > SNAPSHOT_MAX_PHOTO_BYTES) {
    warn('snapshot.photo_too_large', { tokenId, bytes: photo.length });
    return { photo: '', degraded: false };
  }
  return { photo, degraded: false };
}

async function deviceOf(account: Hex): Promise<readonly [Hex, Hex]> {
  const device = (await publicClient().readContract({
    address: deployment().identity,
    abi: identityAbi,
    functionName: 'activeDevice',
    args: [account],
  })) as readonly [Hex, Hex];
  return device;
}

/**
 * 10진수 문자열 하나로 정규화한다. `"011"` 과 `"11"` 은 체인에서는 같은 공연인데
 * 문자열로는 다르다 — 인가에 쓴 값과 서명에 실린 값이 어긋나면 단말기의 문자열 비교가 빗나간다.
 */
function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  }
  return BigInt(value).toString();
}

function requireGateAccount(value: unknown): Hex {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
  }
  return value as Hex;
}

export const issueSnapshot = onCall(
  { secrets: [ATTESTER_PK], memory: '1GiB', timeoutSeconds: 120 },
  async (request): Promise<SnapshotWire> => {
    const raw = (request.data ?? {}) as { eventId?: unknown; gateAccount?: unknown };
    const eventId = requireEventId(raw.eventId);
    const gateAccount = requireGateAccount(raw.gateAccount);

    // 발급 시각. TTL 도 감사 기록도 이 한 시각을 쓴다.
    const epoch = Math.floor(Date.now() / 1000);
    const audit: PiiAccessRecord = {
      fn: 'issueSnapshot',
      eventId,
      gateAccount,
      caller: '',
      requireKyc: false,
      tickets: 0,
      degraded: 0,
      photos: 0,
      epoch,
      outcome: 'error',
    };

    try {
      // 호출자는 스태프 본인의 세션이다. 게이트 단말기 계정은 Firebase에 로그인하지 않는다.
      // 이 두 줄을 통과하기 전에는 개인정보를 한 바이트도 읽지 않는다.
      const caller = await resolveCallerAccount(request);
      audit.caller = caller;
      await requireStaffForGate(BigInt(eventId), caller, gateAccount);

      const contracts = deployment();
      const [meta, tiers] = await Promise.all([
        publicClient().readContract({
          address: contracts.ticket,
          abi: ticketAbi,
          functionName: 'eventMeta',
          args: [BigInt(eventId)],
        }) as Promise<EventMeta>,
        publicClient().readContract({
          address: contracts.ticket,
          abi: ticketAbi,
          functionName: 'tiers',
          args: [BigInt(eventId)],
        }) as Promise<readonly TierRow[]>,
      ]);
      const requireKyc = meta.requireKyc;
      audit.requireKyc = requireKyc;
      const eventTitle = await eventTitleOf(meta.imageCid);

      // `eventId` 는 schema.graphql 의 `BigInt!` → Hasura `numeric`. `String!` 로 선언하면 거절된다.
      // `eventId`·`revoked` 는 서버 쪽 필터일 뿐이라 골라 받지 않는다.
      const ticketFilter = {
        vars: '$eventId: numeric!',
        where: 'eventId: {_eq: $eventId}, revoked: {_eq: false}',
        values: { eventId },
      };

      const tickets: SnapshotTicket[] = [];
      // 닉네임 표는 쪽을 넘어가며 쌓는다 — 같은 계정을 쪽마다 다시 묻지 않는다.
      const nicknames = new Map<string, string>();
      let photos = 0;
      let degraded = 0;
      let cursor = '';
      // 끝까지 드레인하지 않고 한 쪽씩 읽는다 — 상한을 넘는 공연은 나머지 쪽을 읽기 전에 거절해야 한다.
      for (;;) {
        const rows = await envioPageOnce<EnvioTicketRow>(
          'Ticket',
          'id tier owner checkIn { id }',
          cursor,
          TICKET_PAGE_SIZE,
          ticketFilter,
        );
        if (rows.length === 0) break;
        if (tickets.length + rows.length > SNAPSHOT_MAX_TICKETS) {
          // 복호화를 시작하기 전에 거절한다. 500장을 풀고 나서 터지는 것이 제일 비싸다.
          throw new HttpsError('failed-precondition', 'SNAPSHOT_TOO_LARGE');
        }

        const unknown = [...new Set(rows.map((row) => row.owner.toLowerCase()))].filter(
          (account) => !nicknames.has(account),
        );
        if (unknown.length > 0) {
          // 닉네임이 없는 계정도 '' 로 못박아 다음 쪽에서 다시 묻지 않는다(장부: Firestore, v2 P5).
          for (const account of unknown) nicknames.set(account, '');
          for (const [account, nickname] of await nicknamesByAccount(unknown)) {
            nicknames.set(account, nickname);
          }
        }

        for (const row of rows) {
          const account = getAddress(row.owner);
          const [device, photo] = await Promise.all([
            deviceOf(account),
            // requireKyc 가 false 인 공연에는 사진이 아예 없다. KMS 를 부르지도 않는다.
            requireKyc
              ? snapshotPhotoOf(row.id, account)
              : Promise.resolve({ photo: '', degraded: false }),
          ]);
          if (photo.photo) photos += 1;
          if (photo.degraded) degraded += 1;
          tickets.push({
            tokenId: row.id,
            account,
            deviceX: device[0],
            deviceY: device[1],
            photoJpegB64: photo.photo,
            displayName: nicknames.get(row.owner.toLowerCase()) ?? '',
            tier: row.tier,
            tierName: tiers[row.tier]?.name ?? '',
            // 좌석 배정은 MVP 밖이다(스펙 §15 Could). 좌석 티어라도 지금은 빈 문자열이다.
            seat: '',
            checkedIn: row.checkIn !== null,
          });
          // 한 장 풀 때마다 갱신한다 — 300장째에서 터져도 앞의 299장은 감사에 남아야 한다.
          audit.tickets = tickets.length;
          audit.degraded = degraded;
          audit.photos = photos;
        }

        if (rows.length < TICKET_PAGE_SIZE) break;
        cursor = rows[rows.length - 1]!.id;
      }

      // 한 명이 빠진 것은 그 티켓만 깎으면 되지만, 전원이 빠졌다면 사고는 설정 쪽이다. 크게 터뜨린다.
      if (requireKyc && tickets.length > 0 && degraded === tickets.length) {
        throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
      }

      const unsigned: UnsignedSnapshot = {
        v: 1,
        eventId,
        eventTitle,
        requireKyc,
        epoch,
        expiresAt: epoch + SNAPSHOT_TTL_SECONDS,
        tickets,
      };
      if (Buffer.byteLength(JSON.stringify(unsigned), 'utf8') > SNAPSHOT_MAX_BYTES) {
        throw new HttpsError('failed-precondition', 'SNAPSHOT_TOO_LARGE');
      }
      const attesterSig = await getAttesterAccount().sign({ hash: snapshotDigest(unsigned) });

      audit.outcome = 'ok';
      return { ...unsigned, attesterSig };
    } catch (error) {
      audit.errorCode = errorCodeOf(error);
      throw error;
    } finally {
      // 감사 기록. 누가·언제·어느 공연의 개인정보를 몇 건 열었는지만 남긴다. 평문은 한 글자도 넣지 않는다.
      // 실패해도 남긴다 — 300장을 풀고 나서 터진 호출이 흔적 없이 사라지면 안 된다.
      info('pii.access', audit);
    }
  },
);

export const getPhotoForGate = onCall(
  async (request): Promise<{ photoJpegB64: string; displayName: string }> => {
    const raw = (request.data ?? {}) as { tokenId?: unknown; gateAccount?: unknown };
    if (typeof raw.tokenId !== 'string' || !DIGITS_RE.test(raw.tokenId)) {
      throw new HttpsError('invalid-argument', 'BAD_TOKEN_ID');
    }
    const tokenId = raw.tokenId;
    const gateAccount = requireGateAccount(raw.gateAccount);

    const audit: PiiAccessRecord = {
      fn: 'getPhotoForGate',
      eventId: '',
      tokenId,
      gateAccount,
      caller: '',
      requireKyc: false,
      photos: 0,
      outcome: 'error',
    };

    try {
      const contracts = deployment();
      const caller = await resolveCallerAccount(request);
      audit.caller = caller;
      const eventId = (await publicClient().readContract({
        address: contracts.ticket,
        abi: ticketAbi,
        functionName: 'eventOf',
        args: [BigInt(tokenId)],
      })) as bigint;
      audit.eventId = eventId.toString();

      // 토큰이 이 게이트의 공연 것이 아니면 여기서 `permission-denied` 로 끝난다.
      await requireStaffForGate(eventId, caller, gateAccount);

      const [owner, meta] = await Promise.all([
        publicClient().readContract({
          address: contracts.ticket,
          abi: ticketAbi,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
        }) as Promise<Hex>,
        publicClient().readContract({
          address: contracts.ticket,
          abi: ticketAbi,
          functionName: 'eventMeta',
          args: [eventId],
        }) as Promise<EventMeta>,
      ]);
      audit.requireKyc = meta.requireKyc;
      const account = getAddress(owner);
      // 한 장만 묻는 자리다. 사람 문서가 없으면 스태프에게 분명히 알려야 하므로 여기서는 그대로 터뜨린다.
      const [nicknames, photoJpegB64] = await Promise.all([
        nicknamesByAccount([account]),
        meta.requireKyc ? photoOf(account) : Promise.resolve(''),
      ]);
      audit.photos = photoJpegB64 ? 1 : 0;

      audit.outcome = 'ok';
      return { photoJpegB64, displayName: nicknames.get(account.toLowerCase()) ?? '' };
    } catch (error) {
      audit.errorCode = errorCodeOf(error);
      throw error;
    } finally {
      info('pii.access', audit);
    }
  },
);
