import { useLocation } from 'react-router-dom';
import { Screen, Button, Alert } from '../shared/ui';
import { useCopy } from '../shared/i18n';

export function Login() {
  const copy = useCopy();
  // Signup sends an already-registered number here with the sentence to show, so the attendee
  // is not dropped on a bare sign-in screen wondering what happened.
  const notice = (useLocation().state as { notice?: string } | null)?.notice;

  return (
    <Screen title={copy.login.title}>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <p>{copy.login.body}</p>
      <Button>{copy.login.cta}</Button>
    </Screen>
  );
}
