// The chain's answer, and the only thing in this app allowed to turn a tap green.
//
// Task 23's machine holds the line that nothing else may admit; this is the other half — the
// one source that can actually know. Three rules shape every line below, and each of them is a
// door that opens for the wrong person if it is got wrong.
//
// **The nonce is the identity, never the ticket.** `CheckedIn` is indexed by `tokenId`, so a
// topic filter can select this ticket's logs — but a ticket can be tapped twice inside one code
// window, and the second tap's log would then confirm the first. What says *which tap* a log
// answers is `nonceHash = keccak256(abi.encode(nonce))` in the log body (`Ticket.sol:360`), of
// the code this gate served. So the filter narrows and the hash decides.
//
// **A log that already went past never arrives.** A gate whose socket connects a second late
// sees nothing, and a screen waiting on a subscription would confirm forever. So the watch also
// reads `checkInOf(tokenId)` once when it opens: a check-in sitting in storage is a recorded
// fact, and the same nonce test applies to it.
//
// **Silence is not a refusal.** Nothing here produces a DENY. A `'TIMEOUT'` from
// `sendSponsoredOp.wait()` means the op has not landed yet, not that it failed — the watch stays
// open and a `CheckedIn` at six seconds still admits (spec §7.3, Task 21 ruling 3).
import { decodeAbiParameters, hexToBigInt, keccak256, numberToHex, type Hex } from 'viem';

import { OVERRIDE_ROLE } from '@monti/shared';

import { eventTopic } from '../../shared/chain/abis';
import { readTicket } from '../../shared/chain/reads';
import { subscribeLogs, type ChainLog } from '../../shared/chain/subscribeLogs';
import { getConfig } from '../../shared/config';
import type { TapId, Verdict } from './machine';
import type { OverrideRole } from '../types';

/**
 * What `subscribeLogs` hands back: stop listening. Derived rather than re-declared, so there is
 * one spelling of this type and it cannot drift from the function that produces it.
 */
export type LogSubscription = ReturnType<typeof subscribeLogs>;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * What the contract writes into the log for a code with this nonce:
 * `keccak256(abi.encode(g.nonce))` (`Ticket.sol:360`). `abi.encode` of a `bytes32` is those 32
 * bytes, so this is `keccak256(nonce)` — and the length is checked rather than trusted, because
 * viem would pad a short value and hash something no gate ever served. `BAD_NONCE` is the
 * spelling `@monti/shared`'s own preimage check uses for the same mistake.
 *
 * It is **keccak256 and not sha256**: `Ticket.checkIn` takes `sha256` over the *device digest*
 * two lines earlier, and reaching for the wrong one there is a gate that never turns green.
 */
export function nonceHashOf(nonce: Hex): Hex {
  if (!BYTES32.test(nonce)) throw new Error('BAD_NONCE');
  return keccak256(nonce);
}

/** `topic0` for `CheckedIn`, resolved once out of the generated ABI. */
const CHECKED_IN_TOPIC = eventTopic('Ticket', 'CheckedIn');

/**
 * The events that mean "this tap was taken". Named rather than taken from `USED_EVENTS.Ticket`
 * wholesale, because that map now also carries `ManualOverride` (Task 32) — an event about the
 * same ticket that answers a different question, and one a tap's filter must not widen to. The
 * split is the reason `checkedInTopics` below still returns exactly the check-in signatures.
 */
const CHECK_IN_EVENTS = ['CheckedIn', 'CheckedInLate'] as const;

/**
 * The log filter: any of the check-in events, for this ticket only.
 *
 * `topic0` is an array because the 01b redeploy splits check-in in two — a tap recorded outside
 * the code window is emitted as `CheckedInLate` as well — and `tokenId` is the only indexed
 * position the two events share (`CheckedIn` indexes `tokenId, eventId, gateId`; `CheckedInLate`
 * indexes `tokenId, gateId`). {@link eventTopic} answers `null` for an event the deployed ABI
 * does not carry, so today the array holds one signature and the day the ABI lands it holds two,
 * with no change here.
 */
