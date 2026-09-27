import { Alert } from '../shared/ui';
import { useOrganizerCopy } from './copy';

/**
 * Shown only to an organiser, and only while their writes are not sponsored yet.
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
 * The notice reads in plain words now (T-EV-W14); `copy.test.ts` keeps the whole organiser copy
 * free of attendee-banned vocabulary.
 */
export function UnsponsoredNotice() {
  const copy = useOrganizerCopy().unsponsored;
  return (
    <Alert tone="warn">
      {copy.notice} {copy.help}
    </Alert>
  );
}
