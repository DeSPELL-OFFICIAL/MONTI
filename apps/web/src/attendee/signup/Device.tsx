import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function DeviceStep() {
  const copy = useCopy();
  return <Screen title={copy.signup.deviceTitle}>{copy.signup.deviceBody}</Screen>;
}
