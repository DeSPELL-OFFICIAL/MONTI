// A revert, turned into a sentence a staff member can say out loud.
//
// Nothing about the contracts is spelled by hand here. The NAMES come from the ABI
// (`CHECK_IN_ERRORS`, derived in `staff/types.ts`) and the four-byte selectors are computed from
// the ABI's own parameter types — never from a signature string typed in this file. That is the
// whole design: a selector spelled by hand goes on matching nothing the day sub-plan 01 renames
// an error, and a selector that matches nothing falls through to a generic failure, so the gate
// would quietly start showing the wrong screen instead of failing a test.
//
// The screens are the one thing a person still writes, in {@link CHECK_IN_DENY}, and the test
// beside this file holds them to the derived list: an error the contracts add arrives here as a
// red test rather than as a wrong screen at a door. That is how `NotMember` was missing —
// `manualOverride` reverts it, the frozen twelve had never heard of it, and the terminal showed
// the attendee a send failure for a permission problem of its own (Task 34).
//
// Nothing in this file can produce an admit. Every path out of `mapRevertToDenyCode` is a DENY
// — including the one for a revert whose selector this build has never seen, because a gate
// that cannot read the reason certainly cannot let someone in on it.
import { toFunctionSelector, type Hex } from 'viem';

import { ticketAbi } from '@monti/shared';

import { CHECK_IN_ERRORS, isGateDenyCode, type CheckInError, type DenyCode } from '../types';

/** The short line the screen shows. One per DENY code, and every one of them reachable. */
export const DENY_LABELS: Record<DenyCode, string> = {
  ALREADY_USED: 'Already checked in',
  WRONG_EVENT: 'Ticket for another event',
  REVOKED: 'Ticket cancelled',
  EXPIRED_CODE: 'Timed out · tap again',
  NO_TICKET: 'No ticket',
  GATE_CLOSED: 'Gate is closed',
  GATE_MISMATCH: 'Wrong gate for this device',
  EVENT_ENDED: 'Event has ended',
  EVENT_CANCELLED: 'Event cancelled',
  DEVICE_LOCKED: 'Phone locked',
  DEVICE_MISMATCH: 'Not a registered phone',
  TX_FAILED: "Couldn't send",
  UNKNOWN_REVERT: 'Refused (unknown reason)',
};

/**
 * Each error the gate can be handed, to the screen it becomes.
 *
 * The keys are `CHECK_IN_ERRORS`' — the ABI's — and `denyMap.test.ts` asserts the two sets are
 * equal in both directions: a name the contracts add with no screen here is a red test, and a
 * name here the contracts no longer declare is a screen nobody can reach.
 *
 * The last four are not about the attendee at all. `EventNotPublished` is an event still in
 * draft, `NotMember` a terminal the organizer has not put on their team, `Unauthorized` a call
 * this account is not allowed to make, and `BadGateSignature` a terminal whose gate key does not
 * match the one registered on chain — four configuration mistakes, none of them a bad ticket.
 * They map to `TX_FAILED` and earn their own sentence below, because showing a red refusal to a
 * ticket-holder whose only problem is somebody else's setup sends a paying customer away while
 * the fix is one action on another phone.
 */
export const CHECK_IN_DENY: Record<CheckInError, DenyCode> = {
  AlreadyCheckedIn: 'ALREADY_USED',
  WrongEvent: 'WRONG_EVENT',
  TicketRevoked: 'REVOKED',
  CodeExpired: 'EXPIRED_CODE',
  NoSuchTicket: 'NO_TICKET',
  GateNotOpen: 'GATE_CLOSED',
  GateMismatch: 'GATE_MISMATCH',
  DeviceLocked: 'DEVICE_LOCKED',
  BadDeviceSignature: 'DEVICE_MISMATCH',
  EventEnded: 'EVENT_ENDED',
  EventCancelled: 'EVENT_CANCELLED',
  EventNotPublished: 'TX_FAILED',
  NotMember: 'TX_FAILED',
  Unauthorized: 'TX_FAILED',
  // The relayed check-in now verifies the gate's own P-256 signature over the code on chain
  // (abi-delta-relayed.md §7); a key that does not match the registered `(kx, ky)` reverts
  // `BadGateSignature`. Like the other three it is a terminal-setup mistake, not the ticket.
  BadGateSignature: 'TX_FAILED',
};

/**
 * Where the default label is not enough to act on. `EventNotPublished` is the case the whole
 * mechanism exists for: it is not a bad ticket and there is nothing the attendee can do, so the
 * sentence has to point at the person who can fix it. `GateMismatch` likewise — the attendee is
 * fine and the terminal is pointed at the wrong gate.
 */
const DENY_DETAILS: Partial<Record<CheckInError, string>> = {
  EventNotPublished: "This event isn't published yet. Ask the organizer.",
  GateMismatch: "This gate device is set up for a different gate. Check its settings.",
  DeviceLocked: "The guest's phone is locked. Ask them to reset the app.",
  NotMember: "This gate device isn't on the organizer's team. It's not the guest's fault — ask the organizer.",
  Unauthorized: "This gate device isn't allowed to do that. It's not the guest's fault — ask the organizer.",
  BadGateSignature: "This gate device doesn't match the one registered. It's not the guest's fault — ask the organizer.",
};

/** `name` → 4-byte selector, computed from the generated ABI's own parameter types. */
const SELECTOR_BY_NAME = new Map<string, string>(
  ticketAbi.flatMap((entry) =>
    entry.type === 'error'
      ? [
          [
            entry.name,
            toFunctionSelector(
              `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})` as `${string}(${string})`,
            ).toLowerCase(),
          ] as [string, string],
        ]
      : [],
  ),
);

