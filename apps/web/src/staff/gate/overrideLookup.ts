import type { Hex } from 'viem';

import { readTicket } from '../../shared/chain/reads';
import type { SnapshotTicket } from '../types';

/**
 * 합성 행이 들고 갈 빈 값들. 수동 승인은 표 번호 하나만 쓰므로(체인·릴레이 경유, `route.ts`)
 * 계정·기기 키는 이 길에서 읽히지 않는다 — 명단 한 줄의 생김새만 지키는 자리막이다.
 */
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Hex;
const ZERO_WORD = `0x${'00'.repeat(32)}` as Hex;

/**
 * 명단(스냅샷)이 못 찾은 표 번호를, 체인에 한 번 물어 세우는 두 번째 길.
 *
 * 게이트의 명단은 인덱서의 `Ticket` 표로 만든다. 그게 얼어붙으면 방금 발급된 표가 명단에
 * 없고, 그러면 수동 승인 창에서 고를 사람이 없어 `picked` 가 서지 않는다 — 휴대폰이 아무것도
 * 내놓지 못하는 바로 그 관객을 위해 있는 기능인데도 입구에서 막힌다.
 *
 * 그래서 입력이 숫자(표 번호)뿐일 때만, `eventOf` 가 이 행사를 가리키고 취소되지 않은
 * (`isRevoked`) 표인지 체인에서 확인하고, 맞으면 합성 행 한 줄을 돌려준다. 그 한 줄로
 * `picked` 가 서면 `submitOverride` 는 이미 이런 '발급된 지 얼마 안 된 표'를 그대로 처리한다.
 * 읽기 하나라도 실패하면(없는 번호 등) `undefined` — 창은 '명단에 없음'으로 남는다.
 *
 * 동기 검색(`searchGuests`)은 손대지 않는다: 기존 호출부와 테스트가 그대로 쓰고, 이 비동기
 * 길은 그 검색이 비어 돌아왔을 때만 열린다.
 */
export async function resolveTicketOnChain(
  query: string,
  eventId: bigint,
): Promise<SnapshotTicket | undefined> {
  const needle = query.trim();
  if (!/^[0-9]+$/.test(needle)) return undefined;
  const ticket = readTicket();
  const tokenId = BigInt(needle);
  try {
    const [event, revoked] = await Promise.all([ticket.eventOf(tokenId), ticket.isRevoked(tokenId)]);
    if (event !== eventId || revoked) return undefined;
  } catch {
    return undefined;
  }
  return {
    tokenId: needle,
    account: ZERO_ADDRESS,
    deviceX: ZERO_WORD,
    deviceY: ZERO_WORD,
    photoJpegB64: '',
    displayName: '',
    tier: 0,
    tierName: '',
    seat: '',
    checkedIn: false,
  };
}
