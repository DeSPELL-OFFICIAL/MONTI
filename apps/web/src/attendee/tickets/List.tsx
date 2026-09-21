import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function TicketList() {
  const copy = useCopy();
  return <Screen title={copy.tickets.title}>{copy.tickets.empty}</Screen>;
}
