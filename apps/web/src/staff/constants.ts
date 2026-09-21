// The one place every staff screen reads its parameters from. Nothing under `src/staff/`
// restates a literal from here — a gate that rotates its code at a different cadence than the
// attendee phone expects is a silent no-entry, not a visible bug.
//
// Where a value already exists it is **re-exported, not restated**. `@monti/shared` is the wire
// contract the attendee app, the Kotlin HCE service and the contracts all read; `GATE_KEY_ALIAS`
// belongs to the device-key module that actually creates the key. The aliases below (`MONTI_AID`,
// `NDEF_TYPE_*`) are this sub-plan's names for those same single sources, so a change over there
// lands here without anyone remembering to copy it.
export {
  HCE_AID as MONTI_AID,
  NDEF_GATE_TYPE as NDEF_TYPE_GATE,
  NDEF_RESPONSE_TYPE as NDEF_TYPE_RESPONSE,
  QR_PREFIX,
  GATE_CODE_ROTATE_MS,
  CODE_WINDOW_SECONDS,
  CLOCK_SKEW_SECONDS,
} from '@monti/shared';

/** 게이트 단말기 키. 생체 인증 없이 3초마다 서명해야 하므로 관객 기기 키와 별칭이 다르다. */
export { GATE_KEY_ALIAS } from '../shared/deviceKey/types';

/** How often the gate re-pulls the signed entry snapshot while a door is open. */
export const SNAPSHOT_REFRESH_MS = 600_000;
/**
 * How long a tap may be silent before the gate says "확인 중" (spec §7.3, `gate/machine.ts`).
 * It is a label threshold and never a state change — the operation is alive on both sides of it.
 *
 * It used to be called `CONFIRM_SPINNER_MS` and was documented as the *green hold* while being
 * used as this; the Tasks 19–23 review split the two names apart. The green hold constant went
 * with the Task 24 review: nothing holds a verdict on a timer, because the machine has no
 * transition that clears one — a staff member does, by pressing on.
 */
export const CHECKING_LABEL_MS = 2000;
/** Silence this long after a tap starts is a failed tap: the screen asks for a re-tap. */
export const WAIT_HINT_MS = 5000;

/**
 * How long the gate waits on one check-in before it stops watching the bundler.
 *
 * It is not a deadline for the attendee: a `wait()` that gives up leaves the operation running
 * and the screen `confirming`, and a `CheckedIn` at thirty seconds still turns the tap green
 * (spec §7.3). What it bounds is how long one tap holds the poll loop — past this the chain
 * watch is the cheaper way to hear the same answer.
 */
export const CHECK_IN_WAIT_MS = 20_000;

/**
 * Spec §13: a phone replaced inside this window puts an amber note on the admit card. A
 * handed-over ticket and a genuinely new phone look identical on chain, and the only person who
 * can tell them apart is the one standing in front of the attendee.
 */
export const DEVICE_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How often a running gate re-asks `Organizers.isOpenGate`.
 *
 * Registration is permanent but *permission* is not: an organizer closes a gate when a door
 * shuts, and revokes one when a phone is lost. Neither emits anything this device subscribes to,
 * and a terminal that learned it was open at 19:00 would keep taking taps that can now only
 * revert `GateNotOpen` — one refusal per attendee, each costing a sponsored operation. A minute
 * is short enough that a closed door empties within one queue length and long enough to be one
 * `eth_call` a minute.
 */
export const GATE_OPEN_RECHECK_MS = 60_000;

/**
 * How old this device's remembered `isOpenGate` answer may be and still open a door.
 *
 * The memory exists because a staff APK that cold-starts at a venue with no signal would
 * otherwise never open at all — `gateOpen` stays `undefined` for ever and the screen blocks.
 * But a remembered permission is a permission nobody has re-granted, and the case it gets
 * dangerous is precisely the one it is for: a gate revoked while the phone was offline keeps
 * taking taps, and every tap becomes a durable row that can only ever revert.
 *
 * An hour is a door's worth of memory — long enough that a terminal rebooted between two sets
 * comes back up working, short enough that a revocation cannot outlive one shift block. Past it
 * the answer is thrown away and the screen goes back to blocking, which is the honest state:
 * this device does not know whether it may open.
 */
export const GATE_OPEN_STALE_MS = 60 * 60_000;

/**
 * How often the gate refreshes the three numbers in its header — guest-list age, entries waiting
 * to be sent, entries parked. None of them is a verdict, so they are polled rather than pushed;
 * they are read from IndexedDB, so polling them is free.
 */
export const GATE_STATUS_POLL_MS = 10_000;

/**
 * How often the setup screen asks the chain whether the organizer has registered this device.
 * The answer is a single `eth_call`, and a staff member is standing in front of the phone
 * waiting for it, so it is short — but it is a poll, not a subscription: `Organizers` emits
 * the registration and the gate must work on a network where the socket never connects.
 */
export const GATE_REGISTRATION_POLL_MS = 3000;

/**
 * The event the demo deployment seeded (`contracts/deployments/seed-10143.json`). It is the
 * setup screen's **prefilled value and nothing more** — the field stays editable, because a
 * gate device registered against the wrong event opens a door for the wrong ticket.
 */
export const SEEDED_EVENT_ID = '1' as const;

/**
 * The local PIN that unlocks manual approval (`staff/override/pin.ts`), and the lockout that is
 * the real defence around four digits.
 *
 * Five tries then a minute turns an exhaustive walk of a four-digit PIN from an afternoon into
 * roughly 33 hours at the terminal, which outlasts any event. The iteration count is OWASP's
 * 2023 figure for PBKDF2-SHA-256; on the phones this ships to it costs about 15 ms, which nobody
 * standing at a door notices and which no attacker gets to skip.
 */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 60_000;
export const PIN_PBKDF2_ITERATIONS = 210_000;
export const PIN_SALT_BYTES = 16;

/** The staff device's own IndexedDB — separate from anything the attendee build stores. */
export const STAFF_DB_NAME = 'monti-staff' as const;
export const STAFF_DB_VERSION = 1;
