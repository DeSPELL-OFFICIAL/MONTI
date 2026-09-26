import type { ReactElement } from 'react';

import { Alert } from '../../shared/ui';
import { useStaffCopy } from '../copy';

export interface StaleDoorBannerProps {
  /** `gateOpen` 이 체인이 아니라 이 단말기의 기억에서 나왔다. */
  stale?: boolean;
}

/**
 * 이 문이 **지난번 답으로** 열려 있다는 알림.
 *
 * 문을 닫아 버리는 것보다는 여는 쪽이 낫다 — 장소의 통신이 끊겼다고 모든 관객을 돌려보내는
 * 것이 더 나쁜 고장이다. 하지만 한 시간 전에 읽은 권한은 한 시간 전에 대한 사실이고, 폰을 쥔
 * 사람은 그것을 되돌아온 거절의 줄에서가 아니라 여기서 알아야 한다.
 *
 * 판정이 아니라 상태이므로 `OfflineBadge`·`QueueBanner` 와 같은 배너 자리에 산다. 예전에는
 * 단추 두 개 사이(푸터)에 끼어 있었다.
 */
export function StaleDoorBanner({ stale }: StaleDoorBannerProps): ReactElement | null {
  const copy = useStaffCopy();
  if (!stale) return null;
  return <Alert tone="warn">{copy.setup.gateOpenStale}</Alert>;
}