export function checkedInTopics(tokenId: bigint): (Hex | Hex[] | null)[] | null {
  const signatures = CHECK_IN_EVENTS.map((eventName) => eventTopic('Ticket', eventName)).filter(
    (topic): topic is Hex => topic !== null,
  );
  // `null`, never `[]`: a node reads an empty `topic0` as "match any topic0", which would admit
  // on the next `Transfer` this ticket emits.
  if (signatures.length === 0) return null;
  return [signatures, numberToHex(tokenId, { size: 32 })];
}

/**
 * The nonce hash a log names, or `undefined` when it names none.
 *
 * Only `CheckedIn` carries one. `CheckedInLate` is `(uint64 issuedAt, uint64 ts)` in its body,
 * which would decode as a plausible-looking `bytes32` — so the event is identified by `topic0`
 * first and never by the shape of its data. It needs no special case beyond that: 01b emits
 * `CheckedIn` *alongside* it on the late path, and that is the log that names the tap.
 */
function nonceHashOfLog(log: ChainLog): Hex | undefined {
  const topic0 = log.topics[0];
  if (!CHECKED_IN_TOPIC || !topic0 || topic0.toLowerCase() !== CHECKED_IN_TOPIC.toLowerCase()) {
    return undefined;
  }
  try {
    const [nonceHash] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], log.data);
    return nonceHash as Hex;
  } catch {
    // A body this build cannot read is not an admit. Nothing else can be said about it.
    return undefined;
  }
}

/**
 * `subscribeLogs` forwards the JSON-RPC object as it came off `monadLogs` or `eth_getLogs`,
 * where `blockNumber` is a quantity hex string — viem's own log formatter never runs on it. The
 * staff screen prints this number, so both shapes have to land as the same value, and anything
 * else lands as "no block", which the machine renders as an admit without one.
 */
function blockNumberOf(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return hexToBigInt(value as Hex);
  return undefined;
}

/**
 * Watches for one tap's admission. Its shape is `GateMachine`'s `WatchFactory`, so the machine
 * passes this function itself and owns the handle — the screen that opens a watch cannot know
 * when the tap is done with it, and a gate leaking one subscription per attendee runs out of
 * socket long before the queue runs out of people.
 *
 * Monad reports the same log at each commit stage, so the gate turns green on `speculative`
 * (~0.7 s) and hardens when `finalized` repeats it (~1.3 s, spec §7.2 step 8) — the machine
 * takes the second as an upgrade rather than a second verdict. Stopping unsubscribes and
 * silences anything still in flight, so a watch left over from the previous attendee cannot
 * answer onto this one's screen.
 */
export function watchCheckedIn(tap: TapId, onVerdict: (verdict: Verdict) => void): LogSubscription {
  const { tokenId, nonce } = tap;
  const expected = nonceHashOf(nonce).toLowerCase();
  let live = true;
  let finalizedAnswered = false;

  const admit = (finalized: boolean, blockNumber?: bigint): void => {
    if (!live) return;
    // Never step backwards. Two sources answer here and they can land in either order: the
    // storage read says `finalized` about a check-in already written, while the subscription's
    // first log is `speculative`. Letting the second overwrite the first would take a settled
    // entry back to "still settling" on the staff screen.
    if (finalizedAnswered && !finalized) return;
    finalizedAnswered ||= finalized;
    onVerdict({ kind: 'admit', nonce, blockNumber, finalized });
  };

  const topics = checkedInTopics(tokenId);
  const stopLogs = topics
    ? subscribeLogs({
        address: getConfig().addresses.ticket,
        topics,
        onLog: (log) => {
          if (nonceHashOfLog(log)?.toLowerCase() !== expected) return;
          admit(log.stage === 'finalized', blockNumberOf(log.blockNumber));
        },
      })
    : () => undefined;

  // The one-shot read, for the watch that opened after the log had already gone past. A stored
  // check-in is a recorded fact rather than something on its way, so it admits settled — and
  // without a block number, because storage does not say which block wrote it. The live
  // speculative → finalized transition belongs to the subscription, the only source that can
  // observe it. A failed read is silence: the gate is offline, which is not a refusal.
  //
  // It runs on every watch, which is one `eth_call` per tap (Task 24 review V4). There is no
  // signal to skip it on: `subscribeLogs` returns before its socket subscription is open, so
  // "already live" is not a thing this side can ask. And the case it covers is the real ordering
  // — the wiring sends the check-in and only then opens the watch — where the alternative is a
  // green that never arrives at all. One extra read next to a sponsored user operation is not a
  // cost worth a guess. It is started *after* `subscribeLogs`, so the window it has to cover is
  // as small as it can be, and Task 26 must not read the same slot a second time.
  void Promise.resolve()
    .then(() => readTicket().checkInOf(tokenId))
    .then((checkIn) => {
      if (checkIn.ts > 0n && checkIn.nonceHash.toLowerCase() === expected) admit(true);
    })
    .catch(() => undefined);

  return () => {
    live = false;
    stopLogs();
  };
}

