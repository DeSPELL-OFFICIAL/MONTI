import { Screen, Button } from '../shared/ui';
import { useCopy } from '../shared/i18n';

export function Login() {
  const copy = useCopy();
  return (
    <Screen title={copy.login.title}>
      <p>{copy.login.body}</p>
      <Button>{copy.login.cta}</Button>
    </Screen>
  );
}
