import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Phone() {
  const copy = useCopy();
  return <Screen title={copy.signup.phoneTitle}>{copy.signup.phoneHint}</Screen>;
}
