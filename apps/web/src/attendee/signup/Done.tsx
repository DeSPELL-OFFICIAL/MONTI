import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Done() {
  const copy = useCopy();
  return <Screen title={copy.signup.doneTitle}>{copy.signup.doneCta}</Screen>;
}
