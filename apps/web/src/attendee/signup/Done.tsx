import { useNavigate } from 'react-router-dom';
import { Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { clearSignup } from './useSignup';

/** The end of signup: the phone number, the passkey and this phone are all attached. */
export function Done() {
  const copy = useCopy();
  const navigate = useNavigate();
  return (
    <Screen title={copy.signup.doneTitle}>
      <p>{copy.signup.doneBody}</p>
      <Button
        onClick={() => {
          // Nothing in there is needed again, and leaving it behind would let a reload drop
          // the attendee back into a half-finished signup.
          clearSignup();
          navigate('/');
        }}
      >
        {copy.signup.doneCta}
      </Button>
    </Screen>
  );
}
