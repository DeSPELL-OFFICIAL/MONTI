import type { ReactElement } from 'react';

import { Button } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import type { DenyCode } from '../types';

export interface DenyCardProps {
  code: DenyCode;
  detail?: string;
  onDone?: () => void;
}

/**
 * 입장 불가. 스펙 §13 의 열세 코드가 모두 여기로 온다.
 *
 * `role="alert"` 인 이유는 이 카드만이 **사람을 돌려보내는** 화면이기 때문이다. 낭독기가 다른
 * 안내를 마저 읽고 나서 알려주면 관객은 이미 문을 지나고 있다. 나머지 카드는 `StaffShell` 의
 * `aria-live="polite"` 로 충분하다.
 *
 * 색은 여기서도 세 신호 중 하나다: 빨강 + "입장 불가" + `✕` 글리프. 코드마다 문장이 따로 있는
 * 것도 같은 이유다 — "입장할 수 없습니다"만 읽은 관객은 왜인지 모르고, 모르면 스태프에게 묻고,
 * 그 줄은 멈춘다.
 *
 * `detail` 은 사람에게 읽히라고 있는 것이 아니라 **적어가라고** 있다. 문장 아래 작게 둔다.
 */
export function DenyCard({ code, detail, onDone }: DenyCardProps): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-card gate-card--deny" role="alert">
      <h2 className="gate-card__label">
        <span className="gate-card__glyph" aria-hidden="true">✕</span>
        {copy.denyTitle}
      </h2>
      <p className="gate-card__name">{copy.deny[code]}</p>
      {detail === undefined || detail === '' ? null : <p className="gate-card__detail">{detail}</p>}
      {onDone === undefined ? null : (
        <div className="gate-card__actions">
          <Button variant="ghost" onClick={onDone}>{copy.done}</Button>
        </div>
      )}
    </div>
  );
}
