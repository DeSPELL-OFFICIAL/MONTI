import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Discover() {
  const copy = useCopy();
  return <Screen title={copy.discover.title}>{copy.discover.empty}</Screen>;
}
