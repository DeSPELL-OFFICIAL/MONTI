import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { warn } from 'firebase-functions/logger';
import { getAddress } from 'viem';
import { organizersAbi, type Hex } from '@monti/shared';
import { PINATA_JWT } from '../config.js';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';

const ORG_ID_RE = /^[0-9]{1,78}$/;
/** 표준 base64. 패딩 말고는 다른 글자를 받지 않는다 — `Buffer.from` 은 쓰레기 문자를 조용히 버린다. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Pinata v3 업로드. 마스터 계획의 마법사가 쓰던 엔드포인트를 서버가 그대로 쓴다. */
const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
/** 업로드 한 건의 상한. 2 MB 이미지가 느린 회선에서도 끝날 만큼 주되, 무한정 매달리지는 않는다. */
const PINATA_TIMEOUT_MS = 30_000;

/** 대표 이미지 상한(2 MB). 콜러블 요청 한계(10 MB)보다 훨씬 작게 잡아 base64 부풀림까지 감당한다. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** base64 는 3바이트를 4글자로 늘린다. 디코드 **전에** 문자열 길이로 먼저 막는다. */
const MAX_IMAGE_B64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** 체인에 올라가는 것은 공개 자료다. 브라우저가 바로 그릴 수 있는 형식만 받는다. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * base32 CIDv1 59자. `bafy`(dag-pb) 또는 `bafk`(raw leaf — Pinata v3 가 작은 파일에 주는 것)로 시작한다.
 * 씨앗 스크립트(`contracts/script/Seed.s.sol`)가 체인에 넣기 전에 요구하는 모양과 같다 —
 * CIDv0(`Qm…`)를 그대로 흘려보내면 나중에 `createEvent` 가 이유 없이 거절당한다.
 */
const CID_RE = /^baf[ky][a-z2-7]{55}$/;

/** 선택 칸 하나의 상한. 탐색 화면의 한 줄에 들어갈 만큼만 받는다. */
export const MAX_META_FIELD_CHARS = 200;

/** 분류의 상한. 체인의 `EventMeta.category` 가 `uint8` 이라 정본이 0–255 다(`transferInvites.ts` 의 ABI 조각). */
const MAX_CATEGORY = 255;
/** 숫자 문자열만 받는 모양. `Number('')`·`Number('0x10')` 이 조용히 숫자가 되는 것을 여기서 막는다. */
const CATEGORY_RE = /^[0-9]{1,3}$/;

interface EventImage {
  bytes: Buffer;
  mime: string;
}

interface EventMetaInput {
  name: string;
  description: string;
  venue?: string;
  category?: number;
  region?: string;
}

function requireOrgId(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_ORG_ID');
  }
  return value;
}

/**
 * 이미지를 바이트로 되돌린다. **디코드 전에** 문자열 길이로 한 번, 디코드 후에 바이트로 한 번 막는다.
 * 앞의 검사가 없으면 인가 전에 수 MB 짜리 디코드를 아무나 시킬 수 있다.
 */
function requireImage(value: unknown): EventImage {
  const image = value as { base64?: unknown; mime?: unknown } | undefined;
  if (typeof image !== 'object' || image === null) throw new HttpsError('invalid-argument', 'BAD_IMAGE');

  const mime = image.mime;
  if (typeof mime !== 'string' || IMAGE_EXTENSIONS[mime] === undefined) {
    throw new HttpsError('invalid-argument', 'BAD_IMAGE_MIME');
  }

  const base64 = image.base64;
  if (typeof base64 !== 'string' || base64.length === 0 || !BASE64_RE.test(base64)) {
    throw new HttpsError('invalid-argument', 'BAD_IMAGE');
  }
  if (base64.length > MAX_IMAGE_B64_CHARS) throw new HttpsError('invalid-argument', 'IMAGE_TOO_LARGE');

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new HttpsError('invalid-argument', 'BAD_IMAGE');
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpsError('invalid-argument', 'IMAGE_TOO_LARGE');
  return { bytes, mime };
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

function requireMeta(value: unknown): EventMetaInput {
  const meta = value as
    | { name?: unknown; description?: unknown; venue?: unknown; category?: unknown; region?: unknown }
    | undefined;
  if (typeof meta !== 'object' || meta === null) throw new HttpsError('invalid-argument', 'BAD_META');
  const { name, description } = meta;
  if (typeof name !== 'string' || name.trim().length === 0 || typeof description !== 'string') {
    throw new HttpsError('invalid-argument', 'BAD_META');
  }
  return {
    name,
    description,
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
 * 공연 메타데이터를 IPFS 에 고정한다. **Pinata JWT 는 절대 클라이언트로 가지 않는다.**
 *
 * 체인에는 제목·소개글의 해시만 올라가므로(`Ticket.EventMeta`), 탐색 화면이 평문 제목과 그림을
 * 보여주려면 공개된 JSON 이 어딘가 있어야 한다. 그래서 이미지 → JSON 순으로 두 번 고정하고,
 * JSON 의 CID 가 `EventMeta.imageCid` 에 들어간다(마스터 계획 §347).
 *
 * 브라우저에 범위 제한 키를 쥐여 주는 길도 있었지만, 그 키는 어차피 사람이 꺼내 쓸 수 있다.
 * 업로드가 주최자 인가를 통과한 뒤에만 일어난다는 사실은 서버에서만 보장된다.
 */
export const pinEventMetadata = onCall(
  { secrets: [PINATA_JWT], timeoutSeconds: 120 },
  async (request): Promise<{ imageCid: string; metadataCid: string }> => {
    // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
    const caller = await resolveCallerAccount(request);
    const raw = (request.data ?? {}) as { orgId?: unknown; image?: unknown; meta?: unknown };
    const orgId = requireOrgId(raw.orgId);
    const image = requireImage(raw.image);
    const meta = requireMeta(raw.meta);

    // 인가가 업로드보다 먼저다 — Pinata 저장 공간은 통과한 주최자만 쓴다.
    await requireOrgOrganizer(BigInt(orgId), caller);

    const imageCid = await pinToPinata(
      new File([image.bytes], `image.${IMAGE_EXTENSIONS[image.mime]}`, { type: image.mime }),
    );
    // 이미지 참조는 게이트웨이 주소가 아니라 `ipfs://` 다. 게이트웨이는 언제든 바뀐다.
    // 비어 있는 선택 칸은 **키째로** 빠진다 — 위 `optionalMetaField` 의 이유 그대로다.
    const metadata = {
      name: meta.name,
      description: meta.description,
      image: `ipfs://${imageCid}`,
      ...(meta.venue !== undefined && { venue: meta.venue }),
      ...(meta.category !== undefined && { category: meta.category }),
      ...(meta.region !== undefined && { region: meta.region }),
    };
    const metadataCid = await pinToPinata(
      new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }),
    );

    return { imageCid, metadataCid };
  },
);
