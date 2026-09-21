import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function TransferRecipient() {
  const copy = useCopy();
  return <Screen title={copy.transfer.title}>{copy.transfer.confirmTitle}</Screen>;
}
