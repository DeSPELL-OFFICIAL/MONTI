import type { ReactElement } from 'react';

import { Button } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import { TAP_REFUSAL, type TapRefusal } from '../gate/machine';

export interface RefusedToastProps {
  refusal: TapRefusal;
  onDismiss?: () => void;
}

/**
 * 탭을 받지 않았다는 알림. **관객 이야기가 아니라 게이트 사정이다.**
 *
 * 문이 한 번에 한 사람만 들여보내기 때문에(`gate/machine.ts` 의 두 번째 불변식), 앞사람을
 * 확인하는 동안 들어온 탭은 거절된다. 그건 그 관객의 표에 문제가 있다는 뜻이 아니다 — 그래서
 * 이 알림은 빨강도, `role="alert"` 도, "입장 불가"도 쓰지 않는다. 그 셋 중 하나라도 빌리면
 * 뒤에 선 사람은 자기가 거절당했다고 읽는다.
 *
 * `role="status"` 는 낭독기가 지금 읽고 있는 판정을 끊지 않고 뒤이어 말하게 한다.
 */
export function RefusedToast({ refusal, onDismiss }: RefusedToastProps): ReactElement {
  const copy = useStaffCopy();
  const sentence =
    refusal === TAP_REFUSAL.confirming ? copy.refusal.confirming : copy.refusal.showingVerdict;

  return (
    <div className="gate-toast" role="status">
      <span>{sentence}</span>
      {onDismiss === undefined ? null : (
        <Button variant="ghost" onClick={onDismiss}>{copy.done}</Button>
      )}
    </div>
  );
}
