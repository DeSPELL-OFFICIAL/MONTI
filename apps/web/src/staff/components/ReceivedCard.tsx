import type { ReactElement } from 'react';

import { useStaffCopy, type StaffCopy } from '../copy';
import type { PrecheckResult } from '../types';

const PRECHECK_LINE: Record<PrecheckResult, keyof StaffCopy['received']> = {
  ok: 'precheckOk',
  unknown: 'precheckUnknown',
  fail: 'precheckFail',
};

export interface ReceivedCardProps {
  tokenIdMasked: string;
  precheck: PrecheckResult;
}

/**
 * 표를 받았고, 아직 보내기 전. 아주 짧게 스쳐 가는 화면이지만 지워버릴 수는 없다 — 이게 없으면
 * 스태프는 탭이 읽혔는지 아닌지를 모르는 채로 "확인 중입니다"를 만난다.
 *
 * 표 번호는 마스킹된 채로 들어온다. 이 카드는 관객이 같이 보는 화면이고, 앞사람 화면에 남은
 * 번호를 다음 사람이 그대로 읽어가는 일이 없어야 한다.
 */
export function ReceivedCard({ tokenIdMasked, precheck }: ReceivedCardProps): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-card gate-card--received">
      <h2 className="gate-card__label">{copy.received.title}</h2>
      <p className="gate-card__facts">
        <span>{copy.received.ticketLabel}</span>
        <span className="gate-card__value">{tokenIdMasked}</span>
      </p>
      <p className="gate-card__line">{copy.received[PRECHECK_LINE[precheck]]}</p>
    </div>
  );
}
