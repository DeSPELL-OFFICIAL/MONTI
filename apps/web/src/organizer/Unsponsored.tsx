import { Alert } from '../shared/ui';
import { useOrganizerCopy } from './copy';

/**
 * The one notice this app is allowed that vocabulary in — and it is only ever shown to an
 * organiser. Until sub-plan 01b puts the organiser selectors on the paymaster's allowlist,
 * every write on these screens is refused while it is still being simulated, so the honest
 * thing is to say what is missing rather than "try again in a moment".
 *
 * The sentence lives in `copy.wizard` because the wizard said it first and there is only one
 * of it; `copy.test.ts` allows that single string and no other.
 */
export function UnsponsoredNotice() {
  const copy = useOrganizerCopy().wizard;
  return (
    <Alert tone="warn">
      {copy.unsponsored} {copy.unsponsoredHelp}
    </Alert>
  );
}
