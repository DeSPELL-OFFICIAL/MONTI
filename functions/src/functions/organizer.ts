import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { warn } from 'firebase-functions/logger';
import { getAddress } from 'viem';
import { organizersAbi, type Hex } from '@monti/shared';
import { PINATA_JWT } from '../config.js';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PERSONS, PIN_QUOTA, USERS, db } from '../lib/db.js';
import { ImageProbeError, probeImage, type ImageProbe } from '../lib/imageProbe.js';

const ORG_ID_RE = /^[0-9]{1,78}$/;
/** 표준 base64. 패딩 말고는 다른 글자를 받지 않는다 — `Buffer.from` 은 쓰레기 문자를 조용히 버린다. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Pinata v3 업로드. 마스터 계획의 마법사가 쓰던 엔드포인트를 서버가 그대로 쓴다. */
const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
/** 업로드 한 건의 상한. 큰 포스터가 느린 회선에서도 끝날 만큼 주되, 무한정 매달리지는 않는다. */
const PINATA_TIMEOUT_MS = 30_000;

/**
 * 포스터 한 장의 상한(600 KB). 웹이 A4 150dpi(1240×1754) JPEG 로 구워 올리는 크기다 —
 * 품질 계단(0.85→0.4)을 다 내려도 이 안에 들어오지 않으면 애초에 올릴 물건이 아니다.
 */
export const MAX_POSTER_BYTES = 600 * 1024;
/** 티켓 그림 한 장의 상한(400 KB). 목록에서 여러 장이 한 화면에 뜨므로 포스터보다 작게 잡는다. */
export const MAX_TICKET_ART_BYTES = 400 * 1024;
/**
 * 한 변의 상한(px). 이보다 큰 그림은 화면 어디에도 쓰이지 않고, 받아 두면 게이트웨이가
 * 그걸 그대로 폰으로 내려보낸다. 치수는 **디코드 없이** 머리 바이트에서 읽는다(`lib/imageProbe.ts`).
 */
export const MAX_IMAGE_EDGE_PX = 4000;
/**
 * 한 사람이 하루에 핀할 수 있는 그림의 수. 핀은 주최자 인가보다 **앞**에 있다 —
 * 초안을 쓰는 사람은 아직 주최사가 없기 때문이다. 그 자리를 열어 두면 로그인한
 * 아무나 우리 Pinata 저장 공간을 채울 수 있으므로, 사람 단위 일일 한도가 유일한 문지기다.
 */
export const MAX_PINS_PER_DAY = 20;

/**
 * base32 CIDv1 59자. `bafy`(dag-pb) 또는 `bafk`(raw leaf — Pinata v3 가 작은 파일에 주는 것)로 시작한다.
 * 씨앗 스크립트(`contracts/script/Seed.s.sol`)가 체인에 넣기 전에 요구하는 모양과 같다 —
 * CIDv0(`Qm…`)를 그대로 흘려보내면 나중에 `createEvent` 가 이유 없이 거절당한다.
 */
export const CID_RE = /^baf[ky][a-z2-7]{55}$/;

/** 선택 칸 하나의 상한. 탐색 화면의 한 줄에 들어갈 만큼만 받는다. */
export const MAX_META_FIELD_CHARS = 200;
/** 분류의 상한. 체인의 `EventMeta.category` 가 `uint8` 이라 정본이 0–255 다(`transferInvites.ts` 의 ABI 조각). */
const MAX_CATEGORY = 255;
/** 숫자 문자열만 받는 모양. `Number('')`·`Number('0x10')` 이 조용히 숫자가 되는 것을 여기서 막는다. */
const CATEGORY_RE = /^[0-9]{1,3}$/;

/** 그림의 쓰임새. 상한이 다르고, 그것 말고는 서버가 구분할 이유가 없다. */
const IMAGE_KINDS: Record<string, number> = {
  poster: MAX_POSTER_BYTES,
  ticket: MAX_TICKET_ART_BYTES,
};

interface EventMetaInput {
  name: string;
  description: string;
  imageCid: string;
  venue?: string;
  category?: number;
  region?: string;
}

/**
 * 거절을 **로그에 남기고** 던진다(`createOrganizer` 와 같은 규칙).
 * 남기는 것은 gRPC 코드와 대문자 사유뿐이다 — 장소·태그·바이트는 넣지 않는다.
 */
