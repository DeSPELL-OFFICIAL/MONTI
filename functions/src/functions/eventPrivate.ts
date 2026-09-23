import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { warn } from 'firebase-functions/logger';
import { holdsEventTicket, isEventOrganizer, requireEventOrganizer, resolveCallerAccount } from '../lib/auth.js';
import { EVENT_PRIVATE, db } from '../lib/db.js';

const DIGITS_RE = /^[0-9]+$/;

/** 장소 한 줄. 공개 JSON 의 `venue` 와 같은 200자다 — 같은 칸이 공개인가 비공개인가만 다르다. */
export const MAX_PRIVATE_VENUE_CHARS = 200;
/** 길 안내 한 문단. "지하 1층 후문으로 오세요" 같은, 장소보다 긴 글이 들어오는 자리다. */
export const MAX_PRIVATE_NOTE_CHARS = 500;

/** 티켓 보유자가 보는 비공개 정보. 없는 칸은 **키째로** 빠진다. */
export interface EventPrivate {
  venue?: string;
  note?: string;
}

/**
 * 거절을 **로그에 남기고** 던진다(`createOrganizer` 와 같은 규칙).
 * 남기는 것은 gRPC 코드와 대문자 사유뿐이다 — 장소·안내문·계정 주소는 넣지 않는다.
 * 장소는 개인정보가 아니지만, 주최자가 숨기기로 한 값을 로그에 흘리면 숨긴 뜻이 없어진다.
 */
function reject(code: FunctionsErrorCode, reason: string): never {
  warn('eventPrivate.rejected', { code, reason });
  throw new HttpsError(code, reason);
}

/**
 * 10진수 문자열 하나로 정규화한다. 이 값은 **문서 id 이자 체인 질의의 인자**다 —
 * `"011"` 과 `"11"` 은 체인에서 같은 공연인데 문자열로는 다르므로, 정규화하지 않으면
 * 한 공연의 장소가 두 문서로 갈라져 주최자가 고친 값을 관객이 못 보게 된다.
 */
function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    reject('invalid-argument', 'BAD_EVENT_ID');
  }
  return BigInt(value).toString();
}

/** 선택 칸 하나. 비어 있으면 **없는 것으로** 돌려준다 — 빈 줄을 저장할 이유가 없다. */
function optionalText(value: unknown, maxChars: number, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') reject('invalid-argument', reason);
  const trimmed = value.trim();
  // 길이는 **코드 포인트**로 센다. `'가'.length` 는 1 이지만 이모지는 2 다.
  if ([...trimmed].length > maxChars) reject('invalid-argument', reason);
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 비공개 장소를 읽는다. **티켓을 들고 있거나 주최자 본인이면** 통과다.
 *
 * 왜 Firestore 규칙이 아니라 콜러블인가(계획 B-1): 규칙 파일은 체인을 읽을 수 없다.
 * 규칙만으로 하려면 `eventChats` 처럼 `members/{uid}` 거울 문서가 필요한데, 그 문서를
 * 써 줄 "입장" 순간이 장소에는 없다 — 채팅은 사람이 들어가는 동작이 있지만 공연 페이지는
 * 그냥 열린다. 거울은 양도 뒤 낡아서 표를 넘긴 사람에게 장소를 계속 열어 준다.
 * 콜러블은 매번 체인에 묻기 때문에 **양도하면 다음 호출부터 바로 막힌다.**
 */
export const getEventPrivate = onCall(async (request): Promise<EventPrivate> => {
  // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
  const caller = await resolveCallerAccount(request);
  const raw = (request.data ?? {}) as { eventId?: unknown };
  const eventId = requireEventId(raw.eventId);

  // 주최자 본인은 자기 공연의 티켓을 들고 있지 않다. 보유자가 대부분이므로 두 번째
  // 질문은 필요할 때만 던진다 — 통과하는 대부분의 호출에서 eth_call 세 번을 아낀다.
  const holder = await holdsEventTicket(BigInt(eventId), caller);
  if (!holder && !(await isEventOrganizer(BigInt(eventId), caller))) {
    reject('permission-denied', 'NOT_HOLDER');
  }

  const snapshot = await db.collection(EVENT_PRIVATE).doc(eventId).get();
  const venue = snapshot.get('venue') as string | undefined;
  const note = snapshot.get('note') as string | undefined;
  return {
    ...(typeof venue === 'string' && venue.length > 0 && { venue }),
    ...(typeof note === 'string' && note.length > 0 && { note }),
  };
});

/**
 * 비공개 장소를 덮어쓴다. 주최자만, **언제든** — 공개 뒤에도 된다.
 *
 * 체인 필드는 `publishEvent` 뒤 전부 동결이고(`Ticket.sol:235` 의 `NotDraft`) IPFS JSON 은
 * 애초에 고쳐 올릴 수 없다. 공개한 뒤에도 고칠 수 있는 것은 Firestore 에 있는 이 문서뿐이라,
 * 장소가 바뀌는 흔한 일을 감당할 수 있는 자리가 여기 하나다.
 *
 * `set` 은 **병합하지 않는다.** 이 호출이 비공개 기록의 전부를 말한다 — 그래야 장소만
 * 지우고 안내문은 남기는 것이 한 번의 호출로 가능하다.
 */
export const setEventPrivate = onCall(async (request): Promise<{ ok: true }> => {
  const caller = await resolveCallerAccount(request);
  const raw = (request.data ?? {}) as { eventId?: unknown; venue?: unknown; note?: unknown };
  const eventId = requireEventId(raw.eventId);
  const venue = optionalText(raw.venue, MAX_PRIVATE_VENUE_CHARS, 'BAD_VENUE');
  const note = optionalText(raw.note, MAX_PRIVATE_NOTE_CHARS, 'BAD_NOTE');

  await requireEventOrganizer(BigInt(eventId), caller);

  await db
    .collection(EVENT_PRIVATE)
    .doc(eventId)
    .set({
      ...(venue !== undefined && { venue }),
      ...(note !== undefined && { note }),
      updatedAt: FieldValue.serverTimestamp(),
    });

  return { ok: true };
});
