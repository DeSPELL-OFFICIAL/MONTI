import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Verify() {
  const copy = useCopy();
  return <Screen title={copy.signup.codeTitle}>{copy.signup.verifyCta}</Screen>;
}
