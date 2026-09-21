import type { ReactElement } from 'react';

import { fmt } from '../../shared/i18n';
import { Button } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import { AttendeeFace, attendeeDetail } from './AdmitCard';

export interface OfflineAdmitCardProps {
  displayName: string;
  photoJpegB64?: string;
  tierLabel?: string;
  seat?: string;
  queuedCount: number;
  onDone?: () => void;
}

/**
 * 연결이 끊긴 채 들여보낸 입장.
 *
 * **이 카드는 초록이 될 수 없다.** 아직 어디에도 기록되지 않은 입장을 확정된 입장과 같은 색으로
 * 보여주면 스태프는 끝난 일로 읽고, 나중에 남은 큐를 보며 "이건 뭐지"를 묻게 된다. 그 순간
 * 손해를 보는 사람은 기록이 사라진 관객이다.
 *
 * 그래서 색만 바꾸지 않았다. 호박색 + "연결 없이 입장" + `!` 글리프에 더해 테두리를 두껍고
 * 점선으로 둔다 — 방 건너편에서, 색이 아니라 **모양**으로 먼저 구분되게. 여기 있는 숫자는
 * 아직 보내지 못한 입장의 수이고, 그게 이 카드가 존재하는 이유다.
 */
export function OfflineAdmitCard({
  displayName,
  photoJpegB64,
  tierLabel,
  seat,
  queuedCount,
  onDone,
}: OfflineAdmitCardProps): ReactElement {
  const copy = useStaffCopy();
  const detail = attendeeDetail(tierLabel, seat);

  return (
    <div className="gate-card gate-card--offline-admit">
      <h2 className="gate-card__label">
        <span className="gate-card__glyph" aria-hidden="true">!</span>
        {copy.offlineAdmit.title}
      </h2>
      <AttendeeFace copy={copy} displayName={displayName} photoJpegB64={photoJpegB64} />
      <div className="gate-card__body">
        <p className="gate-card__name">{displayName}</p>
        {detail === '' ? null : <p className="gate-card__detail">{detail}</p>}
        <p className="gate-card__line">{copy.offlineAdmit.note}</p>
        <p className="gate-card__line">{fmt(copy.queue.pending, { count: queuedCount })}</p>
      </div>
      {onDone === undefined ? null : (
        <div className="gate-card__actions">
          <Button variant="ghost" onClick={onDone}>{copy.done}</Button>
        </div>
      )}
    </div>
  );
}