/** `topic0` for `ManualOverride`, resolved once out of the generated ABI. */
const MANUAL_OVERRIDE_TOPIC = eventTopic('Ticket', 'ManualOverride');

/**
 * Who approved a filed request. What `ManualOverride` carries beyond the ticket it is about.
 */
export interface OverrideApproval {
  approver: Hex;
  role: OverrideRole;
}

/** `Ticket.ROLE_*` back into the name the screen and the machine speak. */
function roleOf(code: number): OverrideRole {
  if (code === OVERRIDE_ROLE.approver) return 'approver';
  if (code === OVERRIDE_ROLE.manager) return 'manager';
  return 'none';
}

/**
 * Watches for **somebody else** approving a request this terminal filed (Task 32, ruling 2).
 *
 * A request is a backend record (`requestOverride` callable) and writes no check-in, so the screen that filed it
 * has nothing else to learn from: the tap watch above matches on a nonce and a manual approval
 * carries `bytes32(0)` there (`Ticket.sol:426`), which is exactly why that watch cannot be reused.
 * This one filters on the approval event itself, narrowed to this ticket by its indexed `tokenId`.
 *
 * Two differences from {@link watchCheckedIn}, both because of what it is watching for:
 *
 *  * **No one-shot storage read.** `checkInOf` would answer `manual: true` for an override filed
 *    last week by somebody else, and the question here is "was *this* request answered", asked
 *    from the moment it was filed. A subscription is the whole of it.
 *  * **The approver comes out of the log, not out of this device.** The screen must say what the
 *    chain says — `msg.sender` at the moment of approval — and that is a person this terminal
 *    has never heard of.
 *
 * Stopping unsubscribes, so an approval that lands after the staff member moved on says nothing.
 */
export function watchManualOverride(
  tokenId: bigint,
  onApproved: (approval: OverrideApproval) => void,
): LogSubscription {
  if (!MANUAL_OVERRIDE_TOPIC) return () => undefined;
  let live = true;
  let answered = false;

  const stopLogs = subscribeLogs({
    address: getConfig().addresses.ticket,
    topics: [MANUAL_OVERRIDE_TOPIC, numberToHex(tokenId, { size: 32 })],
    onLog: (log) => {
      if (!live || answered) return;
      // The approver is the third indexed parameter, so it is a topic rather than data: a 32-byte
      // word whose low 20 bytes are the address.
      const approverTopic = log.topics[3];
      if (typeof approverTopic !== 'string') return;
      try {
        const [role] = decodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }], log.data);
        answered = true;
        onApproved({
          approver: `0x${approverTopic.slice(-40)}` as Hex,
          role: roleOf(Number(role)),
        });
      } catch {
        // A body this build cannot read is not an approval, and saying nothing is the only
        // honest thing left: the request may still be open.
      }
    },
  });

  return () => {
    live = false;
    stopLogs();
  };
}
