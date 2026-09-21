// Entry, step 3 (spec §7.2 steps 7-8): what the attendee sees once the answer has been handed
// over. The tap is finished; from here the phone is only a witness.
//
// Two sources say the entry happened, and the screen must reconcile them rather than prefer one:
//
//   (a) the chain — a `CheckedIn` log for this tokenId, which Monad reports first as
//       `speculative` (~0.7 s) and again as `finalized` (~1.3 s), plus a single `checkInOf`
//       read on mount, because the staff device may have written the check-in before this
//       subscription was open and a log already past is a log that never arrives;
//   (b) the push the backend's Tenderly webhook sends, which is the path that still works when
//       this phone's WebSocket is the thing that is broken.
//
// Whichever lands first turns the screen green; the other is then ignored. Neither is treated
// as authority: spec §3 principle 4 makes the attendee's green informational — the staff screen
// and the chain are the record — which is also why the waiting state has a deadline instead of
// a spinner that can run all night.
import { useCallback, useEffect, useState } from 'react';
import { numberToHex, type Hex } from 'viem';
import {
  CLOCK_SKEW_SECONDS,
  CODE_WINDOW_SECONDS,
  isGateDenyCode,
  type GateDenyCode,
} from '@monti/shared';
import { Alert, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { USED_EVENTS, eventTopic } from '../../shared/chain/abis';
import { subscribeLogs, type LogStage } from '../../shared/chain/subscribeLogs';
import { readTicket } from '../../shared/chain/reads';
import { getConfig } from '../../shared/config';
import { registerPush } from '../../shared/push';
import { useSession } from '../../shared/session';

/**
 * How long `waiting` may last: one gate code window plus the skew the contract itself allows.
 * Past that the code the gate issued can no longer be checked in at all, so nothing is still
 * on its way and a spinner would be a lie (ruling 2 — never spin forever).
 */
export const WAITING_DEADLINE_MS = (CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) * 1_000;

/**
 * The log filter: any of the check-in events, for this tokenId only.
 *
 * `topic0` is an array because the 01b redeploy splits check-in in two — a tap recorded outside
 * the code window is emitted as `CheckedInLate` — and an attendee admitted that way must still
 * see the green. {@link eventTopic} answers `null` for an event the deployed ABI does not carry,
 * so today the array holds one signature and the day the ABI lands it holds two, with no change
 * here. `tokenId` is `CheckedIn`'s first indexed parameter, so it is `topic1`.
 */
export function checkedInTopics(tokenId: string): (Hex | Hex[] | null)[] {
  const signatures = Object.keys(USED_EVENTS.Ticket)
    .map((eventName) => eventTopic('Ticket', eventName))
    .filter((topic): topic is Hex => topic !== null);
  return [signatures, numberToHex(BigInt(tokenId), { size: 32 })];
}

type PushData = Record<string, string>;

// Ruling 4: `registerPush` runs once per app run, the first time someone reaches this screen
// with an account. It raises the OS permission prompt, and a person who said no must not be
// asked again by a re-render, a second ticket, or a second tap. So the registration is a
// module-level fact and every mounted result screen listens to the one handler it installed.
const pushListeners = new Set<(data: PushData) => void>();
let pushStarted = false;

function joinEntryPush(account: Hex | undefined, listener: (data: PushData) => void): () => void {
  pushListeners.add(listener);
  if (account && !pushStarted) {
    pushStarted = true;
    // Never rejects — a refused permission, an unsupported browser and a refused token write
    // all come back as `{ status: 'unavailable' }`, and all three are a silent no-op here: the
    // chain path is what decides. The catch is for a platform that throws before it can answer.
    void registerPush(account, (data) => {
      for (const each of [...pushListeners]) each(data);
    }).catch(() => undefined);
  }
  return () => {
    pushListeners.delete(listener);
  };
}

/** Test-only: the registration is a per-app-run fact, and a test file is a new run. */
export function resetEntryPush(): void {
  pushStarted = false;
  pushListeners.clear();
}

type Outcome =
  | { kind: 'waiting' }
  | { kind: 'done'; stage: LogStage }
  | { kind: 'failed'; deny: GateDenyCode | null };

export function Result({ tokenId }: { tokenId: string }) {
  const copy = useCopy();
  const account = useSession().account;
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'waiting' });

  // Spec §7.2 step 8: light up on the speculative log, harden on the finalized one, and never
  // step backwards — the same log is reported at each commit stage and they can arrive out of
  // order. A confirmation also overrules a failure: the deadline is a guess about the network,
  // the chain is the record, and sending someone to the desk who is already in is the worse
  // of the two mistakes.
  const admit = useCallback((stage: LogStage): void => {
    setOutcome((prev) => (prev.kind === 'done' && prev.stage === 'finalized' ? prev : { kind: 'done', stage }));
  }, []);

  // Only from `waiting`: a refusal never talks over a confirmation, and the deadline never
  // talks over the gate's own reason for refusing.
  const refuse = useCallback((deny: GateDenyCode | null): void => {
    setOutcome((prev) => (prev.kind === 'waiting' ? { kind: 'failed', deny } : prev));
  }, []);

  useEffect(() => {
    let live = true;
    const stopLogs = subscribeLogs({
      address: getConfig().addresses.ticket,
      topics: checkedInTopics(tokenId),
      onLog: (entry) => admit(entry.stage),
    });

    // The one-shot read. `readContract` resolves against the latest block, which on Monad is a
    // speculative one, so it lights the green in the same state a speculative log would — a
    // finalized log still hardens it. An unreachable chain is not an answer: the subscription
    // and the push are still running.
    void Promise.resolve()
      .then(() => readTicket().checkInOf(BigInt(tokenId)))
      .then((checkIn) => {
        if (live && checkIn.ts > 0n) admit('speculative');
      })
      .catch(() => undefined);

    const stopPush = joinEntryPush(account, (data) => {
      if (!live || data.tokenId !== tokenId) return;
      const deny = data.deny;
      if (!deny) {
        admit('finalized');
        return;
      }
      // Ruling 2: a `'TIMEOUT'` from the staff's write is "no answer yet", not a refusal —
      // `isGateDenyCode` does not accept it, so the screen keeps waiting for one of the two
      // sources or for the deadline.
      if (isGateDenyCode(deny)) refuse(deny);
    });

    const deadline = setTimeout(() => refuse(null), WAITING_DEADLINE_MS);

    return () => {
      live = false;
      stopLogs();
      stopPush();
      clearTimeout(deadline);
    };
  }, [tokenId, account, admit, refuse]);

  if (outcome.kind === 'waiting') {
    return (
      <>
        <Spinner />
        <p>{copy.enter.resultWaiting}</p>
      </>
    );
  }

  if (outcome.kind === 'failed') {
    return (
      <div data-testid="entry-result" data-stage="failed">
        <Alert tone="error">{outcome.deny ? copy.enter.deny[outcome.deny] : copy.enter.notConfirmed}</Alert>
      </div>
    );
  }

  return (
    <div data-testid="entry-result" data-stage={outcome.stage}>
      <Alert tone="info">{copy.enter.done}</Alert>
      {outcome.stage === 'speculative' ? <p>{copy.enter.resultSettling}</p> : null}
    </div>
  );
}
