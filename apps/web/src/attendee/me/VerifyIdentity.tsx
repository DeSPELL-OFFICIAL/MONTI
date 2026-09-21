import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function VerifyIdentity() {
  const copy = useCopy();
  return <Screen title={copy.kyc.title}>{copy.kyc.body}</Screen>;
}
