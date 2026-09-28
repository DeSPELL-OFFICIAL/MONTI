/**
 * tokenId 비트 레이아웃(설계 §12-1, Ticket.sol `_encodeTokenId`/`_decodeEvent`/`_decodeTier`/
 * `_decodeSerial` 와 동일):
 *   [0..88)   serial   — 전역 발급 순번. usedAt 패킹의 키.
 *   [88..96)  tier     — uint8 티어.
 *   [96..256) eventId  — 행사 id(≤ 2^160-1).
 * tokenId = (eventId << 96) | (tier << 88) | serial. 세 필드가 256비트를 빈틈없이 채우므로 모든
 * uint256 이 유효한 tokenId 다. 저장 슬롯 없이 id 하나에서 eventOf/tierOf 를 파생한다.
 */

const TIER_SHIFT = 88n;
const EVENT_SHIFT = 96n;
const SERIAL_MASK = (1n << 88n) - 1n; // Ticket._SERIAL_MASK
const TIER_MASK = 0xffn;
/** Ticket._MAX_EVENT_ID. 넘으면 `EventIdOverflow`. */
const MAX_EVENT_ID = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type TokenIdParts = {
  eventId: bigint;
  tier: number;
  serial: bigint;
};

/**
 * `_encodeTokenId` 와 같은 비트 조립. 범위 밖 값이 조용히 다른 토큰으로 접히지 않도록, 컨트랙트의
 * `SerialOverflow`/`EventIdOverflow` 가드를 그대로 미러링한다.
 */
export function encodeTokenId({ eventId, tier, serial }: TokenIdParts): bigint {
  if (!Number.isInteger(tier) || tier < 0 || tier > 255) throw new Error('BAD_TIER');
  if (typeof eventId !== 'bigint' || eventId < 0n || eventId > MAX_EVENT_ID) throw new Error('EVENT_ID_OVERFLOW');
  if (typeof serial !== 'bigint' || serial < 0n || serial > SERIAL_MASK) throw new Error('SERIAL_OVERFLOW');
  return (eventId << EVENT_SHIFT) | (BigInt(tier) << TIER_SHIFT) | serial;
}

/** `_decodeEvent`/`_decodeTier`/`_decodeSerial` 와 같은 분해. */
export function decodeTokenId(tokenId: bigint): TokenIdParts {
  if (typeof tokenId !== 'bigint' || tokenId < 0n || tokenId > MAX_UINT256) throw new Error('BAD_TOKEN_ID');
  return {
    eventId: tokenId >> EVENT_SHIFT,
    tier: Number((tokenId >> TIER_SHIFT) & TIER_MASK),
    serial: tokenId & SERIAL_MASK,
  };
}
