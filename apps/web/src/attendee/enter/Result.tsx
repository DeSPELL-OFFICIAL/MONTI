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
// a spinner that can run all night. There is no refusal path here on purpose: a check-in the
// contract reverts emits no event and triggers no webhook, so a door that says no is silence,
// and silence is what the deadline reports.
import { useCallback, useEffect, useState } from 'react';
import { numberToHex, type Hex } from 'viem';
// `CheckInPush` is the wire shape of the webhook's FCM payload and lives in `@monti/shared`
// with the other shapes the backend and this app both have to agree on. `late` is live as of
// the 01b redeploy, and it changes nothing here: 01b emits `CheckedIn` alongside
// `CheckedInLate` on the late path, so the payload's arrival is already the confirmation.
import { CLOCK_SKEW_SECONDS, CODE_WINDOW_SECONDS, type CheckInPush } from '@monti/shared';
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
/**
 * The names that mean "this ticket was admitted", listed rather than taken from every key of
 * `USED_EVENTS.Ticket` — that manifest covers every Ticket event this app subscribes to
 * anywhere, and it also carries `EventCreated`, whose first indexed argument is an `eventId`
 * sitting in the same `topic1` position this filter matches `tokenId` in. Globbing the
 * manifest would turn this screen green on somebody else's new event. `satisfies` keeps the
 * list honest: a name renamed in the manifest fails to compile here.
 */
const CHECK_IN_EVENTS = ['CheckedIn', 'CheckedInLate'] as const satisfies readonly (keyof typeof USED_EVENTS.Ticket)[];

export function checkedInTopics(tokenId: string): (Hex | Hex[] | null)[] | null {
  const signatures = CHECK_IN_EVENTS
    .map((eventName) => eventTopic('Ticket', eventName))
    .filter((topic): topic is Hex => topic !== null);
  // `null`, never `[]`: a node reads an empty `topic0` as "match any topic0", which would turn
  // this screen green on the next `Transfer` the contract emits for this ticket.
  if (signatures.length === 0) return null;
  return [signatures, numberToHex(BigInt(tokenId), { size: 32 })];
}

// Ruling 4: `registerPush` runs once per app run, the first time someone reaches this screen
// with an account. It raises the OS permission prompt, and a person who said no must not be
// asked again by a re-render, a second ticket, or a second tap. So the registration is a
// module-level fact and every mounted result screen listens to the one handler it installed.
const pushListeners = new Set<(data: Record<string, string>) => void>();
let pushStarted = false;

function joinEntryPush(account: Hex | undefined, listener: (data: Record<string, string>) => void): () => void {
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

type Outcome = { kind: 'waiting' } | { kind: 'done'; stage: LogStage } | { kind: 'failed' };

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

  // Only from `waiting`: the deadline never talks over a confirmation that already landed.
  const giveUp = useCallback((): void => {
    setOutcome((prev) => (prev.kind === 'waiting' ? { kind: 'failed' } : prev));
  }, []);

  useEffect(() => {
    let live = true;
    const topics = checkedInTopics(tokenId);
    const stopLogs = topics
      ? subscribeLogs({
          address: getConfig().addresses.ticket,
          topics,
          onLog: (entry) => admit(entry.stage),
        })
      : () => undefined;

    // The one-shot read, for the tap that landed before the subscription opened. A check-in
    // already sitting in storage when this screen mounts is a recorded fact, not something on
    // its way, so it lights the green settled: "기록하고 있어요" under an entry finalized an hour
    // ago would never stop being wrong. The live speculative → finalized transition belongs to
    // the log subscription, which is the only source that can actually observe it.
    void Promise.resolve()
      .then(() => readTicket().checkInOf(BigInt(tokenId)))
      .then((checkIn) => {
        if (live && checkIn.ts > 0n) admit('finalized');
      })
      .catch(() => undefined);

    // The webhook fires only on `CheckedIn`, so the payload's arrival is the confirmation.
    const stopPush = joinEntryPush(account, (data) => {
      const push = data as Partial<CheckInPush>;
      if (!live || push.tokenId !== tokenId) return;
      admit('finalized');
    });

    return () => {
      live = false;
      stopLogs();
      stopPush();
    };
  }, [tokenId, account, admit]);

  // Its own effect, keyed on the ticket alone: signing in during `waiting` changes `account` and
  // would otherwise restart the 65 s from zero, which is the one thing a deadline may not do.
  useEffect(() => {
    const deadline = setTimeout(giveUp, WAITING_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [tokenId, giveUp]);

  if (outcome.kind === 'waiting') {
    return (
      <>
        <Spinner />
        <p>{copy.enter.resultWaiting}</p>
      </>
    );
  }

  if (outcome.kind === 'failed') {
    // The only failure this screen can know about. A refused check-in emits no event and sends
    // no push, so "the door did not confirm" is the whole of what is known — and it is the
    // sentence that gets the person to the one place that does know, the staff desk.
    return (
      <div data-testid="entry-result" data-stage="failed">
        <Alert tone="error">{copy.enter.notConfirmed}</Alert>
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