function reject(code: FunctionsErrorCode, reason: string): never {
  warn('organizer.pin.rejected', { code, reason });
  throw new HttpsError(code, reason);
}

function requireOrgId(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_ORG_ID');
  }
  return value;
}

/** 포스터인가 티켓 그림인가. 이 값이 곧 크기 상한이다. */
function requireKind(value: unknown): number {
  if (typeof value !== 'string' || IMAGE_KINDS[value] === undefined) {
    reject('invalid-argument', 'BAD_IMAGE_KIND');
  }
  return IMAGE_KINDS[value] as number;
}

/**
 * 이미지를 바이트로 되돌린다. **디코드 전에** 문자열 길이로 한 번, 디코드 후에 바이트로 한 번 막는다.
 * 앞의 검사가 없으면 인가 전에 수 MB 짜리 base64 디코드를 아무나 시킬 수 있다.
 */
function requireImageBytes(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) {
    reject('invalid-argument', 'BAD_IMAGE');
  }
  // base64 는 3바이트를 4글자로 늘린다. 문자열 길이로 먼저 자른다.
  if (value.length > Math.ceil(maxBytes / 3) * 4) reject('invalid-argument', 'IMAGE_TOO_LARGE');

  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) reject('invalid-argument', 'BAD_IMAGE');
  if (bytes.length > maxBytes) reject('invalid-argument', 'IMAGE_TOO_LARGE');
  return bytes;
}

/**
 * 선택 칸 하나. 비어 있으면 **없는 것으로** 돌려준다 — 관람객 화면은 없는 칸을 기본값으로
 * 채우므로(`shared/envio/ipfs.ts`), 빈 문자열을 고정해 두면 기본값 대신 빈 줄이 그려진다.
 */
function optionalMetaField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'BAD_META');
  const trimmed = value.trim();
  if (trimmed.length > MAX_META_FIELD_CHARS) throw new HttpsError('invalid-argument', 'BAD_META');
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 분류 칸. **숫자**다 — 관람객 화면은 `typeof fields.category === 'number'` 일 때만 읽으므로
 * (`shared/envio/ipfs.ts`) 문자열을 핀하면 거기서 조용히 `0` 이 된다. 체인의
 * `EventMeta.category` 도 `uint8` 이라 정본은 0–255 정수 하나뿐이다.
 *
 * 폼의 `<select>` 는 값을 문자열로 주므로 숫자 문자열도 받아 **숫자로** 바꿔 돌려준다.
 * 없으면 없는 것으로 둔다 — 빈 칸을 기본값으로 채우는 쪽은 관람객 화면이다.
 */
function optionalCategory(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && CATEGORY_RE.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_CATEGORY) {
    throw new HttpsError('invalid-argument', 'BAD_META');
  }
  return parsed;
}

/** 포스터의 CID. `pinEventImage` 가 돌려준 값 그대로여야 한다. */
function requireCid(value: unknown): string {
  if (typeof value !== 'string' || !CID_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_IMAGE_CID');
  }
  return value;
}

function requireMeta(value: unknown): EventMetaInput {
  const meta = value as Record<string, unknown> | undefined;
  if (typeof meta !== 'object' || meta === null) throw new HttpsError('invalid-argument', 'BAD_META');
  const { name, description } = meta;
  if (typeof name !== 'string' || name.trim().length === 0 || typeof description !== 'string') {
    throw new HttpsError('invalid-argument', 'BAD_META');
  }
  return {
    name,
    description,
    imageCid: requireCid(meta.imageCid),
    venue: optionalMetaField(meta.venue),
    category: optionalCategory(meta.category),
    region: optionalMetaField(meta.region),
  };
}

/**
 * 공연을 만들 수 있는 사람인지 **체인에서** 판정한다. 우리 DB 에는 역할이 없다(스펙 §9.4).
 * 조직의 **오너**이거나 `PERM_CREATE_EVENT` 비트를 가진 **관리자**면 통과다
 * (`listAttendees.requireOrganizer` 와 같은 판정, 조직 단위로만 물어본다 —
 * 마법사는 아직 공연이 없는 상태에서 부른다).
 */
