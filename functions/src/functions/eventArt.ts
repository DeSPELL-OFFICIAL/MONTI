import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { FunctionsErrorCode } from 'firebase-functions/v2/https';
import { warn } from 'firebase-functions/logger';
import { requireEventOrganizer, resolveCallerAccount } from '../lib/auth.js';
import { CID_RE } from '../lib/cid.js';
import { EVENT_ART, db } from '../lib/db.js';

const DIGITS_RE = /^[0-9]+$/;

/** 한 공연의 티켓 종류 상한. `Ticket.sol:193` 이 8 을 넘는 `Tier[]` 를 `InvalidTiers` 로 거절한다. */
export const MAX_ART_TIERS = 8;

/**
 * 웹이 번들로 들고 있는 기본 그림 열둘. 값은 **키 한 글자**다 — 그림 자체는 순수 SVG
 * 컴포넌트라 핀도 CID 도 업로드도 없고, Firestore 에 들어가는 것은 1바이트뿐이다.
 *
 * 이 목록은 `firestore.rules` 의 `artOk` 와 **같아야 한다**. 규칙 파일은 TS 를 읽지 못해
 * 글자 목록이 두 벌로 존재할 수밖에 없고, 여기만 넓히면 새 글자를 고른 순간부터 초안
 * 자동저장이 문서 단위 권한 오류로 통째로 죽는다. 두 벌의 대조는 `eventArt.test.ts` 가
 * 규칙 파일을 직접 읽어 배포 전에 잡는다.
 */
export const ART_PRESETS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
] as const;
export type ArtPreset = (typeof ART_PRESETS)[number];

/** 종류 한 칸의 그림. 기본 넷 중 하나이거나 주최자가 직접 올린 그림 하나다 — **둘 중 하나뿐**이다. */
export type TierArt = { preset: ArtPreset } | { imageCid: string };

function reject(code: FunctionsErrorCode, reason: string): never {
  warn('eventArt.rejected', { code, reason });
  throw new HttpsError(code, reason);
}

/**
 * 10진수 문자열 하나로 정규화한다. 이 값은 문서 id 이자 체인 질의의 인자라,
 * `"011"` 과 `"11"` 이 두 문서로 갈라지면 주최자가 고친 그림을 관객이 못 보게 된다.
 */
function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    reject('invalid-argument', 'BAD_EVENT_ID');
  }
  return BigInt(value).toString();
}

/**
 * 종류별 그림 목록. 한 칸에 `preset` 과 `imageCid` 중 **정확히 하나**만 있어야 한다 —
 * 둘 다 있으면 화면이 어느 쪽을 그릴지 여기서 정해지지 않고, 둘 다 없으면 그 칸은 빈 카드가 된다.
 */
function requireTiers(value: unknown): TierArt[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ART_TIERS) {
    reject('invalid-argument', 'BAD_TIERS');
  }

  return value.map((entry): TierArt => {
    if (typeof entry !== 'object' || entry === null) reject('invalid-argument', 'BAD_TIERS');
    const { preset, imageCid } = entry as { preset?: unknown; imageCid?: unknown };
    if ((preset === undefined) === (imageCid === undefined)) {
      reject('invalid-argument', 'BAD_TIERS');
    }
    if (preset !== undefined) {
      if (typeof preset !== 'string' || !(ART_PRESETS as readonly string[]).includes(preset)) {
        reject('invalid-argument', 'BAD_PRESET');
      }
      return { preset: preset as ArtPreset };
    }
    if (typeof imageCid !== 'string' || !CID_RE.test(imageCid)) {
      reject('invalid-argument', 'BAD_IMAGE_CID');
    }
    return { imageCid };
  });
}

/**
 * 티켓 그림을 저장한다. 주최자만, **언제든** — 공개 뒤에도 된다.
 *
 * 왜 Firestore 인가(계획 B-4): `Tier` 에 그림 칸이 없고(`Ticket.sol:40-47`), IPFS JSON 에
 * 넣으면 그 CID 가 `EventMeta.imageCid` 에 박히는데 `updateEventMeta` 는 Draft 에서만
 * 통하므로(`Ticket.sol:235`) 공개 뒤에는 고칠 수 없다. "나중에 수정 가능"을 지키는 자리는
 * 여기 하나다.
 *
 * 문서는 로그인한 사람이면 누구나 **직접** 읽는다(`firestore.rules` 의 `eventArt`) —
 * `orgProfiles` 와 같은 모양이다. 티켓 목록은 한 화면에 여러 공연의 그림을 그리므로,
 * 그때마다 콜러블을 깨우면 콜드 스타트가 그대로 화면의 빈칸이 된다.
 */
export const saveEventArt = onCall(async (request): Promise<{ ok: true }> => {
  // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
  const caller = await resolveCallerAccount(request);
  const raw = (request.data ?? {}) as { eventId?: unknown; tiers?: unknown };
  const eventId = requireEventId(raw.eventId);
  const tiers = requireTiers(raw.tiers);

  await requireEventOrganizer(BigInt(eventId), caller);

  // 병합하지 않는다 — 이 호출이 그림 목록의 전부다. 종류를 줄였는데 옛 칸이 남으면
  // 없는 종류의 그림이 화면에 그려진다.
  await db.collection(EVENT_ART).doc(eventId).set({ tiers, updatedAt: FieldValue.serverTimestamp() });

  return { ok: true };
});
