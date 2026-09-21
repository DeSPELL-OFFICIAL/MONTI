import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { info } from 'firebase-functions/logger';
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
import { envioQuery } from '../lib/envio.js';
import { decryptField, piiAad } from '../lib/kms.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_RE = /^[0-9]+$/;
const TICKET_PAGE_SIZE = 500;

interface EnvioTicketRow {
  id: string;
  eventId: string;
  tier: number;
  owner: string;
  revoked: boolean;
  checkIn: { id: string } | null;
}

interface EnvioIdentityRow {
  id: string;
  nickname: string | null;
}

interface EventMeta {
  imageCid: string;
  requireKyc: boolean;
}

interface TierRow {
  name: string;
  seated: boolean;
}

/** CID는 내용 지문이라 불변이다. 한 번 읽으면 프로세스가 살아 있는 동안 다시 읽지 않는다. */
const eventTitleCache = new Map<string, string>();

export async function eventTitleOf(imageCid: string): Promise<string> {
  if (!imageCid) return '';
  const cached = eventTitleCache.get(imageCid);
  if (cached !== undefined) return cached;

  let title = '';
  try {
    const response = await fetch(`${IPFS_GATEWAY.value()}/${imageCid}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const metadata = (await response.json()) as { name?: string; title?: string };
      title = metadata.name ?? metadata.title ?? '';
    }
  } catch {
    // 게이트웨이가 죽어도 스냅샷 발급은 막지 않는다. 제목은 빈 문자열로 간다.
    title = '';
  }
  // 빈 제목은 캐시하지 않는다 — 게이트웨이가 잠깐 죽은 것을 영구 결론으로 굳히면 안 된다.
  if (title) eventTitleCache.set(imageCid, title);
  return title;
}

/**
 * 계정 → 닉네임.
 *
 * **체인에서 읽을 수 없다.** `Identity.nicknameOf(account)` 는 `keccak256(nickname)` 만 돌려준다
 * (contracts/src/Identity.sol). 평문은 `NicknameSet` 이벤트에만 실려 있고, 인덱서가
 * `IdentityAccount.nickname` 으로 들고 있다. 그래서 닉네임의 출처는 인덱서 하나다.
 */
async function nicknamesOf(accounts: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(accounts.map((account) => account.toLowerCase()))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;

  const data = await envioQuery<{ rows: EnvioIdentityRow[] }>(
    `query Nicknames($accounts: [String!]!, $limit: Int!) {
      rows: IdentityAccount(where: {id: {_in: $accounts}}, limit: $limit) { id nickname }
    }`,
    { accounts: unique, limit: unique.length },
  );
  for (const row of data.rows) names.set(row.id.toLowerCase(), row.nickname ?? '');
  return names;
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

async function deviceOf(account: Hex): Promise<readonly [Hex, Hex]> {
  const device = (await publicClient().readContract({
    address: deployment().identity,
    abi: identityAbi,
    functionName: 'activeDevice',
    args: [account],
  })) as readonly [Hex, Hex];
  return device;
}

function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  }
  return value;
}

function requireGateAccount(value: unknown): Hex {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
  }
  return value as Hex;
}

/** Hasura 는 역할마다 행 수 상한이 있다. 한 쪽씩 커서로 끝까지 읽어야 스냅샷이 잘리지 않는다. */
async function ticketPage(eventId: string, cursor: string): Promise<EnvioTicketRow[]> {
  // `eventId` 는 schema.graphql 의 `BigInt!` → Hasura `numeric`. `String!` 로 선언하면 거절된다.
  const data = await envioQuery<{ rows: EnvioTicketRow[] }>(
    `query Tickets($eventId: numeric!, $cursor: String!, $limit: Int!) {
      rows: Ticket(
        where: {eventId: {_eq: $eventId}, revoked: {_eq: false}, id: {_gt: $cursor}}
        order_by: {id: asc}
        limit: $limit
      ) { id eventId tier owner revoked checkIn { id } }
    }`,
    { eventId, cursor, limit: TICKET_PAGE_SIZE },
  );
  return data.rows;
}

export const issueSnapshot = onCall(
  { secrets: [ATTESTER_PK], memory: '1GiB', timeoutSeconds: 120 },
  async (request): Promise<SnapshotWire> => {
    const raw = (request.data ?? {}) as { eventId?: unknown; gateAccount?: unknown };
    const eventId = requireEventId(raw.eventId);
    const gateAccount = requireGateAccount(raw.gateAccount);

    // 호출자는 스태프 본인의 세션이다. 게이트 단말기 계정은 Firebase에 로그인하지 않는다.
    // 이 두 줄을 통과하기 전에는 개인정보를 한 바이트도 읽지 않는다.
    const caller = await resolveCallerAccount(request);
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
    const eventTitle = await eventTitleOf(meta.imageCid);

    const tickets: SnapshotTicket[] = [];
    let photos = 0;
    let cursor = '';
    for (;;) {
      const rows = await ticketPage(eventId, cursor);
      if (rows.length === 0) break;
      const nicknames = await nicknamesOf(rows.map((row) => row.owner));

      for (const row of rows) {
        const account = getAddress(row.owner);
        const [device, photoJpegB64] = await Promise.all([
          deviceOf(account),
          // requireKyc 가 false 인 공연에는 사진이 아예 없다. KMS 를 부르지도 않는다.
          requireKyc ? photoOf(account) : Promise.resolve(''),
        ]);
        if (photoJpegB64) photos += 1;
        tickets.push({
          tokenId: row.id,
          account,
          deviceX: device[0],
          deviceY: device[1],
          photoJpegB64,
          displayName: nicknames.get(row.owner.toLowerCase()) ?? '',
          tier: row.tier,
          tierName: tiers[row.tier]?.name ?? '',
          // 좌석 배정은 MVP 밖이다(스펙 §15 Could). 좌석 티어라도 지금은 빈 문자열이다.
          seat: '',
          checkedIn: row.checkIn !== null,
        });
      }

      if (rows.length < TICKET_PAGE_SIZE) break;
      cursor = rows[rows.length - 1]!.id;
    }

    const epoch = Math.floor(Date.now() / 1000);
    const unsigned: UnsignedSnapshot = {
      v: 1,
      eventId,
      eventTitle,
      requireKyc,
      epoch,
      expiresAt: epoch + SNAPSHOT_TTL_SECONDS,
      tickets,
    };
    const attesterSig = await getAttesterAccount().sign({ hash: snapshotDigest(unsigned) });

    // 감사 기록. 누가·언제·어느 공연의 개인정보를 몇 건 열었는지만 남긴다. 평문은 한 글자도 넣지 않는다.
    info('pii.access', {
      fn: 'issueSnapshot',
      eventId,
      gateAccount,
      caller,
      requireKyc,
      tickets: tickets.length,
      photos,
      epoch,
    });

    return { ...unsigned, attesterSig };
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

    const contracts = deployment();
    const caller = await resolveCallerAccount(request);
    const eventId = (await publicClient().readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventOf',
      args: [BigInt(tokenId)],
    })) as bigint;

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
    const account = getAddress(owner);
    const [nicknames, photoJpegB64] = await Promise.all([
      nicknamesOf([account]),
      meta.requireKyc ? photoOf(account) : Promise.resolve(''),
    ]);

    info('pii.access', {
      fn: 'getPhotoForGate',
      eventId: eventId.toString(),
      tokenId,
      gateAccount,
      caller,
      requireKyc: meta.requireKyc,
      photos: photoJpegB64 ? 1 : 0,
    });

    return { photoJpegB64, displayName: nicknames.get(account.toLowerCase()) ?? '' };
  },
);
