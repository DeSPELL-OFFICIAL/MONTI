import type { ReactElement } from 'react';

import { useStaffCopy, type StaffCopy } from '../copy';
import type { SettledTap } from '../gate/machine';

const STATE_WORD: Record<SettledTap['state'], keyof StaffCopy['lastTap']> = {
  admit: 'admit',
  offlineAdmit: 'offlineAdmit',
  deny: 'deny',
};

export interface LastTapChipProps {
  lastTap?: SettledTap;
}

/**
 * 직전 탭.
 *
 * 다음 관객을 받기 시작하면 판정 영역은 비워진다. 그 순간 게이트가 방금 무엇을 했는지 아는
 * 곳이 한 군데도 없으면, "방금 그 사람 들어간 거 맞아요?"라는 질문에 스태프가 답할 방법이
 * 없다 — 이미 지나간 사람을 다시 세우거나, 그냥 통과시키거나 둘 중 하나가 된다. 한 줄이지만
 * 이 줄이 그 질문에 답한다.
 *
 * 거절이었다면 사유까지 남긴다. 거절은 다시 물어보러 오는 유일한 판정이다.
 */
export function LastTapChip({ lastTap }: LastTapChipProps): ReactElement {
  const copy = useStaffCopy();

  if (lastTap === undefined) {
    return <p className="gate-last-tap">{copy.lastTap.none}</p>;
  }

  const name = lastTap.ticket?.displayName;
  return (
    <p className="gate-last-tap">
      <span>{copy.lastTap.label}</span>
      <span className="gate-last-tap__state">{copy.lastTap[STATE_WORD[lastTap.state]]}</span>
      {name === undefined || name === '' ? null : <span>{name}</span>}
      {lastTap.state === 'deny' && lastTap.deny !== undefined ? (
        <span>{copy.deny[lastTap.deny]}</span>
      ) : null}
    </p>
  );
}
