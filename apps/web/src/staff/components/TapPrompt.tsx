import type { ReactElement } from 'react';

import { useStaffCopy } from '../copy';

export interface TapPromptProps {
  rotating: boolean;
}

/**
 * 다음 관객을 기다리는 화면.
 *
 * `rotating` 은 **문구를 좌우하지 않는다.** 게이트가 코드를 내주고 있다는 사실은 장식하는 원
 * 하나로만 드러나고(`aria-hidden`), 문장은 어느 쪽이든 그대로다. 회전이 잠깐 멈췄다고 "대지
 * 마세요"라고 말하면 스태프는 줄을 세우고, 코드는 몇백 밀리초 뒤에 다시 나온다 — 화면이 멈춘
 * 것도 아닌데 문이 멈춘다.
 */
export function TapPrompt({ rotating }: TapPromptProps): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-card gate-card--ready">
      <span className="gate-card__pulse" aria-hidden="true" data-rotating={rotating ? 'on' : 'off'} />
      <h2 className="gate-card__headline">{copy.ready.tap}</h2>
      <p className="gate-card__hint">{copy.ready.hint}</p>
    </div>
  );
}
