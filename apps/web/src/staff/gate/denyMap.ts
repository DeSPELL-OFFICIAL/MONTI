// A revert, turned into a sentence a staff member can say out loud.
//
// The map is keyed on `Ticket.sol`'s error NAMES and the selectors are derived from the
// generated ABI — never from a signature string typed here. That is the whole design of this
// file: a selector spelled by hand goes on matching nothing the day sub-plan 01 renames an
// error, and a selector that matches nothing falls through to a generic failure, so the gate
// would quietly start showing the wrong screen instead of failing a test. Here, a rename makes
// `CHECK_IN_ERRORS` disagree with the ABI and `types.test.ts` goes red first.
//
// Nothing in this file can produce an admit. Every path out of `mapRevertToDenyCode` is a DENY
// — including the one for a revert whose selector this build has never seen, because a gate
// that cannot read the reason certainly cannot let someone in on it.
import { toFunctionSelector, type Hex } from 'viem';

import { ticketAbi } from '@monti/shared';

import { CHECK_IN_ERRORS, type CheckInError, type DenyCode } from '../types';

/** The short line the screen shows. One per DENY code, and every one of them reachable. */
export const DENY_LABELS: Record<DenyCode, string> = {
  ALREADY_USED: '이미 입장',
  WRONG_EVENT: '다른 공연 티켓',
  REVOKED: '취소된 티켓',
  EXPIRED_CODE: '시간 초과 · 다시 대세요',
  NO_TICKET: '티켓 없음',
  GATE_CLOSED: '게이트가 닫혀 있음',
  GATE_MISMATCH: '이 단말기의 게이트가 아님',
  EVENT_ENDED: '행사 종료',
  EVENT_CANCELLED: '취소된 공연',
  DEVICE_LOCKED: '기기 잠김',
  DEVICE_MISMATCH: '등록된 기기가 아님',
  TX_FAILED: '전송 실패',
  UNKNOWN_REVERT: '알 수 없는 거절',
};

/**
 * The twelve check-in errors the master plan froze (Task 14), each to the screen it becomes.
 * Keyed by `CheckInError`, so an error added to that list without a screen here does not
 * compile — which is the point: a new revert reason must not be able to arrive as a surprise.
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
  EventNotPublished: 'TX_FAILED',
  EventEnded: 'EVENT_ENDED',
  EventCancelled: 'EVENT_CANCELLED',
};

/**
 * Where the default label is not enough to act on. `EventNotPublished` is the case the whole
 * mechanism exists for: it is not a bad ticket and there is nothing the attendee can do, so the
 * sentence has to point at the person who can fix it. `GateMismatch` likewise — the attendee is
 * fine and the terminal is pointed at the wrong gate.
 */
const DENY_DETAILS: Partial<Record<CheckInError, string>> = {
  EventNotPublished: '아직 공개되지 않은 공연입니다. 주최자에게 문의하세요.',
  GateMismatch: '이 단말기는 다른 게이트로 등록돼 있습니다. 설정을 확인하세요.',
  DeviceLocked: '관객 기기 키가 잠겨 있습니다. 관객에게 앱 재설정을 안내하세요.',
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

const TABLE: Record<string, DenyVerdict> = Object.fromEntries(
  CHECK_IN_ERRORS.flatMap((name) => {
    const selector = SELECTOR_BY_NAME.get(name);
    // A name the ABI no longer declares is a red `types.test.ts`, not a crash at the door.
    if (!selector) return [];
    const code = CHECK_IN_DENY[name];
    return [[selector, { code, detail: DENY_DETAILS[name] ?? DENY_LABELS[code] }] as const];
  }),
);

/** The selectors this build can name, for the test that checks the set is the frozen twelve. */
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
  return { code: 'TX_FAILED', detail: message ?? '원인 미상' };
}
