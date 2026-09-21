import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

// Task 21이 이 화면을 실제 티켓 받기 흐름으로 교체한다. 여기서는 라우트만 확정한다.
export function Claim() {
  const copy = useCopy();
  return <Screen title={copy.claim.cta}>{copy.common.loading}</Screen>;
}
