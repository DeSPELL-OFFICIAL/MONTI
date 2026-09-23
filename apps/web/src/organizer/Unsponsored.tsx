import { Alert } from '../shared/ui';
import { useOrganizerCopy } from './copy';

/**
 * The one notice this app is allowed that vocabulary in — and it is only ever shown to an
 * organiser.
 *
 * It used to be the normal outcome: before 01b's redeploy (2026-09-23) no organiser selector
 * was on the paymaster's allowlist, so every write on these screens was refused while it was
 * still being simulated. That is over — the redeployed paymaster seeds 29 selectors, the
 * organiser's among them (`createOrganizer`, `transferOwner`, `revokeGate`, `Ticket.revoke`,
 * the gate toggles, the event lifecycle). So this is now the DEFENSIVE path, not the expected
 * one: it fires when the platform budget is spent, when the deployer has turned a selector off
 * with `setAllowed`, or on a bundler AA33. Keep it — those three are real and otherwise
 * surface as "try again in a moment", which is the one thing that will not help.
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
