import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function EventDetail() {
  const copy = useCopy();
  return <Screen title={copy.discover.title}>{copy.discover.publicRecord}</Screen>;
}
