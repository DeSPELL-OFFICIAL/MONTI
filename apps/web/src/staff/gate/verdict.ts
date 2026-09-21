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

import { USED_EVENTS, eventTopic } from '../../shared/chain/abis';
import { readTicket } from '../../shared/chain/reads';
import { subscribeLogs, type ChainLog } from '../../shared/chain/subscribeLogs';
import { getConfig } from '../../shared/config';
import type { Verdict } from './machine';

/** What `subscribeLogs` hands back: stop listening. */
export type LogSubscription = () => void;

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
  const signatures = Object.keys(USED_EVENTS.Ticket)
    .map((eventName) => eventTopic('Ticket', eventName))
    .filter((topic): topic is Hex => topic !== null);
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

export interface WatchCheckedInParams {
  /** `CheckedIn`'s first indexed parameter — what the topic filter narrows to. */
  tokenId: bigint;
  /** The nonce of the gate code this tap answered. What the verdict is matched on. */
  nonce: Hex;
  /** Feed it straight to `GateMachine.onVerdict`; the `Verdict` already names its tap. */
  onVerdict: (verdict: Verdict) => void;
}

/**
 * Watches for this tap's admission and answers at most once per stage.
 *
 * Monad reports the same log at each commit stage, so the gate turns green on `speculative`
 * (~0.7 s) and hardens when `finalized` repeats it (~1.3 s, spec §7.2 step 8) — the machine
 * takes the second as an upgrade rather than a second verdict. Stopping unsubscribes and
 * silences anything still in flight, so a watch left over from the previous attendee cannot
 * answer onto this one's screen.
 */
export function watchCheckedIn({ tokenId, nonce, onVerdict }: WatchCheckedInParams): LogSubscription {
  const expected = nonceHashOf(nonce).toLowerCase();
  let live = true;

  const admit = (finalized: boolean, blockNumber?: bigint): void => {
    if (!live) return;
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