async function requireOrgOrganizer(orgId: bigint, caller: Hex): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  // 두 질문을 각각 던진다. 오너에게 모든 비트를 주는 것은 컨트랙트의 약속이지만,
  // 그 약속 하나에 인가를 걸어 두면 컨트랙트가 바뀌는 날 오너가 자기 조직에서 잠긴다.
  const [owner, canCreateEvent] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [orgId],
    }) as Promise<string>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, caller, PERM_CREATE_EVENT],
    }) as Promise<boolean>,
  ]);

  // 체인 읽기가 돌려주는 주소는 체크섬이 지켜져 있지 않다. `lib/auth.ts` 가 세션 클레임에
  // 거는 것과 같은 정규화를 여기서도 건다 — 비교 전에 한 번만.
  if (getAddress(owner).toLowerCase() !== caller.toLowerCase() && !canCreateEvent) {
    throw new HttpsError('permission-denied', 'NOT_ORGANIZER');
  }
}

/**
 * 그림을 핀할 수 있는 사람인지 본다. **주최자 인가가 아니다** — 초안은 주최사를 만들기
 * 전에도 쓰므로(`/org/new` 는 `orgId` 없이 열린다) 그 자리에서 주최사를 요구하면
 * 포스터를 넣을 수 없다. 대신 가입이 끝난 사람(`active`)으로 좁히고 하루 한도를 건다.
 */
async function requireActivePerson(uid: string): Promise<string> {
  const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as string | undefined;
  if (!personId) reject('not-found', 'NO_SIGNUP');

  const person = await db.collection(PERSONS).doc(personId).get();
  if (!person.exists) reject('not-found', 'NO_SIGNUP');
  if ((person.get('status') as string) !== 'active') reject('failed-precondition', 'NOT_ACTIVE');
  return personId;
}

/**
 * 한도를 세는 하루의 경계는 **서울 자정**이다. 주최자가 밤에 만들다 자정을 넘기면
 * 한도가 새로 열리는데, 그 "자정"이 UTC 면 한국에서는 오전 9시라 아무 뜻도 없는 시각이 된다.
 */
function seoulDay(at: Date): string {
  // `en-CA` 는 `YYYY-MM-DD` 를 준다 — 문자열 비교만으로 같은 날인지 알 수 있다.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(at);
}

/**
 * 하루 한도를 하나 쓴다. 한도를 **업로드 전에** 센다 — 통과한 뒤에 세면 이미 올린 뒤다.
 * 트랜잭션으로 읽고 쓰므로 같은 사람이 동시에 여러 장을 올려도 한 번에 하나씩만 센다.
 */
