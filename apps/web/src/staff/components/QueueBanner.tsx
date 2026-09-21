import type { ReactElement } from 'react';

import { fmt } from '../../shared/i18n';
import { useStaffCopy } from '../copy';
import { DRY_RUN_MARK, LATE_WINDOW_ELAPSED } from '../queue/opQueue';

export interface QueueBannerProps {
  pendingCount: number;
  parkedCount: number;
  lastError?: string;
}

/**
 * 아직 보내지 못한 입장 기록.
 *
 * 큐에 무엇이 남아 있는지를 스태프가 실시간으로 볼 수 있어야 하는 이유는, 그 숫자가 **이미
 * 들어간 사람들**이기 때문이다. 보낼 게 남았는데 단말기를 끄면 그만큼이 사라진다.
 *
 * 실패 사유를 문장으로 바꾸는 것은 딱 두 가지뿐이다. `LATE_WINDOW_ELAPSED` 와 `DRY_RUN_MARK`
 * 는 **기다려도 저절로 나가지 않는** 상태라, 그걸 말해주지 않으면 스태프는 연결이 돌아오기만
 * 기다리다 행사를 끝낸다. 그 밖의 `lastError` 는 재시도로 풀리는 전송 실패이므로 자기 문장을
 * 갖지 않는다 — 스스로 해결될 일에 사람을 부르는 배너는 다음번 진짜 문제도 무시당하게 만든다.
 *
 * 같은 이유로 "연결이 돌아오면 저절로 보내요"는 그 두 상태에서는 나오지 않는다. 지킬 수 없는
 * 약속이다.
 */
export function QueueBanner({ pendingCount, parkedCount, lastError }: QueueBannerProps): ReactElement | null {
  const copy = useStaffCopy();
  if (pendingCount === 0 && parkedCount === 0 && lastError === undefined) return null;

  const stuck =
    lastError === LATE_WINDOW_ELAPSED
      ? copy.queue.lateWindowElapsed
      : lastError === DRY_RUN_MARK
        ? copy.queue.lateUnavailable
        : undefined;

  return (
    <div className="gate-banner">
      {pendingCount > 0 ? (
        <span className="gate-banner__count">{fmt(copy.queue.pending, { count: pendingCount })}</span>
      ) : null}
      {parkedCount > 0 ? (
        <span className="gate-banner__stopped">{fmt(copy.queue.parked, { count: parkedCount })}</span>
      ) : null}
      {stuck === undefined ? <span>{copy.queue.sending}</span> : <span>{stuck}</span>}
    </div>
  );
}
