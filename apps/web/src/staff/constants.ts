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
/** How long the gate holds the green confirmation before it is ready for the next attendee. */
export const CONFIRM_SPINNER_MS = 2000;
/** Silence this long after a tap starts is a failed tap: the screen asks for a re-tap. */
export const RETAP_PROMPT_MS = 5000;

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

/** The staff device's own IndexedDB — separate from anything the attendee build stores. */
export const STAFF_DB_NAME = 'monti-staff' as const;
export const STAFF_DB_VERSION = 1;
