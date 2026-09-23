import { Alert } from '../shared/ui';
import { useOrganizerCopy } from './copy';

/**
 * The one notice this app is allowed that vocabulary in — and it is only ever shown to an
 * organiser. Until sub-plan 01b puts the organiser selectors on the paymaster's allowlist,
 * every write on these screens is refused while it is still being simulated, so the honest
 * thing is to say what is missing rather than "try again in a moment".
 *
 * The two sentences are a group of their own; `copy.test.ts` allows that single string and no
 * other anywhere in the organiser copy.
 */
export function UnsponsoredNotice() {
  const copy = useOrganizerCopy().unsponsored;
  return (
    <Alert tone="warn">
      {copy.notice} {copy.help}
    </Alert>
  );
}
