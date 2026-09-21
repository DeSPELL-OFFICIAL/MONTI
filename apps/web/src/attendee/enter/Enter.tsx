import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Enter() {
  const copy = useCopy();
  return <Screen title={copy.enter.cta}>{copy.enter.tapGuide}</Screen>;
}
