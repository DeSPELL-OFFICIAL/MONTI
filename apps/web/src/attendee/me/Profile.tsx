import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Profile() {
  const copy = useCopy();
  return <Screen title={copy.me.title}>{copy.me.language}</Screen>;
}
