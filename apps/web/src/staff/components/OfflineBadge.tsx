import type { ReactElement } from 'react';

import { fmt } from '../../shared/i18n';
import { useStaffCopy } from '../copy';
import { snapshotAgeLine } from './StaffShell';

export interface OfflineBadgeProps {
  online: boolean;
  snapshotAgeMs: number;
  queuedCount?: number;
}

/**
 * 연결이 끊겼다는 것을, 머리글의 한 줄보다 크게.
 *
 * 머리글에도 같은 낱말이 있지만 그건 상태 줄이고 이건 배너다. 오프라인 입장은 명단 하나만
 * 믿고 내리는 판정이라(스펙 §7.4), 그 명단이 얼마나 묵었는지가 곧 이 문이 얼마나 틀릴 수
 * 있는지다. 그래서 나이를 숨기지 않고 배너 안에 같이 적는다.
 *
 * 연결이 살아 있으면 아무것도 그리지 않는다 — 정상은 화면을 차지할 이유가 없다.
 */
export function OfflineBadge({ online, snapshotAgeMs, queuedCount }: OfflineBadgeProps): ReactElement | null {
  const copy = useStaffCopy();
  if (online) return null;

  return (
    <div className="gate-badge">
      <span>{copy.shell.stageOffline}</span>
      <span>{snapshotAgeLine(copy, snapshotAgeMs)}</span>
      {queuedCount !== undefined && queuedCount > 0 ? (
        <span>{fmt(copy.queue.pending, { count: queuedCount })}</span>
      ) : null}
    </div>
  );
}