export interface DenyVerdict {
  code: DenyCode;
  /** What the staff member reads. Never empty, and never the bare selector when we know better. */
  detail: string;
}

/**
 * Each contract error name to the screen it becomes — the shared core both maps below are built
 * from, so a selector lookup and a name lookup can never come to disagree. A name with no screen is
 * a red test (`denyMap.test.ts` holds the two sets equal); at runtime it degrades to `UNKNOWN_REVERT`
 * with the reason named, so the field report says which error to write a screen for.
 */
export const DENY_BY_NAME: Record<string, DenyVerdict> = Object.fromEntries(
  CHECK_IN_ERRORS.map((name): [string, DenyVerdict] => {
    const code = CHECK_IN_DENY[name];
    if (!code) {
      return [name, { code: 'UNKNOWN_REVERT', detail: `${DENY_LABELS.UNKNOWN_REVERT} (${name})` }];
    }
    return [name, { code, detail: DENY_DETAILS[name] ?? DENY_LABELS[code] }];
  }),
);

const TABLE: Record<string, DenyVerdict> = Object.fromEntries(
  CHECK_IN_ERRORS.flatMap((name) => {
    const selector = SELECTOR_BY_NAME.get(name);
    const verdict = DENY_BY_NAME[name];
    // Cannot happen — the names come from the same ABI these selectors do — but the list is
    // derived now, so this is a skipped row rather than a crash at a door.
    if (!selector || !verdict) return [];
    return [[selector, verdict] as const];
  }),
);

/** The selectors this build can name, for the test that checks the set is the ABI's. */
export const MAPPED_SELECTORS: readonly string[] = Object.keys(TABLE);

/**
 * `revertReason` is the reason bytes the bundler returned, or `sendSponsoredOp`'s `'TIMEOUT'`
 * sentinel. **The sentinel must not reach here**: a timed-out op has not failed, it has not
 * landed yet, and Task 23 keeps the gate in `confirming` for exactly that case — a late
 * `CheckedIn` still turns the tap green. It is accepted in the signature only so that a caller
 * that gets it wrong produces `TX_FAILED` rather than a type error at a door.
 */
export function mapRevertToDenyCode(
  revertReason?: Hex | 'TIMEOUT',
  message?: string,
): DenyVerdict {
  if (revertReason && revertReason !== 'TIMEOUT' && revertReason.length >= 10) {
    const hit = TABLE[revertReason.slice(0, 10).toLowerCase()];
    if (hit) return hit;
    // Reason bytes we cannot read: the contracts are ahead of this build. Still a refusal, and
    // the raw selector goes on screen so the field report names the thing Task 34 has to add.
    return {
      code: 'UNKNOWN_REVERT',
      detail: `${DENY_LABELS.UNKNOWN_REVERT} (${revertReason.slice(0, 10)})${message ? ` · ${message}` : ''}`,
    };
  }
  // No reason bytes at all: the op never produced a revert — it was dropped, timed out, or
  // failed at the EntryPoint before the call ran. Different from an unreadable reason.
  return { code: 'TX_FAILED', detail: message ?? 'Unknown cause' };
}

/** The two fields a `CallableError` carries that decide a check-in refusal: the server's own
 *  `details.code`, and its short `message`. Read structurally so a plain object stands in for the
 *  error in a test, and so a rejection from somewhere else falls through to `TX_FAILED`. */
function callableReason(error: unknown): { code?: string; message?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const { message, details } = error as { message?: unknown; details?: unknown };
  const detailCode = typeof details === 'object' && details !== null ? (details as { code?: unknown }).code : undefined;
  return {
    code: typeof detailCode === 'string' && detailCode.length > 0 ? detailCode : undefined,
    message: typeof message === 'string' && message.length > 0 && message !== 'UNKNOWN' ? message : undefined,
  };
}

/**
 * The relayer's refusal, turned into a screen — the callable counterpart to
 * {@link mapRevertToDenyCode}. There are no reason bytes here: the relayer ran the `eth_call`
 * simulation and mapped the contract's revert to a `details.code` before it ever charged gas, so
 * this side reads a name rather than a selector.
 *
 * `details.code` is a DENY code (`GATE_CLOSED`, `EXPIRED_CODE`, …) — the same vocabulary the claim
 * path uses for its own — so it is used as it stands. A contract error **name** (`GateNotOpen`) is
 * accepted too, mapped through {@link DENY_BY_NAME}, so this survives whichever spelling the backend
 * settles on. Anything else is a refusal with no screen (`UNKNOWN_REVERT`), and a rejection that was
 * not a callable failure at all — a dropped connection — is `TX_FAILED`. **Never an admit**, like
 * every path out of this file.
 *
 * `AlreadyCheckedIn` is deliberately absent: the backend answers `confirmed` for it, so it reaches
 * the gate as success, never here. A cross-gate duplicate is refused earlier, by the pending table.
 */
export function mapCallableDeny(error: unknown): DenyVerdict {
  const { code, message } = callableReason(error);
  if (code) {
    if (isGateDenyCode(code)) return { code, detail: DENY_LABELS[code] };
    const byName = DENY_BY_NAME[code];
    if (byName) return byName;
    return { code: 'UNKNOWN_REVERT', detail: `${DENY_LABELS.UNKNOWN_REVERT} (${code})` };
  }
  return { code: 'TX_FAILED', detail: message ?? DENY_LABELS.TX_FAILED };
}
