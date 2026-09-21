import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function ChatRoom() {
  const copy = useCopy();
  return <Screen title={copy.chats.title}>{copy.chats.placeholder}</Screen>;
}