async function consumePinQuota(personId: string): Promise<void> {
  const ref = db.collection(PIN_QUOTA).doc(personId);
  const day = seoulDay(new Date());
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const used = snapshot.get('day') === day ? ((snapshot.get('count') as number) ?? 0) : 0;
    if (used >= MAX_PINS_PER_DAY) reject('resource-exhausted', 'PIN_QUOTA');
    tx.set(ref, { day, count: used + 1, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * 파일 하나를 Pinata 에 고정하고 CID 를 돌려준다.
 *
 * JWT 는 이 함수 밖으로 나가지 않는다 — 응답에도, 로그에도, 에러 메시지에도 싣지 않는다.
 * 실패했을 때 남기는 것은 상태 코드뿐이다.
 */
async function pinToPinata(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  form.append('network', 'public');

  let response: Response;
  try {
    response = await fetch(PINATA_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PINATA_JWT.value()}` },
      body: form,
      signal: AbortSignal.timeout(PINATA_TIMEOUT_MS),
    });
  } catch {
    // 타임아웃·네트워크 실패. 원인 객체는 로그에 붙이지 않는다(요청 헤더가 딸려 올 수 있다).
    warn('pinata.upload_unreachable', { file: file.name });
    throw new HttpsError('unavailable', 'PINATA_UPLOAD_FAILED');
  }

  if (!response.ok) {
    warn('pinata.upload_failed', { file: file.name, status: response.status });
    throw new HttpsError('unavailable', 'PINATA_UPLOAD_FAILED');
  }

  let body: { data?: { cid?: unknown } };
  try {
    body = (await response.json()) as { data?: { cid?: unknown } };
  } catch {
    // 200 인데 JSON 이 아니다(게이트웨이가 끼어들어 HTML 을 실어 주는 날이 있다).
    // 여기서 막지 않으면 파서의 SyntaxError 가 그대로 새어 나가 이유 없는 `internal` 이 된다.
    warn('pinata.upload_unparsable', { file: file.name, status: response.status });
    throw new HttpsError('unavailable', 'PINATA_UPLOAD_FAILED');
  }
  const cid = body.data?.cid;
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    throw new HttpsError('internal', 'BAD_PINATA_CID');
  }
  return cid;
}

/**
 * 그림 한 장을 IPFS 에 고정하고 CID 만 돌려준다.
 *
 * **왜 메타데이터에서 떼어냈나.** Firestore 문서 상한은 1 MiB 다. 600 KB JPEG 의 base64 는
 * 800 KB 라 초안 문서에 바이트를 담는 길이 아예 없다(계획 C절). 그래서 웹은 크롭 직후
 * 바로 여기로 올리고 초안에는 CID 만 남긴다.
 *
 * **형식은 바이트가 정한다.** 클라이언트가 보낸 이름은 읽지 않는다 — `lib/portrait.ts` 와
 * 같은 규칙이다. 치수는 픽셀을 펴지 않고 머리 바이트에서 읽는다(`lib/imageProbe.ts`).
 */
export const pinEventImage = onCall(
  { secrets: [PINATA_JWT], timeoutSeconds: 120 },
  async (request): Promise<{ cid: string }> => {
    // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
    const uid = request.auth?.uid;
    if (!uid) reject('unauthenticated', 'AUTH_REQUIRED');

    const raw = (request.data ?? {}) as { bytesBase64?: unknown; kind?: unknown };
    const maxBytes = requireKind(raw.kind);
    const bytes = requireImageBytes(raw.bytesBase64, maxBytes);

    let probe: ImageProbe;
    try {
      probe = probeImage(bytes, MAX_IMAGE_EDGE_PX);
    } catch (error) {
      if (error instanceof ImageProbeError) reject('invalid-argument', error.code);
      throw error;
    }

    // 인가와 한도가 업로드보다 먼저다 — Pinata 저장 공간은 통과한 사람만 쓴다.
    const personId = await requireActivePerson(uid);
    await consumePinQuota(personId);

    try {
      const cid = await pinToPinata(new File([bytes], `image.${probe.extension}`, { type: probe.mime }));
      return { cid };
    } catch {
      // 못 올렸든, 돌아온 CID 가 체인이 받는 모양이 아니든, 부르는 쪽에는 같은 일이다.
      // 어디서 틀어졌는지는 `pinToPinata` 가 이미 로그에 남겼다.
      throw new HttpsError('internal', 'PIN_FAILED');
    }
  },
);

/**
 * 공연 메타데이터 JSON 을 IPFS 에 고정한다. **Pinata JWT 는 절대 클라이언트로 가지 않는다.**
 *
 * 체인에는 제목·소개글의 해시만 올라가므로(`Ticket.EventMeta`), 탐색 화면이 평문 제목과 그림을
 * 보여주려면 공개된 JSON 이 어딘가 있어야 한다. 포스터는 이미 `pinEventImage` 로 올라가 있고,
 * 여기서는 그 CID 를 가리키는 JSON 하나만 고정한다.
 */
export const pinEventMetadata = onCall(
  { secrets: [PINATA_JWT], timeoutSeconds: 120 },
  async (request): Promise<{ metadataCid: string }> => {
    // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
    const caller = await resolveCallerAccount(request);
    const raw = (request.data ?? {}) as { orgId?: unknown; meta?: unknown };
    const orgId = requireOrgId(raw.orgId);
    const meta = requireMeta(raw.meta);

    // 인가가 업로드보다 먼저다 — Pinata 저장 공간은 통과한 주최자만 쓴다.
    await requireOrgOrganizer(BigInt(orgId), caller);

    // 이미지 참조는 게이트웨이 주소가 아니라 `ipfs://` 다. 게이트웨이는 언제든 바뀐다.
    // 비어 있는 선택 칸은 **키째로** 빠진다 — 위 `optionalMetaField` 의 이유 그대로다.
    const metadata = {
      name: meta.name,
      description: meta.description,
      image: `ipfs://${meta.imageCid}`,
      ...(meta.venue !== undefined && { venue: meta.venue }),
      ...(meta.category !== undefined && { category: meta.category }),
      ...(meta.region !== undefined && { region: meta.region }),
    };
    const metadataCid = await pinToPinata(
      new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }),
    );

    return { metadataCid };
  },
);
