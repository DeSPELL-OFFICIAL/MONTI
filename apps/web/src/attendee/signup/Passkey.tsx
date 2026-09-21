import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function PasskeyStep() {
  const copy = useCopy();
  return <Screen title={copy.signup.passkeyTitle}>{copy.signup.passkeyBody}</Screen>;
}
