/**
 * config.yaml 의 `start_block` 규칙. gen-config.mjs 와 테스트가 함께 쓴다.
 *
 * 규칙: 이전 배포(`previous[]`) 중 **현재 배포와 주소를 하나라도 공유하는** 항목만
 * 그 배포 블록까지 start_block 을 되돌린다. 유지된 계약(같은 주소)의 과거 이벤트는
 * 그 옛 블록부터 있어 다시 봐야 하기 때문이다.
 *
 * 전면 재배포(identity·organizers·ticket 주소가 전부 새 주소)면 되돌릴 이유가 없다.
 * start_block 은 `deployment.block` 그대로다 — 옛 주소는 config 에 없어 스캔되지 않고,
 * 그 이전 구간엔 새 주소의 이벤트가 하나도 없다. 유지된 계약만 시작 블록을 앞으로 당긴다.
 *
 * 주소는 대소문자를 무시하고 비교한다(체크섬 표기 차이).
 */

/** 재배포 사이에 유지될 수 있는(주소를 비교하는) 컨트랙트 키. paymaster 는 인덱싱하지 않는다. */
export const ADDRESS_KEYS = ['identity', 'organizers', 'ticket'];

/**
 * @param {{ block: number, previous?: Array<Record<string, unknown>> } & Record<string, unknown>} deployment
 * @returns {{ startBlock: number, kept: Array<Record<string, unknown>> }}
 *   startBlock 과, 시작 블록을 되돌린(주소를 공유한) previous[] 항목들.
 */
export function computeStartBlock(deployment) {
  const current = new Set(
    ADDRESS_KEYS.map((key) => deployment[key])
      .filter((addr) => typeof addr === 'string')
      .map((addr) => addr.toLowerCase()),
  );
  const kept = (deployment.previous ?? []).filter((prev) =>
    ADDRESS_KEYS.some(
      (key) => typeof prev[key] === 'string' && current.has(prev[key].toLowerCase()),
    ),
  );
  const startBlock = Math.min(
    deployment.block,
    ...kept.map((p) => p.block).filter((b) => Number.isFinite(b)),
  );
  return { startBlock, kept };
}
