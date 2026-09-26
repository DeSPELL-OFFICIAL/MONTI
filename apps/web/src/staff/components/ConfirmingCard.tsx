import type { ReactElement } from 'react';

import { useStaffCopy } from '../copy';

export interface ConfirmingCardProps {
  /** `GateContext.checking` — 2초. 아직 판정이 아니라 "붙잡고 있다"는 표시다. */
  checking: boolean;
  /** `GateContext.waitHint` — 5초. 기계는 옛 이름을 쓰고, 화면은 기다리라고만 말한다. */
  waitHint: boolean;
}

/**
 * 보냈고, 답을 기다리는 중.
 *
 * **이 카드에는 판정으로 읽힐 것이 하나도 없다.** 5초가 지나도 마찬가지다 — 그 시점에도 작업은
 * 살아 있고, 6초에 도착한 승인은 여전히 초록이다(스펙 §7.3). 예전 문구는 "다시 대세요"였고,
 * 그 한 줄이 같은 표를 두 번 보내게 만들었다. 지금은 기다리라고만 한다.
 *
 * `checking` 은 문장을 바꾸지 않고 점 세 개만 켠다: 2초 전에 무엇이든 나타났다 사라지면 그건
 * 정보가 아니라 깜빡임이다.
 */
export function ConfirmingCard({ checking, waitHint }: ConfirmingCardProps): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-card gate-card--confirming">
      <h2 className="gate-card__label">{copy.confirming.title}</h2>
      {checking ? <span className="spinner" aria-hidden="true" /> : null}
      {waitHint ? <p className="gate-card__hint">{copy.confirming.wait}</p> : null}
    </div>
  );
}
